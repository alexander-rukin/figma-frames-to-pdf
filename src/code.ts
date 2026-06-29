/// <reference types="@figma/plugin-typings" />

// Node types we treat as "exportable pages".
const EXPORTABLE_TYPES = new Set<string>([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
  "GROUP",
]);

type SortMode = "position" | "selection";

figma.showUI(__html__, { width: 360, height: 600, themeColors: true });

let lastSort: SortMode = "position";

// Send a log line to the UI's log panel and the dev console. A "→ start" line
// before each frame and a "✓ done" line after means the LAST line on a hang
// pinpoints exactly which frame and step stalled.
function log(text: string): void {
  // eslint-disable-next-line no-console
  console.log("[Frames→PDF]", text);
  figma.ui.postMessage({ type: "log", text });
}

function isExportable(node: SceneNode): boolean {
  return EXPORTABLE_TYPES.has(node.type);
}

// Reading order: top-to-bottom, then left-to-right, with a row tolerance so a
// horizontal row of frames keeps its left-to-right order.
const ROW_TOLERANCE = 12;
function byPosition(a: SceneNode, b: SceneNode): number {
  const dy = a.y - b.y;
  if (Math.abs(dy) > ROW_TOLERANCE) return dy;
  return a.x - b.x;
}

function selectedExportable(): SceneNode[] {
  return figma.currentPage.selection.filter(isExportable);
}

function candidates(sortMode: SortMode): SceneNode[] {
  const selection = selectedExportable();
  if (selection.length > 0) {
    const frames = [...selection];
    if (sortMode === "position") frames.sort(byPosition);
    return frames;
  }
  // Nothing selected -> every top-level frame on the page, in reading order.
  return figma.currentPage.children.filter(isExportable).sort(byPosition);
}

// Send the candidate list, then stream thumbnails in (so the list shows fast).
async function postFrameList(): Promise<void> {
  const frames = candidates(lastSort);
  figma.ui.postMessage({
    type: "frame-list",
    hasSelection: selectedExportable().length > 0,
    frames: frames.map((f) => ({
      id: f.id,
      name: f.name,
      width: Math.round(f.width),
      height: Math.round(f.height),
    })),
  });

  for (const frame of frames) {
    try {
      const thumb = await frame.exportAsync({
        format: "PNG",
        constraint: { type: "WIDTH", value: 160 },
      });
      figma.ui.postMessage({ type: "thumb", id: frame.id, bytes: thumb });
    } catch {
      // A frame that can't be rasterized just gets no thumbnail.
    }
  }
}

async function runExport(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    figma.ui.postMessage({
      type: "export-error",
      message: "No frames selected for export.",
    });
    return;
  }

  figma.ui.postMessage({ type: "frame-count", count: ids.length });
  log(`Vector export started — ${ids.length} frame(s)`);

  let exported = 0;
  for (let i = 0; i < ids.length; i++) {
    const node = (await figma.getNodeByIdAsync(ids[i])) as SceneNode | null;
    if (!node || typeof (node as ExportMixin).exportAsync !== "function") {
      continue; // frame was deleted between listing and export
    }
    const pos = `${i + 1}/${ids.length}`;
    log(`→ [${pos}] ${node.name} — exporting PDF…`);
    try {
      const tf = Date.now();
      const bytes = await (node as ExportMixin).exportAsync({ format: "PDF" });
      figma.ui.postMessage({
        type: "frame-exported",
        index: exported,
        name: node.name,
        bytes,
      });
      exported++;
      log(`✓ [${pos}] ${node.name} — ${Date.now() - tf}ms · ${Math.round(bytes.length / 1024)}KB`);
    } catch (err) {
      log(`✗ [${pos}] ${node.name} — FAILED: ${String(err)}`);
      figma.ui.postMessage({
        type: "export-error",
        message: `Failed to export "${node.name}": ${String(err)}`,
      });
      return;
    }
  }

  if (exported === 0) {
    figma.ui.postMessage({
      type: "export-error",
      message: "Nothing could be exported (frames may have been deleted).",
    });
    return;
  }

  figma.ui.postMessage({ type: "export-done", count: exported });
}

// --- Compact mode: rasterize each frame + read its text/link data (no cloning) --

