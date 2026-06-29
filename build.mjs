import * as esbuild from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

async function buildCode(ctx) {
  // Plugin sandbox code.
  const options = {
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    target: "es2017",
    format: "iife",
    logLevel: "info",
  };
  return ctx ? esbuild.context(options) : esbuild.build(options);
}

// Build the UI bundle to a string, then inline it into the HTML template.
// Figma loads the UI as a single self-contained HTML document, so external
// <script src> won't work — everything must be inlined.
async function buildUi() {
  const result = await esbuild.build({
    entryPoints: ["src/ui.ts"],
    bundle: true,
    write: false,
    target: "es2017",
    format: "iife",
    loader: { ".ttf": "base64" },
    logLevel: "info",
  });
  const js = result.outputFiles[0].text;
  const template = await readFile("src/ui.html", "utf8");

  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const versionLabel = `v${pkg.version} · ${stamp}`;

  const html = template
    .replace("<!-- VERSION -->", versionLabel)
    .replace("<!-- BUNDLE -->", `<script>${js}</script>`);
  await writeFile("dist/ui.html", html);
  console.log(`  dist/ui.html  (${versionLabel})`);
}

await mkdir("dist", { recursive: true });

if (watch) {
  const codeCtx = await buildCode(true);
  await codeCtx.watch();
  await buildUi();
  const uiCtx = await esbuild.context({
    entryPoints: ["src/ui.ts"],
    bundle: true,
    write: false,
    target: "es2017",
    format: "iife",
    loader: { ".ttf": "base64" },
    plugins: [
      {
        name: "inline-ui",
        setup(build) {
          build.onEnd(buildUi);
        },
      },
    ],
  });
  await uiCtx.watch();
  console.log("Watching for changes…");
} else {
  await buildCode(false);
  await buildUi();
  console.log("Build complete → dist/");
}
