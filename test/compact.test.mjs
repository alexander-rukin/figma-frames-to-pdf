// Verify the compact composite: invisible text overlay is selectable, and the
// URL link annotation is clickable. No document cloning is involved.
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { PDFDocument, PDFName, PDFArray, PDFDict } from "pdf-lib";

const bundlePath = new URL("./.compact.bundle.mjs", import.meta.url);
await esbuild.build({
  entryPoints: ["src/compact.ts"],
  bundle: true,
  outfile: bundlePath.pathname,
  format: "esm",
  external: ["pdf-lib", "@pdf-lib/fontkit"],
});
process.on("exit", () => { try { rmSync(bundlePath, { force: true }); } catch {} });
const { buildCompactPdf } = await import(bundlePath.href);

function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); }

const fontBytes = new Uint8Array(await readFile("assets/font.ttf"));

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
    texts: [
      { chars: "Investment Opportunity", x: 20, y: 40, w: 360, h: 30, size: 24 },
      { chars: "Привет команда", x: 20, y: 90, w: 360, h: 24, size: 18 },
    ],
    links: [{ url: "https://blooper.ai/", x: 20, y: 40, w: 120, h: 24 }],
    wpt: 400,
    hpt: 300,
  },
];

const result = await buildCompactPdf(frames, fontBytes);
assert(result.bytes.length > 0, `produced a PDF (${Math.round(result.bytes.length / 1024)} KB)`);
assert(result.textRuns === 2, `both text runs placed (${result.textRuns})`);
assert(result.links === 1, `link annotation added (${result.links})`);

const out = "/tmp/compact-composite.pdf";
await writeFile(out, result.bytes);
const text = execFileSync("pdftotext", [out, "-"], { encoding: "utf8" });
assert(text.includes("Investment Opportunity"), "Latin overlay text is selectable (opacity 0)");
assert(text.includes("Привет"), "Cyrillic overlay text is selectable");

const reloaded = await PDFDocument.load(result.bytes);
const annots = reloaded.getPage(0).node.lookup(PDFName.of("Annots"));
let foundUrl = "";
if (annots instanceof PDFArray) {
  for (let i = 0; i < annots.size(); i++) {
    const an = annots.lookup(i);
    if (an instanceof PDFDict) {
      const act = an.lookup(PDFName.of("A"));
      if (act instanceof PDFDict) {
        const u = act.lookup(PDFName.of("URI"));
        if (u && "asString" in u) foundUrl = u.asString();
      }
    }
  }
}
assert(foundUrl.includes("blooper.ai"), `URL link is clickable in output (${foundUrl})`);

console.log("\nCompact composite checks passed.");