interface TextItem {
  chars: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

interface LinkItem {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Collect text runs (for the invisible selectable overlay), in frame px coords.
function collectTexts(node: SceneNode): TextItem[] {
  const box = node.absoluteBoundingBox;
  const out: TextItem[] = [];
  if (!box || !("findAll" in node)) return out;

  const textNodes = (node as ChildrenMixin & SceneNode).findAll(
    (n) => n.type === "TEXT"
  ) as TextNode[];

  for (const t of textNodes) {
    if (!t.visible) continue;
    const b = t.absoluteBoundingBox;
    if (!b) continue;
    const size = typeof t.fontSize === "number" ? t.fontSize : Math.min(b.height, 16);
    out.push({
      chars: t.characters,
      x: b.x - box.x,
      y: b.y - box.y,
      w: b.width,
      h: b.height,
      size,
    });
  }
  return out;
}

// Collect clickable links inside a frame, in frame pixel coords (top-left):
// both text hyperlinks and prototype "open URL" reactions (icons, logos, buttons).
function collectLinks(node: SceneNode): LinkItem[] {
  const box = node.absoluteBoundingBox;
  const out: LinkItem[] = [];
  if (!box) return out;

  const nodes: SceneNode[] =
    "findAll" in node
      ? [node, ...(node as ChildrenMixin & SceneNode).findAll(() => true)]
      : [node];

  for (const n of nodes) {
    if (!n.visible) continue;
    const b = n.absoluteBoundingBox;
    if (!b) continue;
    const rect = { x: b.x - box.x, y: b.y - box.y, w: b.width, h: b.height };

    // Prototype reactions that open a URL.
    const reactions = (n as Partial<ReactionMixin>).reactions;
    if (reactions) {
      for (const r of reactions) {
        const actions = r.actions || (r.action ? [r.action] : []);
        for (const a of actions) {
          if (a && a.type === "URL" && a.url) out.push({ url: a.url, ...rect });
        }
      }
    }

    // Text hyperlinks.
    if (n.type === "TEXT") {
      try {
        const segs = n.getStyledTextSegments(["hyperlink"]);
        const urls = new Set<string>();
        for (const s of segs) {
          const h = s.hyperlink;
          if (h && h.type === "URL" && h.value) urls.add(h.value);
        }
        for (const url of urls) out.push({ url, ...rect });
      } catch {
        /* mixed/unsupported text — skip */
      }
    }
  }
  return out;
}

async function runCompactExport(ids: string[], scale: number): Promise<void> {
  if (ids.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No frames selected for export." });
    return;
  }

  figma.ui.postMessage({ type: "frame-count", count: ids.length });
  log(`Compact export started — ${ids.length} frame(s) at ${scale}× raster`);
  const t0 = Date.now();

  let exported = 0;
  for (let i = 0; i < ids.length; i++) {
    const node = (await figma.getNodeByIdAsync(ids[i])) as SceneNode | null;
    if (!node || typeof (node as ExportMixin).exportAsync !== "function") continue;
    const box = node.absoluteBoundingBox;
    if (!box) continue;

    const pos = `${i + 1}/${ids.length}`;
    log(`→ [${pos}] ${node.name} — rendering…`);
    try {
      const tf = Date.now();
      // Pixel-perfect raster of the WHOLE frame (exact Figma render).
      const jpeg = await (node as ExportMixin).exportAsync({
        format: "JPG",
        constraint: { type: "SCALE", value: scale },
      });
      const tRaster = Date.now() - tf;
      const texts = collectTexts(node);
      const links = collectLinks(node);
      figma.ui.postMessage({
        type: "frame-compact",
        index: exported,
        name: node.name,
        jpeg,
        texts,
        links,
        wpt: Math.round(box.width),
        hpt: Math.round(box.height),
      });
      exported++;
      log(
        `✓ [${pos}] ${node.name} — ${Date.now() - tf}ms ` +
          `(raster ${tRaster}ms, ${Math.round(jpeg.length / 1024)}KB) · ` +
          `${texts.length} texts · ${links.length} links`
      );
    } catch (err) {
      log(`✗ [${pos}] ${node.name} — FAILED: ${String(err)}`);
      figma.ui.postMessage({
        type: "export-error",
        message: `Failed to export "${node.name}": ${String(err)}`,
      });
      return;
    }
  }

  log(`Figma export finished — ${exported} frame(s) in ${Date.now() - t0}ms`);

  if (exported === 0) {
    figma.ui.postMessage({
      type: "export-error",
      message: "Nothing could be exported (frames may have been deleted).",
    });
    return;
  }

  figma.ui.postMessage({ type: "export-done", count: exported });
}

figma.on("selectionchange", () => {
  void postFrameList();
});
figma.on("currentpagechange", () => {
  void postFrameList();
});

figma.ui.onmessage = (msg) => {
  switch (msg.type) {
    case "init":
      void postFrameList();
      break;
    case "set-sort":
      lastSort = msg.sortMode as SortMode;
      void postFrameList();
      break;
    case "start-export":
      if (msg.mode === "compact") {
        void runCompactExport(msg.ids as string[], (msg.scale as number) || 1.5);
      } else {
        void runExport(msg.ids as string[]);
      }
      break;
    case "cancel":
      figma.closePlugin();
      break;
  }
};
