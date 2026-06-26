"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };

  // src/code.ts
  var EXPORTABLE_TYPES = /* @__PURE__ */ new Set([
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "SECTION",
    "GROUP"
  ]);
  figma.showUI(__html__, { width: 360, height: 600, themeColors: true });
  var lastSort = "position";
  function isExportable(node) {
    return EXPORTABLE_TYPES.has(node.type);
  }
  var ROW_TOLERANCE = 12;
  function byPosition(a, b) {
    const dy = a.y - b.y;
    if (Math.abs(dy) > ROW_TOLERANCE) return dy;
    return a.x - b.x;
  }
  function selectedExportable() {
    return figma.currentPage.selection.filter(isExportable);
  }
  function candidates(sortMode) {
    const selection = selectedExportable();
    if (selection.length > 0) {
      const frames = [...selection];
      if (sortMode === "position") frames.sort(byPosition);
      return frames;
    }
    return figma.currentPage.children.filter(isExportable).sort(byPosition);
  }
  async function postFrameList() {
    const frames = candidates(lastSort);
    figma.ui.postMessage({
      type: "frame-list",
      hasSelection: selectedExportable().length > 0,
      frames: frames.map((f) => ({
        id: f.id,
        name: f.name,
        width: Math.round(f.width),
        height: Math.round(f.height)
      }))
    });
    for (const frame of frames) {
      try {
        const thumb = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "WIDTH", value: 160 }
        });
        figma.ui.postMessage({ type: "thumb", id: frame.id, bytes: thumb });
      } catch (e) {
      }
    }
  }
  async function runExport(ids) {
    if (ids.length === 0) {
      figma.ui.postMessage({
        type: "export-error",
        message: "No frames selected for export."
      });
      return;
    }
    figma.ui.postMessage({ type: "frame-count", count: ids.length });
    let exported = 0;
    for (let i = 0; i < ids.length; i++) {
      const node = await figma.getNodeByIdAsync(ids[i]);
      if (!node || typeof node.exportAsync !== "function") {
        continue;
      }
      try {
        const bytes = await node.exportAsync({ format: "PDF" });
        figma.ui.postMessage({
          type: "frame-exported",
          index: exported,
          name: node.name,
          bytes
        });
        exported++;
      } catch (err) {
        figma.ui.postMessage({
          type: "export-error",
          message: `Failed to export "${node.name}": ${String(err)}`
        });
        return;
      }
    }
    if (exported === 0) {
      figma.ui.postMessage({
        type: "export-error",
        message: "Nothing could be exported (frames may have been deleted)."
      });
      return;
    }
    figma.ui.postMessage({ type: "export-done", count: exported });
  }
  function stripToTextOnly(node) {
    if (node.type === "TEXT") return true;
    if (!("children" in node)) return false;
    let kept = false;
    for (const child of [...node.children]) {
      if (stripToTextOnly(child)) kept = true;
      else child.remove();
    }
    const paintable = node;
    try {
      if ("fills" in paintable) paintable.fills = [];
    } catch (e) {
    }
    try {
      if ("strokes" in paintable) paintable.strokes = [];
    } catch (e) {
    }
    try {
      if ("effects" in paintable) paintable.effects = [];
    } catch (e) {
    }
    return kept;
  }
  function collectLinks(node) {
    const box = node.absoluteBoundingBox;
    const out = [];
    if (!box) return out;
    const nodes = "findAll" in node ? [node, ...node.findAll(() => true)] : [node];
    for (const n of nodes) {
      if (!n.visible) continue;
      const b = n.absoluteBoundingBox;
      if (!b) continue;
      const rect = { x: b.x - box.x, y: b.y - box.y, w: b.width, h: b.height };
      const reactions = n.reactions;
      if (reactions) {
        for (const r of reactions) {
          const actions = r.actions || (r.action ? [r.action] : []);
          for (const a of actions) {
            if (a && a.type === "URL" && a.url) out.push(__spreadValues({ url: a.url }, rect));
          }
        }
      }
      if (n.type === "TEXT") {
        try {
          const segs = n.getStyledTextSegments(["hyperlink"]);
          const urls = /* @__PURE__ */ new Set();
          for (const s of segs) {
            const h = s.hyperlink;
            if (h && h.type === "URL" && h.value) urls.add(h.value);
          }
          for (const url of urls) out.push(__spreadValues({ url }, rect));
        } catch (e) {
        }
      }
    }
    return out;
  }
  async function exportTextOnlyPdf(node) {
    if (typeof node.clone !== "function") return void 0;
    const clone = node.clone();
    try {
      if ("x" in clone) clone.x += 1e5;
      const hasText = stripToTextOnly(clone);
      if (!hasText) return void 0;
      return await clone.exportAsync({ format: "PDF" });
    } catch (e) {
      return void 0;
    } finally {
      clone.remove();
    }
  }
  async function runCompactExport(ids, scale) {
    if (ids.length === 0) {
      figma.ui.postMessage({ type: "export-error", message: "No frames selected for export." });
      return;
    }
    figma.ui.postMessage({ type: "frame-count", count: ids.length });
    let exported = 0;
    for (let i = 0; i < ids.length; i++) {
      const node = await figma.getNodeByIdAsync(ids[i]);
      if (!node || typeof node.exportAsync !== "function") continue;
      const box = node.absoluteBoundingBox;
      if (!box) continue;
      try {
        const jpeg = await node.exportAsync({
          format: "JPG",
          constraint: { type: "SCALE", value: scale }
        });
        const textPdf = await exportTextOnlyPdf(node);
        figma.ui.postMessage({
          type: "frame-compact",
          index: exported,
          name: node.name,
          jpeg,
          textPdf,
          links: collectLinks(node),
          wpt: Math.round(box.width),
          hpt: Math.round(box.height)
        });
        exported++;
      } catch (err) {
        figma.ui.postMessage({
          type: "export-error",
          message: `Failed to export "${node.name}": ${String(err)}`
        });
        return;
      }
    }
    if (exported === 0) {
      figma.ui.postMessage({
        type: "export-error",
        message: "Nothing could be exported (frames may have been deleted)."
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
        lastSort = msg.sortMode;
        void postFrameList();
        break;
      case "start-export":
        if (msg.mode === "compact") {
          void runCompactExport(msg.ids, msg.scale || 1.5);
        } else {
          void runExport(msg.ids);
        }
        break;
      case "cancel":
        figma.closePlugin();
        break;
    }
  };
})();
