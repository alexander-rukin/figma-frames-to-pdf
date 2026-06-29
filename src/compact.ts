import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// One text run inside a frame, in frame pixel coordinates (top-left origin).
export interface TextItem {
  chars: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

export interface LinkItem {
  url: string;
  x: number; // frame px, top-left origin
  y: number;
  w: number;
  h: number;
}

// A rasterized frame (the exact Figma render) plus its text/link data. We never
// clone or mutate the document — just read text positions — so it stays fast
// and can't hang on large decks.
export interface CompactFrame {
  index: number;
  name: string;
  jpeg: Uint8Array; // baseline JPEG of the WHOLE frame (exact Figma render)
  texts: TextItem[]; // for the invisible selectable text layer
  links?: LinkItem[]; // clickable URL links
  wpt: number; // page size in pt (frame px == pt, 1:1)
  hpt: number;
}

export interface CompactResult {
  bytes: Uint8Array;
  textRuns: number;
  links: number;
}

// Drop control characters that break text placement; keep newlines for wrapping.
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r/g, "").replace(/\t/g, " ").replace(/[\x00-\x09\x0B-\x1F]/g, "");
}

function makeLinkAnnot(doc: PDFDocument, hpt: number, l: LinkItem): PDFRef {
  const action = doc.context.obj({ Type: "Action", S: "URI" }) as PDFDict;
  action.set(PDFName.of("URI"), PDFString.of(l.url));
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [l.x, hpt - (l.y + l.h), l.x + l.w, hpt - l.y], // Figma is top-left; PDF bottom-up
    Border: [0, 0, 0],
  }) as PDFDict;
  annot.set(PDFName.of("A"), action);
  return doc.context.register(annot);
}

/**
 * Compose each page as a compressed raster of the frame (so heavy vector
 * graphics and full-res images collapse to a small, display-resolution image)
 * with an INVISIBLE but selectable/searchable text layer on top, and clickable
 * link annotations.
 *
 * The visible page is exactly Figma's render — nothing shifts. The overlaid
 * text is drawn at opacity 0 purely so copy / Cmd-F / selection work; its font
 * is never displayed, so it cannot affect the design. The copied/searched
 * characters are the real ones from Figma.
 */
export async function buildCompactPdf(
  frames: CompactFrame[],
  fontBytes: Uint8Array
): Promise<CompactResult> {
  const doc = await PDFDocument.create();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc.registerFontkit(fontkit as any);
  const font = await doc.embedFont(fontBytes, { subset: true });

  let textRuns = 0;
  let links = 0;

  const ordered = [...frames].sort((a, b) => a.index - b.index);
  for (const f of ordered) {
    const page = doc.addPage([f.wpt, f.hpt]);

    try {
      const jpg = await doc.embedJpg(f.jpeg);
      page.drawImage(jpg, { x: 0, y: 0, width: f.wpt, height: f.hpt });
    } catch {
      // If the raster can't embed, the text layer below still gets added.
    }

    for (const t of f.texts) {
      const txt = clean(t.chars);
      if (!txt.trim()) continue;
      try {
        page.drawText(txt, {
          x: t.x,
          y: f.hpt - t.y - t.size, // flip to PDF's bottom-up Y, approx baseline
          size: t.size,
          font,
          maxWidth: t.w > 0 ? t.w : undefined,
          lineHeight: t.size * 1.2,
          opacity: 0, // invisible — selectable only; the raster is what shows
        });
        textRuns++;
      } catch {
        // A glyph the font can't encode (emoji, CJK) — skip this run only.
      }
    }

    if (f.links && f.links.length > 0) {
      const refs = f.links.map((l) => makeLinkAnnot(doc, f.hpt, l));
      const annots = PDFArray.withContext(doc.context);
      for (const ref of refs) annots.push(ref);
      page.node.set(PDFName.of("Annots"), annots);
      links += refs.length;
    }
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, textRuns, links };
}
