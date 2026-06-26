import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFStream,
  PDFRawStream,
  PDFObject,
} from "pdf-lib";
import { inflate, deflate } from "pako";

// ---------------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------------
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reference rewriting
// ---------------------------------------------------------------------------

// Order-independent signature of a dict/array. References are included as-is,
// so two streams only match once their referenced sub-objects have themselves
// been collapsed to the same canonical refs (that's why dedup iterates).
function objSignature(obj: PDFObject): string {
  if (obj instanceof PDFRef) return `R${obj.objectNumber}.${obj.generationNumber}`;
  if (obj instanceof PDFName) return obj.asString();
  if (obj instanceof PDFArray) {
    const parts: string[] = [];
    for (let i = 0; i < obj.size(); i++) parts.push(objSignature(obj.get(i)));
    return `[${parts.join(" ")}]`;
  }
  if (obj instanceof PDFDict) {
    const entries = obj
      .entries()
      .map(([k, v]) => `${k.asString()}=${objSignature(v)}`)
      .sort();
    return `<<${entries.join(" ")}>>`;
  }
  return obj.toString(); // numbers, booleans, strings, null
}

// Rewrite every PDFRef found inside a dict/array according to `remap`.
function rewriteRefs(container: PDFObject, remap: Map<string, PDFRef>): void {
  if (container instanceof PDFDict) {
    for (const [key, value] of container.entries()) {
      if (value instanceof PDFRef) {
        const canon = remap.get(value.toString());
        if (canon) container.set(key, canon);
      } else if (value instanceof PDFDict || value instanceof PDFArray) {
        rewriteRefs(value, remap);
      }
    }
  } else if (container instanceof PDFArray) {
    for (let i = 0; i < container.size(); i++) {
      const value = container.get(i);
      if (value instanceof PDFRef) {
        const canon = remap.get(value.toString());
        if (canon) container.set(i, canon);
      } else if (value instanceof PDFDict || value instanceof PDFArray) {
        rewriteRefs(value, remap);
      }
    }
  }
}

