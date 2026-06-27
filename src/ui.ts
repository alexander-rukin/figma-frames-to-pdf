import { PDFDocument } from "pdf-lib";
import {
  dedupeStreams,
  downsampleImages,
  recompressFlate,
  ImageQuality,
} from "./optimize";
import { buildCompactPdf, CompactFrame } from "./compact";

const IMAGE_PRESETS: Record<string, ImageQuality> = {
  original: { maxDim: 0, quality: 1 },
  high: { maxDim: 2400, quality: 0.85 },
  medium: { maxDim: 1600, quality: 0.8 },
  low: { maxDim: 1200, quality: 0.75 },
};

// ---- types ------------------------------------------------------------------
interface FrameItem {
  id: string;
  name: string;
  width: number;
  height: number;
  include: boolean;
  thumbUrl?: string;
}

interface ExportedFrame {
  index: number;
  name: string;
  bytes: Uint8Array;
}

type Mode = "vector" | "compact";

// ---- DOM refs ---------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const listEl = $<HTMLDivElement>("list");
const countEl = $<HTMLSpanElement>("count");
const sortSelect = $<HTMLSelectElement>("sort");
const exportBtn = $<HTMLButtonElement>("export");
const filenameInput = $<HTMLInputElement>("filename");
const imageSelect = $<HTMLSelectElement>("image-quality");
const customWrap = $<HTMLDivElement>("custom");
const maxDimInput = $<HTMLInputElement>("max-dim");
const qualityInput = $<HTMLInputElement>("quality");
const qualityVal = $<HTMLSpanElement>("quality-val");
const dedupeCheckbox = $<HTMLInputElement>("dedupe");
const modeSelect = $<HTMLSelectElement>("mode");
const vectorOpts = $<HTMLDivElement>("vector-opts");
const compactOpts = $<HTMLDivElement>("compact-opts");
const rasterScaleSelect = $<HTMLSelectElement>("raster-scale");
const compactQuality = $<HTMLInputElement>("compact-quality");
const compactQualityVal = $<HTMLSpanElement>("compact-quality-val");
const statusEl = $<HTMLDivElement>("status");
const progressWrap = $<HTMLDivElement>("progress-wrap");
const progressBar = $<HTMLDivElement>("progress-bar");

// ---- state ------------------------------------------------------------------
let frames: FrameItem[] = [];
let collected: ExportedFrame[] = [];
let compactFrames: CompactFrame[] = [];
let expectedCount = 0;
let busy = false;
let activeMode: Mode = "compact";

// ---- helpers ----------------------------------------------------------------
function setBusy(value: boolean) {
  busy = value;
  exportBtn.disabled = value;
}

