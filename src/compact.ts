import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef } from "pdf-lib";

export interface LinkItem {
  url: string;
  x: number; // frame px, top-left origin
  y: number;
  w: number;
  h: number;
}

// A rasterized frame (pixel-perfect render) plus Figma's own text layer,
// exported as a separate text-only PDF so we never touch or substitute fonts.
export interface CompactFrame {
  index: number;
  name: string;
  jpeg: Uint8Array; // baseline JPEG of the WHOLE frame (exact Figma render)
  textPdf?: Uint8Array; // text-only PDF from Figma (native Type 3 text), optional
  links?: LinkItem[]; // clickable URL links
  wpt: number; // page size in pt (frame px == pt, 1:1)
  hpt: number;
}

export interface CompactResult {
  bytes: Uint8Array;
  textPages: number; // pages that got a selectable text layer
  links: number; // clickable link annotations added
}

/**
 * Compose each page as: a compressed raster of the frame (so heavy vector
 * graphics and full-res images collapse to a small, display-resolution image)
 * with Figma's OWN text drawn on top as an invisible-but-selectable overlay.
 *
 * The visible design is the raster — exactly what Figma rendered, so nothing
 * shifts. The text layer is Figma's native text (its real fonts, Type 3), drawn
 * at opacity 0: copy / Cmd-F / selection work, no font substitution, no drift.
 */
// Build a clickable URL Link annotation (drawPage/embed don't carry annotations,
// so we recreate them from the links Figma gave us).
function makeLinkAnnot(doc: PDFDocument, hpt: number, l: LinkItem): PDFRef {
  const action = doc.context.obj({ Type: "Action", S: "URI" }) as PDFDict;
  action.set(PDFName.of("URI"), PDFString.of(l.url));

  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    // Figma is top-left origin; PDF is bottom-up.
    Rect: [l.x, hpt - (l.y + l.h), l.x + l.w, hpt - l.y],
    Border: [0, 0, 0],
  }) as PDFDict;
  annot.set(PDFName.of("A"), action);
  return doc.context.register(annot);
}

export async function buildCompactPdf(frames: CompactFrame[]): Promise<CompactResult> {
  const doc = await PDFDocument.create();
  let textPages = 0;
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

    if (f.textPdf && f.textPdf.length > 0) {
      try {
        const [textLayer] = await doc.embedPdf(f.textPdf, [0]);
        page.drawPage(textLayer, {
          x: 0,
          y: 0,
          width: f.wpt,
          height: f.hpt,
          opacity: 0, // invisible overlay — selectable, but the raster is what shows
        });
        textPages++;
      } catch {
        // No text layer for this page if Figma's text-only export fails.
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
  return { bytes, textPages, links };
}
