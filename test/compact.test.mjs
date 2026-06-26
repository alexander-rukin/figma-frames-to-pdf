// Verify the compact composite keeps the overlaid text selectable even though
// it's drawn invisibly (opacity 0) over the raster. No font substitution: the
// text comes from a separate "text-only" PDF, exactly like Figma's text export.
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";

const bundlePath = new URL("./.compact.bundle.mjs", import.meta.url);
await esbuild.build({
  entryPoints: ["src/compact.ts"],
  bundle: true,
  outfile: bundlePath.pathname,
  format: "esm",
  external: ["pdf-lib"],
});
process.on("exit", () => { try { rmSync(bundlePath, { force: true }); } catch {} });
const { buildCompactPdf } = await import(bundlePath.href);

function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); }

// A stand-in "text-only PDF" (as Figma would produce from a stripped clone).
const textDoc = await PDFDocument.create();
const tp = textDoc.addPage([400, 300]);
const font = await textDoc.embedFont(StandardFonts.Helvetica);
tp.drawText("Investment Opportunity", { x: 20, y: 250, size: 24, font });
tp.drawText("Our team and traction", { x: 20, y: 200, size: 18, font });
const textPdf = await textDoc.save();

// 1x1 baseline JPEG stand-in for the raster background.
const jpeg = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
      "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
      "AAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q=="
  ),
  (c) => c.charCodeAt(0)
);

const frames = [
  {
    index: 0,
    name: "slide",
    jpeg,
    textPdf,
    links: [{ url: "https://blooper.ai/", x: 20, y: 40, w: 120, h: 24 }],
    wpt: 400,
    hpt: 300,
  },
];
const result = await buildCompactPdf(frames);

assert(result.bytes.length > 0, `produced a PDF (${Math.round(result.bytes.length / 1024)} KB)`);
assert(result.textPages === 1, `text layer composited onto the page (${result.textPages})`);
assert(result.links === 1, `link annotation added (${result.links})`);

const out = "/tmp/compact-composite.pdf";
await writeFile(out, result.bytes);
const text = execFileSync("pdftotext", [out, "-"], { encoding: "utf8" });
assert(text.includes("Investment Opportunity"), "overlaid text is selectable despite opacity 0");
assert(text.includes("Our team"), "second text run is selectable too");

// Confirm the Link annotation with the URL survived the save.
const reloaded = await PDFDocument.load(result.bytes);
const { PDFName: N, PDFArray: A, PDFDict: D } = await import("pdf-lib");
const annots = reloaded.getPage(0).node.lookup(N.of("Annots"));
let foundUrl = "";
if (annots instanceof A) {
  for (let i = 0; i < annots.size(); i++) {
    const an = annots.lookup(i);
    if (an instanceof D) {
      const act = an.lookup(N.of("A"));
      if (act instanceof D) {
        const u = act.lookup(N.of("URI"));
        if (u && "asString" in u) foundUrl = u.asString();
      }
    }
  }
}
assert(foundUrl.includes("blooper.ai"), `URL link is clickable in output (${foundUrl})`);

console.log("\nCompact composite checks passed.");
