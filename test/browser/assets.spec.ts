import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Every recorded screen: the animations play and hold still under reduced
// motion, and every still renders its text, with nothing in the console. The
// text is IBM Plex Mono embedded in each SVG: it must load, including when the
// SVG is shown as an <img>, as the README shows it.
const Stills = z.array(z.object({ state: z.string(), size: z.string(), file: z.string() }));
const RECORDINGS = [
  {
    set: "core",
    probe: "review-update",
    animations: [{ file: "demo.svg", title: /dreaming: run, review and why/ }],
  },
  {
    set: "measure",
    probe: "eval-hurts",
    animations: [
      { file: "eval.svg", title: /a replay of a recorded eval, 30 real claude -p runs/ },
      { file: "loop.svg", title: /a dream, the contradiction check and the review/ },
    ],
  },
];

/** Every console message, so a test can require there are none. */
function watchConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  return messages;
}

/** The font faces a document has loaded, as "family weight". */
const loadedFaces = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => `${face.family.replaceAll('"', "")} ${face.weight}`);
  });

for (const { set, probe, animations } of RECORDINGS) {
  const shots = new URL(`../../shots/${set}/`, import.meta.url);
  const stills = Stills.parse(JSON.parse(readFileSync(new URL("stills.json", shots), "utf8")));
  const url = (file: string) => pathToFileURL(new URL(file, shots).pathname).href;

  for (const animation of animations) {
    test(`${set} ${animation.file}: loads, plays one frame at a time, and logs nothing`, async ({ page }) => {
      const messages = watchConsole(page);
      await page.goto(url(animation.file));
      await expect(page.locator("title")).toHaveText(animation.title);
      expect(await loadedFaces(page)).toContain("IBM Plex Mono 400");
      const frames = await page.locator(".fr").count();
      expect(frames).toBeGreaterThan(10);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(frames);
      const frameAt = async (ms: number) => {
        await page.evaluate((t) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = t;
          }
        }, ms);
        const visible = await page.evaluate(
          () =>
            [...document.querySelectorAll(".fr")].filter((g) => getComputedStyle(g).visibility === "visible").length,
        );
        expect(visible).toBe(1);
        return page.screenshot();
      };
      expect(Buffer.compare(await frameAt(500), await frameAt(15_000))).not.toBe(0);
      expect(messages).toEqual([]);
    });

    test(`${set} ${animation.file}: with reduced motion, shows its last frame and does not move`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      const messages = watchConsole(page);
      await page.goto(url(animation.file));
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(
        0,
      );
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll(".fr")].flatMap((g, i, all) =>
          getComputedStyle(g).visibility === "visible" ? [i === all.length - 1 ? "last" : String(i)] : [],
        ),
      );
      expect(visible).toEqual(["last"]);
      expect(messages).toEqual([]);
      await context.close();
    });
  }

  for (const still of stills) {
    test(`${set} still: ${still.state} (${still.size}) renders its text`, async ({ page }) => {
      const messages = watchConsole(page);
      await page.goto(url(still.file));
      const text = await page.evaluate(() =>
        [...document.querySelectorAll("text")].map((t) => t.textContent).join(" "),
      );
      expect(text.length).toBeGreaterThan(20);
      expect(await loadedFaces(page)).toContain("IBM Plex Mono 400");
      const box = await page.locator("svg").boundingBox();
      expect(box?.width).toBeGreaterThan(300);
      expect(messages).toEqual([]);
    });
  }

  test(`${set} as an <img>: draws with the embedded font, not a fallback`, async ({ page }) => {
    // Rename the embedded family so that only the embedded data can satisfy it (not
    // a copy of Plex installed on the machine), then compare with the font removed.
    const still = stills.find((s) => s.state === probe && s.size === "wide");
    if (still === undefined) throw new Error(`the ${probe} still is missing from ${set}/stills.json`);
    const svg = readFileSync(new URL(still.file, shots), "utf8").replaceAll("IBM Plex Mono", "Embedded Probe");
    const without = svg.replace(/@font-face\{[^}]*\}/g, "");
    expect(without).not.toBe(svg);
    const src = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
    await page.setContent(`<img id="with" src="${src(svg)}"><img id="without" src="${src(without)}">`);
    for (const id of ["with", "without"])
      await page.locator(`#${id}`).evaluate((img: HTMLImageElement) => img.decode());
    await expect
      .poll(async () =>
        Buffer.compare(await page.locator("#with").screenshot(), await page.locator("#without").screenshot()),
      )
      .not.toBe(0);
  });
}
