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

  let exported = 0;
  for (let i = 0; i < ids.length; i++) {
    const node = (await figma.getNodeByIdAsync(ids[i])) as SceneNode | null;
    if (!node || typeof (node as ExportMixin).exportAsync !== "function") {
      continue; // frame was deleted between listing and export
    }
    try {
      const bytes = await (node as ExportMixin).exportAsync({ format: "PDF" });
      figma.ui.postMessage({
        type: "frame-exported",
        index: exported,
        name: node.name,
        bytes,
      });
      exported++;
    } catch (err) {
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

// --- Compact mode: rasterize each frame, keep Figma's own text as an overlay --

// Strip a CLONE down to just its text: remove every node that contains no text,
// and clear container paint so the text-only render has a transparent backdrop.
// Returns true if any text remained. (Operates on a disposable clone only.)
function stripToTextOnly(node: SceneNode): boolean {
  if (node.type === "TEXT") return true;
  if (!("children" in node)) return false;

  let kept = false;
  for (const child of [...(node as ChildrenMixin).children]) {
    if (stripToTextOnly(child as SceneNode)) kept = true;
    else (child as SceneNode).remove();
  }

  // Clear this container's own paint so only the glyphs show through.
  const paintable = node as unknown as {
    fills?: unknown;
    strokes?: unknown;
    effects?: unknown;
  };
  try {
    if ("fills" in paintable) paintable.fills = [];
  } catch {
    /* some nodes have non-writable fills */
  }
  try {
    if ("strokes" in paintable) paintable.strokes = [];
  } catch {
    /* ignore */
  }
  try {
    if ("effects" in paintable) paintable.effects = [];
  } catch {
    /* ignore */
  }
  return kept;
}

// Export a text-only PDF of the frame using Figma's native text (no font
// substitution). Done on a clone so the user's document is never modified.
interface LinkItem {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
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

async function exportTextOnlyPdf(node: SceneNode): Promise<Uint8Array | undefined> {
  if (typeof (node as { clone?: unknown }).clone !== "function") return undefined;
  const clone = (node as FrameNode).clone() as SceneNode;
  try {
    // Move off-canvas so it doesn't flash over the original during export.
    if ("x" in clone) (clone as LayoutMixin).x += 100000;
    const hasText = stripToTextOnly(clone);
    if (!hasText) return undefined;
    return await (clone as ExportMixin).exportAsync({ format: "PDF" });
  } catch {
    return undefined;
  } finally {
    clone.remove();
  }
}

async function runCompactExport(ids: string[], scale: number): Promise<void> {
  if (ids.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No frames selected for export." });
    return;
  }

  figma.ui.postMessage({ type: "frame-count", count: ids.length });

  let exported = 0;
  for (let i = 0; i < ids.length; i++) {
    const node = (await figma.getNodeByIdAsync(ids[i])) as SceneNode | null;
    if (!node || typeof (node as ExportMixin).exportAsync !== "function") continue;
    const box = node.absoluteBoundingBox;
    if (!box) continue;

    try {
      // Pixel-perfect raster of the WHOLE frame (exact Figma render).
      const jpeg = await (node as ExportMixin).exportAsync({
        format: "JPG",
        constraint: { type: "SCALE", value: scale },
      });
      // Figma's own text, on a transparent backdrop, for the selectable overlay.
      const textPdf = await exportTextOnlyPdf(node);

      figma.ui.postMessage({
        type: "frame-compact",
        index: exported,
        name: node.name,
        jpeg,
        textPdf,
        links: collectLinks(node),
        wpt: Math.round(box.width),
        hpt: Math.round(box.height),
      });
      exported++;
    } catch (err) {
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