// One de-duplication pass. Returns bytes removed in this pass.
function dedupePass(pdfDoc: PDFDocument): number {
  const context = pdfDoc.context;
  const objects = context.enumerateIndirectObjects();

  const buckets = new Map<string, Array<{ ref: PDFRef; stream: PDFRawStream }>>();
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    const contents = obj.getContents();
    const key = `${objSignature(obj.dict)}#${contents.length}#${fnv1a(contents)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ ref, stream: obj });
    else buckets.set(key, [{ ref, stream: obj }]);
  }

  const remap = new Map<string, PDFRef>();
  const toDelete: Array<{ ref: PDFRef; size: number }> = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const canonical = bucket[0];
    const canonBytes = canonical.stream.getContents();
    for (let i = 1; i < bucket.length; i++) {
      const dup = bucket[i];
      // Exact byte check guards against hash collisions.
      if (!bytesEqual(canonBytes, dup.stream.getContents())) continue;
      remap.set(dup.ref.toString(), canonical.ref);
      toDelete.push({ ref: dup.ref, size: dup.stream.getContents().length });
    }
  }

  if (remap.size === 0) return 0;

  // Repoint every reference in the document to the canonical objects.
  for (const [, obj] of objects) {
    const container = obj instanceof PDFStream ? obj.dict : obj;
    rewriteRefs(container, remap);
  }

  let saved = 0;
  for (const { ref, size } of toDelete) {
    context.delete(ref);
    saved += size;
  }
  return saved;
}

/**
 * De-duplicate identical embedded streams (font programs, repeated images and
 * their masks/ICC profiles, identical page content). Returns total bytes removed.
 *
 * When frames are merged, each page carries its own copy of every shared
 * resource — the same background photo or logo repeated on every slide is the
 * usual reason a merged PDF balloons far past Figma's native export. This runs
 * to a fixed point: leaf streams (alpha masks, colour profiles) collapse first,
 * which lets the images that reference them collapse on the next pass.
 */
export function dedupeStreams(pdfDoc: PDFDocument): number {
  let total = 0;
  let removed: number;
  do {
    removed = dedupePass(pdfDoc);
    total += removed;
  } while (removed > 0);
  return total;
}

// ---------------------------------------------------------------------------
// Image downsampling
// ---------------------------------------------------------------------------

export interface ImageQuality {
  maxDim: number; // longest edge in pixels; 0 = leave images untouched
  quality: number; // JPEG quality 0..1
}

const N = (n: string) => PDFName.of(n);

// Returns the name without its leading slash, e.g. "/Image" -> "Image".
function nameValue(dict: PDFDict, key: string): string | undefined {
  const v = dict.get(N(key));
  return v instanceof PDFName ? v.asString().replace(/^\//, "") : undefined;
}

function numValue(dict: PDFDict, key: string): number | undefined {
  const v = dict.get(N(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

// Figma writes the image filter as an ARRAY (e.g. `[/DCTDecode]`), not a bare
// name — so a naive `Filter === DCTDecode` check misses every image. Returns
// the raw JPEG bytes when the stream decodes directly to JPEG, else null.
// (`[/FlateDecode /DCTDecode]` would need an inflate first and is skipped.)
function jpegContents(obj: PDFRawStream): Uint8Array | null {
  const f = obj.dict.get(N("Filter"));
  if (f instanceof PDFName) {
    return f.asString() === "/DCTDecode" ? obj.getContents() : null;
  }
  if (f instanceof PDFArray && f.size() === 1) {
    const only = f.get(0);
    if (only instanceof PDFName && only.asString() === "/DCTDecode") {
      return obj.getContents();
    }
  }
  return null;
}

async function reencodeJpeg(
  bytes: Uint8Array,
  maxDim: number,
  quality: number
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  const blob = new Blob([bytes as BlobPart], { type: "image/jpeg" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null; // not a decodable baseline JPEG — leave it alone
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const outBlob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
  if (!outBlob) return null;
  const data = new Uint8Array(await outBlob.arrayBuffer());
  return { data, width: w, height: h };
}

export interface ImageStats {
  saved: number; // bytes removed
  jpegs: number; // plain JPEG images considered
  recompressed: number; // actually replaced (smaller)
  notSmaller: number; // re-encoded but not smaller -> kept original
  failed: number; // createImageBitmap/canvas failed
}

/**
 * Re-encode large JPEG (DCTDecode) images at a capped resolution/quality.
 * The base colour data is re-encoded as RGB JPEG; an existing soft mask
 * (`SMask`) is preserved as-is (PDF maps it onto the image's unit square, so the
 * mask need not match the new pixel size). Only swaps an image in when the
 * result is actually smaller. Returns detailed stats for diagnostics.
 */
export async function downsampleImages(
  pdfDoc: PDFDocument,
  opts: ImageQuality
): Promise<ImageStats> {
  const stats: ImageStats = { saved: 0, jpegs: 0, recompressed: 0, notSmaller: 0, failed: 0 };
  if (!opts.maxDim) return stats;
  const context = pdfDoc.context;

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (nameValue(dict, "Subtype") !== "Image") continue;
    if (dict.get(N("ImageMask"))) continue;

    const original = jpegContents(obj); // null unless it's a plain JPEG
    if (!original) continue;

    const width = numValue(dict, "Width");
    const height = numValue(dict, "Height");
    if (!width || !height) continue;

    stats.jpegs++;
    const result = await reencodeJpeg(original, opts.maxDim, opts.quality);
    if (!result) {
      stats.failed++;
      continue;
    }
    if (result.data.length >= original.length) {
      stats.notSmaller++;
      continue;
    }

    const newDict = context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: result.width,
      Height: result.height,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "DCTDecode",
      Length: result.data.length,
    }) as PDFDict;

    // Preserve transparency and any explicit intent.
    const smask = dict.get(N("SMask"));
    if (smask) newDict.set(N("SMask"), smask);
    const intent = dict.get(N("Intent"));
    if (intent) newDict.set(N("Intent"), intent);

    context.assign(ref, PDFRawStream.of(newDict, result.data));
    stats.saved += original.length - result.data.length;
    stats.recompressed++;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Re-deflate Flate streams at max compression (lossless)
// ---------------------------------------------------------------------------

/**
 * Recompress every single-filter FlateDecode stream (vector content, forms,
 * lossless images) at zlib level 9. Figma's exporter deflates at a lower level,
 * so this is a safe, lossless win on the bulky vector half of the document.
 * The decoded bytes are preserved exactly, so any DecodeParms predictor still
 * applies. Returns the number of bytes removed.
 */
export function recompressFlate(pdfDoc: PDFDocument): number {
  const context = pdfDoc.context;
  let saved = 0;

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(N("Filter"));
    if (!(filter instanceof PDFName) || filter.asString() !== "/FlateDecode") {
      continue; // only plain single-filter Flate streams
    }
    const current = obj.getContents();
    let repacked: Uint8Array;
    try {
      repacked = deflate(inflate(current), { level: 9 });
    } catch {
      continue; // not standard zlib — leave it alone
    }
    if (repacked.length >= current.length) continue;

    obj.dict.set(N("Length"), PDFNumber.of(repacked.length));
    context.assign(ref, PDFRawStream.of(obj.dict, repacked));
    saved += current.length - repacked.length;
  }
  return saved;
}