function setStatus(text: string, kind: "info" | "error" | "success" = "info") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function setProgress(done: number, total: number) {
  progressWrap.style.display = total > 0 ? "block" : "none";
  progressBar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

function fmtBytes(n: number): string {
  const kb = n / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function includedCount(): number {
  return frames.filter((f) => f.include).length;
}

function updateExportLabel() {
  const n = includedCount();
  exportBtn.textContent = busy ? "Exporting…" : `Export ${n} frame${n === 1 ? "" : "s"} to PDF`;
  countEl.textContent =
    frames.length === 0
      ? "No frames found"
      : `${n} of ${frames.length} selected`;
}

function imagePreset(): ImageQuality {
  if (imageSelect.value === "custom") {
    return {
      maxDim: Math.max(0, parseInt(maxDimInput.value, 10) || 0),
      quality: Math.min(1, Math.max(0.1, (parseInt(qualityInput.value, 10) || 80) / 100)),
    };
  }
  return IMAGE_PRESETS[imageSelect.value] || IMAGE_PRESETS.high;
}

function safeFilename(raw: string): string {
  const trimmed = (raw || "").trim() || "export";
  const cleaned = trimmed.replace(/[\\/:*?"<>|]+/g, "_");
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

// ---- list rendering & drag reorder -----------------------------------------
function render() {
  if (frames.length === 0) {
    listEl.innerHTML = `<div class="empty">Select frames on the canvas,<br/>or open a page that has frames.</div>`;
    updateExportLabel();
    return;
  }

  listEl.innerHTML = "";
  frames.forEach((f, idx) => {
    const item = document.createElement("div");
    item.className = "item" + (f.include ? "" : " excluded");
    item.draggable = true;
    item.dataset.id = f.id;
    item.innerHTML = `
      <span class="handle">⠿</span>
      <span class="num">${idx + 1}</span>
      <input type="checkbox" class="chk" ${f.include ? "checked" : ""} />
      <div class="thumb">${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="" />` : ""}</div>
      <div class="meta">
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="dim">${f.width} × ${f.height}</div>
      </div>`;
    listEl.appendChild(item);
  });
  updateExportLabel();
}

// Toggle include without a full re-render (keeps scroll position stable).
listEl.addEventListener("change", (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("chk")) return;
  const item = target.closest(".item") as HTMLElement | null;
  if (!item) return;
  const frame = frames.find((f) => f.id === item.dataset.id);
  if (!frame) return;
  frame.include = (target as HTMLInputElement).checked;
  item.classList.toggle("excluded", !frame.include);
  updateExportLabel();
});

// Native drag-and-drop: move the DOM node live, then rebuild order on drop.
listEl.addEventListener("dragstart", (e) => {
  const item = (e.target as HTMLElement).closest(".item") as HTMLElement | null;
  if (!item) return;
  item.classList.add("dragging");
  e.dataTransfer?.setData("text/plain", item.dataset.id || "");
});

listEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  const dragging = listEl.querySelector(".item.dragging") as HTMLElement | null;
  const target = (e.target as HTMLElement).closest(".item") as HTMLElement | null;
  if (!dragging || !target || target === dragging) return;
  const rect = target.getBoundingClientRect();
  const after = (e as DragEvent).clientY - rect.top > rect.height / 2;
  listEl.insertBefore(dragging, after ? target.nextSibling : target);
});

listEl.addEventListener("dragend", () => {
  const dragging = listEl.querySelector(".item.dragging");
  if (dragging) dragging.classList.remove("dragging");
  // Rebuild `frames` from the new DOM order.
  const order = Array.from(listEl.querySelectorAll<HTMLElement>(".item")).map(
    (el) => el.dataset.id
  );
  frames.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  render(); // refresh the position numbers
});

// ---- merge + download -------------------------------------------------------
async function mergeAndDownload() {
  setStatus(`Merging ${collected.length} page(s)…`);
  collected.sort((a, b) => a.index - b.index);

  const merged = await PDFDocument.create();
  for (const frame of collected) {
    const src = await PDFDocument.load(frame.bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }

  let saved = 0;
  if (dedupeCheckbox.checked) {
    setStatus("Optimizing — de-duplicating fonts & images…");
    saved += dedupeStreams(merged);
  }

  let imgNote = "";
  const preset = imagePreset();
  if (preset.maxDim > 0) {
    setStatus("Optimizing — recompressing images…");
    const img = await downsampleImages(merged, preset);
    saved += img.saved;
    imgNote = ` · imgs ${img.recompressed}/${img.jpegs} recompressed`;
    if (img.failed > 0) imgNote += `, ${img.failed} failed`;
    if (dedupeCheckbox.checked) saved += dedupeStreams(merged);
  }

  setStatus("Optimizing — repacking vector content…");
  saved += recompressFlate(merged);

  setStatus("Writing PDF…");
  const out = await merged.save({ useObjectStreams: true });

  triggerDownload(out);

  const savedText = saved > 1024 ? ` · saved ${fmtBytes(saved)}` : "";
  setStatus(
    `Done — ${collected.length} page(s), ${fmtBytes(out.length)}${savedText}${imgNote}.`,
    "success"
  );
  setProgress(0, 0);
  setBusy(false);
  updateExportLabel();
}

function triggerDownload(bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(filenameInput.value);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Re-encode a frame's JPEG to a baseline JPEG at the chosen quality (also
// guarantees pdf-lib's embedJpg can read it).
async function toBaselineJpeg(bytes: Uint8Array, quality: number): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return bytes;
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) return bytes;
  return new Uint8Array(await blob.arrayBuffer());
}

async function buildCompactAndDownload() {
  const quality = (parseInt(compactQuality.value, 10) || 80) / 100;

  setStatus(`Recompressing ${compactFrames.length} raster page(s)…`);
  for (const f of compactFrames) {
    try {
      f.jpeg = await toBaselineJpeg(f.jpeg, quality);
    } catch {
      // keep Figma's original JPEG if re-encoding fails
    }
  }

  setStatus("Composing compact PDF (raster + Figma text)…");
  const result = await buildCompactPdf(compactFrames);
  triggerDownload(result.bytes);

  const linkNote = result.links > 0 ? ` · ${result.links} links` : "";
  setStatus(
    `Done — ${compactFrames.length} page(s), ${fmtBytes(result.bytes.length)} · ${result.textPages} with text${linkNote}.`,
    "success"
  );
  setProgress(0, 0);
  setBusy(false);
  updateExportLabel();
}

// ---- messages from the plugin sandbox --------------------------------------
window.onmessage = async (event: MessageEvent) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {
    case "frame-list": {
      // Preserve include/order/thumbs for frames that are still present.
      const prev = new Map(frames.map((f) => [f.id, f]));
      frames = (msg.frames as Array<Omit<FrameItem, "include">>).map((f) => {
        const old = prev.get(f.id);
        return { ...f, include: old ? old.include : true, thumbUrl: old?.thumbUrl };
      });
      render();
      break;
    }

    case "thumb": {
      const frame = frames.find((f) => f.id === msg.id);
      if (!frame) break;
      const blob = new Blob([msg.bytes as BlobPart], { type: "image/png" });
      frame.thumbUrl = URL.createObjectURL(blob);
      const thumb = listEl.querySelector(
        `.item[data-id="${CSS.escape(msg.id)}"] .thumb`
      );
      if (thumb) thumb.innerHTML = `<img src="${frame.thumbUrl}" alt="" />`;
      break;
    }

    case "frame-count":
      collected = [];
      compactFrames = [];
      expectedCount = msg.count;
      setProgress(0, expectedCount);
      setStatus(`Exporting ${expectedCount} frame(s) from Figma…`);
      break;

    case "frame-exported":
      collected.push({ index: msg.index, name: msg.name, bytes: msg.bytes });
      setProgress(collected.length, expectedCount);
      break;

    case "frame-compact":
      compactFrames.push({
        index: msg.index,
        name: msg.name,
        jpeg: msg.jpeg,
        textPdf: msg.textPdf,
        links: msg.links,
        wpt: msg.wpt,
        hpt: msg.hpt,
      });
      setProgress(compactFrames.length, expectedCount);
      break;

    case "export-done":
      try {
        if (activeMode === "compact") await buildCompactAndDownload();
        else await mergeAndDownload();
      } catch (err) {
        setStatus(`Export failed: ${String(err)}`, "error");
        setProgress(0, 0);
        setBusy(false);
      }
      break;

    case "export-error":
      setStatus(msg.message, "error");
      setProgress(0, 0);
      setBusy(false);
      break;
  }
};

// ---- UI events --------------------------------------------------------------
sortSelect.onchange = () => {
  parent.postMessage(
    { pluginMessage: { type: "set-sort", sortMode: sortSelect.value } },
    "*"
  );
};

imageSelect.onchange = () => {
  customWrap.classList.toggle("show", imageSelect.value === "custom");
};

qualityInput.oninput = () => {
  qualityVal.textContent = `${qualityInput.value}%`;
};

compactQuality.oninput = () => {
  compactQualityVal.textContent = `${compactQuality.value}%`;
};

modeSelect.onchange = () => {
  const compact = modeSelect.value === "compact";
  compactOpts.style.display = compact ? "flex" : "none";
  vectorOpts.style.display = compact ? "none" : "flex";
};

exportBtn.onclick = () => {
  if (busy) return;
  const ids = frames.filter((f) => f.include).map((f) => f.id);
  if (ids.length === 0) {
    setStatus("Tick at least one frame to export.", "error");
    return;
  }
  activeMode = modeSelect.value as Mode;
  setBusy(true);
  setStatus("Requesting frames from Figma…");
  parent.postMessage(
    {
      pluginMessage: {
        type: "start-export",
        mode: activeMode,
        ids,
        scale: parseFloat(rasterScaleSelect.value) || 1.5,
      },
    },
    "*"
  );
};

// Kick things off: ask the sandbox for the current frame list.
parent.postMessage({ pluginMessage: { type: "init" } }, "*");
