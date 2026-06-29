# Frames to PDF — Figma plugin

Export several Figma frames into **one PDF** — a slide deck, a document, a
portfolio. The text stays **selectable** (copy / Cmd-F) and links stay
**clickable**, while the file stays a sensible size.

It has two modes:

- **Compact** *(recommended for sharing decks)* — small file, selectable text,
  clickable links. Graphics are rendered to a crisp image per page.
- **Vector** — everything stays vector (sharpest at any zoom), but the file is
  larger.

---

## Install (one-time, ~2 minutes)

You need the **Figma desktop app** (the browser version cannot import local
plugins). Download it from https://www.figma.com/downloads/ if you don't have it.

1. **Get the plugin files.** On the GitHub page click the green **Code** button →
   **Download ZIP**, then unzip it somewhere you'll keep it (e.g. your Documents
   folder). *(If you know git, you can `git clone` instead.)*
2. Open the **Figma desktop app**.
3. In the top-left menu go to **Plugins → Development → Import plugin from
   manifest…**
4. Select the **`manifest.json`** file from the unzipped folder.
5. Done. The plugin now appears under **Plugins → Development → Frames to PDF**.

You only do this once. The plugin stays installed.

---

## How to export a PDF

1. Open your Figma file and **select the frames** you want in the PDF.
   *(If you select nothing, every top-level frame on the page is used.)*
2. Run **Plugins → Development → Frames to PDF**.
3. In the plugin window:
   - Check the **list of frames** — drag rows to reorder, untick any you don't
     want. The numbers are the final page order.
   - Open **Output options** and pick a **Mode** (defaults to **Compact**):
     - **Compact** *(default)* — best for sending decks. Small file, selectable
       text, clickable links.
     - **Vector** — when you need the sharpest possible graphics and don't mind a
       bigger file.
   - (Optional) change the **File name**.
4. Click **Export … to PDF**. The PDF downloads automatically.

When it's done, the status line shows the page count and final size, e.g.
`Done — 25 pages, 9.8 MB · 25 text runs · 31 links`.

**If something goes wrong** (it hangs or stops), open the **Log** section at the
bottom of the plugin, click **Copy**, and send the text. Each frame logs a
"→ rendering" line before it starts and a "✓" line when it finishes, so the last
line shows exactly where it stopped.

### Compact mode settings (optional)

- **Raster resolution** — 1× (smallest) / 1.5× (balanced) / 2× (sharpest).
  Start with **1.5×**. Use 2× if graphics look soft when zoomed in.
- **JPEG quality** — lower = smaller file. 80% is a good default.

### Vector mode settings (optional)

- **Image quality** — caps how large embedded images can be (High / Medium /
  Low / Original / Custom).
- **De-duplicate shared fonts & images** — keep this on; it shrinks the file.

---

## Updating the plugin later

If you receive a new version of the files (or pull the latest from GitHub),
just replace the folder's contents. Figma uses the updated files automatically
the next time you run the plugin — no need to re-import. *(If it still looks old,
re-import the `manifest.json` as in the install steps.)*

---

## Notes

- **Selectable text in Compact mode:** the visible page is an exact image of the
  Figma frame, so **nothing in the design shifts**. A selectable text layer is
  placed on top at full transparency — it's never displayed, so the font used
  for it can't affect the look; the copied/searched characters are the real text
  from your frames. Selection highlights land on the right area; they can sit a
  little off relative to individual words, but copy and Cmd-F are always correct.
- **Links:** both text hyperlinks and prototype "open URL" actions (on icons,
  logos, buttons) are turned into clickable links in the PDF.
- **Vector mode & fonts:** if a font's license forbids embedding, Figma outlines
  that text on export and it won't be selectable. That's a font restriction, not
  the plugin.

---

## For developers

Built with TypeScript + esbuild; PDFs are assembled with
[`pdf-lib`](https://pdf-lib.js.org/). Everything runs locally — the plugin
declares no network access.

```bash
npm install      # install dependencies
npm run build    # build dist/code.js and dist/ui.html
npm run watch    # rebuild on change while developing
npm test         # run the test suite
```

`dist/` is committed so the plugin can be imported into Figma without building.
After changing anything in `src/`, run `npm run build` and commit the updated
`dist/`.

### Project layout

```
manifest.json     Figma plugin manifest
src/code.ts       Plugin sandbox: lists frames, exports them, extracts text & links
src/ui.ts         UI: frame list, reorder, options, PDF assembly & download
src/ui.html       UI markup/styles (build inlines the bundled script)
src/compact.ts    Compact mode: raster + invisible text overlay + link annotations
src/optimize.ts   Vector mode optimizations (de-dupe, image recompress, re-deflate)
build.mjs         esbuild build (bundles + inlines UI, stamps version)
test/             Test suite (selectable text, links, de-duplication)
```

### How the two modes work

- **Vector** uses Figma's native per-frame PDF (`exportAsync({ format: 'PDF' })`),
  merges the pages, then de-duplicates shared streams, recompresses oversized
  JPEGs, and re-deflates vector content.
- **Compact** rasterizes each frame to a JPEG (display-resolution graphics),
  overlays Figma's own text as an invisible selectable layer, and re-adds
  hyperlinks as PDF Link annotations.
