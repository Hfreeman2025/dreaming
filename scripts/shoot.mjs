#!/usr/bin/env node
// Rasterise the recorded stills to PNG (for review and the README) and make
// the social preview (og.png, 1200×630) from a real frame of the review.
// Usage: node scripts/shoot.mjs (after npm run record).
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { THEME } from "./lib/render.mjs";

// Which recording: v2 (the default) or v3.
const VERSION = process.argv[2] ?? "v2";
const OUT = fileURLToPath(new URL(`../shots/${VERSION}/`, import.meta.url));

const size = (svg) => {
  const match = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg);
  if (!match) throw new Error("svg without a size");
  return { width: Number(match[1]), height: Number(match[2]) };
};

async function main() {
  const index = JSON.parse(await readFile(join(OUT, "stills.json"), "utf8"));
  const browser = await chromium.launch({ args: ["--mute-audio"] }); // silent: the machine is shared
  try {
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    const page = await context.newPage();
    for (const still of index) {
      const svg = await readFile(join(OUT, still.file), "utf8");
      await page.setViewportSize(size(svg));
      await page.goto(pathToFileURL(join(OUT, still.file)).href);
      await page.screenshot({ path: join(OUT, `${still.state}-${still.size}.png`) });
    }

    // The social preview: the plain name, one plain sentence, and the review itself.
    const ogContext = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 630 } });
    const ogPage = await ogContext.newPage();
    // Inlined: a page made with setContent cannot load file:// images.
    const og = {
      v2: {
        still: "review-update-wide.svg",
        line: "Proposes changes to your coding agent's memory each night; you review them like a pull request.",
      },
      v3: {
        still: "eval-hurts-wide.svg",
        line: "Measures a proposed memory before you approve it: real agent runs with and without it.",
      },
    }[VERSION];
    if (og === undefined) throw new Error(`no social preview defined for ${VERSION}`);
    const frame = await readFile(join(OUT, "stills", og.still), "utf8");
    await ogPage.setContent(`<!doctype html><html><body style="margin:0;width:1200px;height:630px;background:${THEME.background};overflow:hidden;font-family:'SF Mono',Menlo,Consolas,monospace;color:${THEME.foreground}">
      <div style="padding:44px 56px 0 56px">
        <div style="font-size:40px;font-weight:700;letter-spacing:-0.5px">dreaming</div>
        <div style="font-size:18px;margin-top:12px;color:#9aa6b2">${og.line}</div>
      </div>
      <div style="position:absolute;left:56px;top:160px;width:1088px;border-radius:8px;box-shadow:0 0 0 1px #26313a;overflow:hidden">${frame.replace(/width="\d+" height="\d+"/, 'width="100%"')}</div>
    </body></html>`);
    await ogPage.waitForLoadState("load");
    await ogPage.screenshot({ path: join(OUT, "og.png") });
    console.log(`${index.length} stills and og.png written to ${OUT}`);
  } finally {
    await browser.close();
  }
}

await main();
