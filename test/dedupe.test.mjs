// Smoke test for dedupeStreams: identical embedded streams should collapse to
// one object, with every reference repointed and orphans deleted.
// Run: node test/dedupe.test.mjs
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { PDFDocument, PDFRawStream, PDFName, PDFArray } from "pdf-lib";

// Bundle the TS optimizer to a temp ESM file. pdf-lib stays external so it
// resolves from the same node_modules as this test — otherwise `instanceof`
// checks across the module boundary would fail.
const bundlePath = new URL("./.optimize.bundle.mjs", import.meta.url);
await esbuild.build({
  entryPoints: ["src/optimize.ts"],
  bundle: true,
  outfile: bundlePath.pathname,
  format: "esm",
  external: ["pdf-lib"],
});
const { dedupeStreams } = await import(bundlePath.href);
process.on("exit", () => {
  try { rmSync(bundlePath, { force: true }); } catch {}
});

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok -", msg);
}

const doc = await PDFDocument.create();
const ctx = doc.context;

const fontBytes = new Uint8Array(4096);
for (let i = 0; i < fontBytes.length; i++) fontBytes[i] = (i * 31) & 0xff;

const makeStream = () =>
  ctx.register(PDFRawStream.of(ctx.obj({ Length: fontBytes.length }), fontBytes));

const r1 = makeStream();
const r2 = makeStream();
const r3 = makeStream();

// A unique, different stream that must survive untouched.
const otherBytes = new Uint8Array(4096).fill(9);
const rOther = ctx.register(
  PDFRawStream.of(ctx.obj({ Length: otherBytes.length }), otherBytes)
);

// Reference all of them from a page dict so rewriting has something to fix.
const page = doc.addPage([200, 200]);
const arr = PDFArray.withContext(ctx);
[r1, r2, r3, rOther].forEach((r) => arr.push(r));
page.node.set(PDFName.of("DupTest"), arr);

const saved = dedupeStreams(doc);

assert(saved === fontBytes.length * 2, `removed 2 duplicate copies (${saved} bytes)`);
assert(
  arr.get(0).toString() === arr.get(1).toString() &&
    arr.get(1).toString() === arr.get(2).toString(),
  "all three duplicate refs now point to one canonical object"
);
assert(ctx.lookup(r2) === undefined, "orphaned duplicate r2 was deleted");
assert(ctx.lookup(r3) === undefined, "orphaned duplicate r3 was deleted");
assert(ctx.lookup(r1) !== undefined, "canonical r1 survived");
assert(
  arr.get(3).toString() === rOther.toString() && ctx.lookup(rOther) !== undefined,
  "the unique stream was left untouched"
);

// Document must still serialize and reload cleanly.
const out = await doc.save({ useObjectStreams: true });
const reloaded = await PDFDocument.load(out);
assert(reloaded.getPageCount() === 1, "saved PDF reloads with the right page count");

// --- iterative dedup: images that reference identical-but-separate masks ----
const doc2 = await PDFDocument.create();
const c2 = doc2.context;

const maskBytes = new Uint8Array(1000).fill(3);
const makeMask = () =>
  c2.register(
    PDFRawStream.of(
      c2.obj({ Length: maskBytes.length, Type: "XObject", Subtype: "Image" }),
      maskBytes
    )
  );
const m1 = makeMask();
const m2 = makeMask();

const imgBytes = new Uint8Array(2000).fill(5);
const makeImg = (mask) => {
  const d = c2.obj({
    Length: imgBytes.length,
    Type: "XObject",
    Subtype: "Image",
    Width: 10,
    Height: 10,
  });
  d.set(PDFName.of("SMask"), mask);
  return c2.register(PDFRawStream.of(d, imgBytes));
};
const i1 = makeImg(m1);
const i2 = makeImg(m2);

const page2 = doc2.addPage([50, 50]);
const arr2 = PDFArray.withContext(c2);
[i1, i2].forEach((r) => arr2.push(r));
page2.node.set(PDFName.of("Imgs"), arr2);

const saved2 = dedupeStreams(doc2);
assert(
  saved2 === maskBytes.length + imgBytes.length,
  `iterative dedup removed one shared mask + one image (${saved2} bytes)`
);
assert(
  arr2.get(0).toString() === arr2.get(1).toString(),
  "both images collapsed to one ref after their masks were de-duplicated"
);
const out2 = await doc2.save({ useObjectStreams: true });
assert((await PDFDocument.load(out2)).getPageCount() === 1, "second PDF reloads cleanly");

console.log("\nAll dedupe checks passed.");
