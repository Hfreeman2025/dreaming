#!/usr/bin/env node
// Rasterise the recorded stills to PNG (for review and the README) and make
// the social preview (shots/og.png, 1200×630) from a real frame of an eval.
// Usage: node scripts/shoot.mjs [core|measure] (after npm run record; both by default).
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { THEME } from "./lib/render.mjs";

const SETS = ["core", "measure"];
const chosen = process.argv[2] === undefined ? SETS : [process.argv[2]];
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = join(ROOT, "shots");

const size = (svg) => {
  const match = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg);
  if (!match) throw new Error("svg without a size");
  return { width: Number(match[1]), height: Number(match[2]) };
};

/* global document, PerformanceObserver -- the two helpers below run in the page, through page.evaluate */

/** The faces a page has finished loading, as "family weight". */
const loadedFaces = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => `${f.family.replaceAll('"', "")} ${f.weight}`);
  });

/** Total layout shift on a page so far (Chromium's Layout Instability API). */
const layoutShift = (page) =>
  page.evaluate(
    () =>
      new Promise((done) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) total += entry.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => done(total), 500);
      }),
  );

// The social preview: the plain name, one plain sentence, and a real frame of an eval.
const OG = {
  set: "measure",
  still: "eval-hurts-wide.svg",
  line: "Measures a proposed memory before you approve it: real agent runs with and without it.",
};

/** The card as a page: Plex from fonts/, the two faces it shows preloaded, the frame an <img> with its size reserved. */
function ogPage(frame) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dreaming</title>
<link rel="preload" href="/fonts/ibm-plex-sans-condensed-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/fonts/plex.css">
<style>
body{margin:0;width:1200px;height:630px;overflow:hidden;background:${THEME.background};color:${THEME.foreground};font-family:"IBM Plex Sans",system-ui,sans-serif}
.head{padding:40px 56px 0}
.name{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;font-weight:600;font-size:46px;line-height:54px}
.line{margin-top:8px;font-size:20px;line-height:28px;color:#9aa6b2}
.frame{position:absolute;left:56px;top:160px;width:1088px;border-radius:8px;box-shadow:0 0 0 1px #26313a;overflow:hidden}
.frame img{display:block;width:100%;height:auto}
</style></head><body>
<div class="head"><div class="name">dreaming</div><div class="line">${OG.line}</div></div>
<div class="frame"><img src="/shots/${OG.set}/stills/${OG.still}" width="${frame.width}" height="${frame.height}" alt=""></div>
</body></html>`;
}

/** Serve fonts/, shots/ and the card from this repository, and nothing else. */
async function serve(frame) {
  const types = { ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    if (path === "/og") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(ogPage(frame));
      return;
    }
    const file = resolve(ROOT, `.${path}`);
    const allowed = ["fonts", "shots"].some((dir) => file.startsWith(join(ROOT, dir) + sep));
    if (!allowed || !(extname(file) in types)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    readFile(file).then(
      (body) => {
        response.setHeader("content-type", types[extname(file)]);
        response.end(body);
      },
      () => {
        response.statusCode = 404;
        response.end();
      },
    );
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function main() {
  for (const set of chosen) if (!SETS.includes(set)) throw new Error(`no recordings called ${set}: core or measure`);
  const frame = size(await readFile(join(SHOTS, OG.set, "stills", OG.still), "utf8"));
  const { server, base } = await serve(frame);
  const browser = await chromium.launch({ args: ["--mute-audio"] }); // silent: the machine is shared
  try {
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    const page = await context.newPage();
    for (const set of chosen) {
      const out = join(SHOTS, set);
      const index = JSON.parse(await readFile(join(out, "stills.json"), "utf8"));
      for (const still of index) {
        const svg = await readFile(join(out, still.file), "utf8");
        await page.setViewportSize(size(svg));
        await page.goto(pathToFileURL(join(out, still.file)).href);
        const faces = await loadedFaces(page);
        if (!faces.includes("IBM Plex Mono 400"))
          throw new Error(`${set}/${still.file}: IBM Plex Mono did not load (${faces.join(", ") || "no faces"})`);
        await page.screenshot({ path: join(out, `${still.state}-${still.size}.png`) });
      }
      console.log(`${set}: ${index.length} stills written to ${out}`);
    }
    if (!chosen.includes(OG.set)) return;

    const ogContext = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 630 } });
    const ogPage = await ogContext.newPage();
    await ogPage.goto(`${base}/og`, { waitUntil: "load" });
    await ogPage.locator("img").evaluate((img) => img.decode());
    const faces = await loadedFaces(ogPage);
    for (const face of ["IBM Plex Sans Condensed 600 700", "IBM Plex Sans 400"]) {
      if (!faces.includes(face)) throw new Error(`og: ${face} did not load (${faces.join(", ") || "no faces"})`);
    }
    const shift = await layoutShift(ogPage);
    if (shift > 0) throw new Error(`og: the page shifted while loading (layout shift ${shift.toFixed(4)})`);
    await ogPage.screenshot({ path: join(SHOTS, "og.png") });
    console.log(`og.png written to ${SHOTS} (${faces.join(", ")}; layout shift 0)`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
