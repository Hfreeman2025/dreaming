import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Every recorded screen, v2 and v3: the animations play and hold still under
// reduced motion, and every still renders its text, with nothing in the console.
const Stills = z.array(z.object({ state: z.string(), size: z.string(), file: z.string() }));
const RECORDINGS = [
  { version: "v2", animations: [{ file: "demo.svg", title: /dreaming: run, review and why/ }] },
  {
    version: "v3",
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

for (const { version, animations } of RECORDINGS) {
  const shots = new URL(`../../shots/${version}/`, import.meta.url);
  if (!existsSync(new URL("stills.json", shots))) continue;
  const stills = Stills.parse(JSON.parse(readFileSync(new URL("stills.json", shots), "utf8")));
  const url = (file: string) => pathToFileURL(new URL(file, shots).pathname).href;

  for (const animation of animations) {
    test(`${version} ${animation.file}: loads, plays one frame at a time, and logs nothing`, async ({ page }) => {
      const messages = watchConsole(page);
      await page.goto(url(animation.file));
      await expect(page.locator("title")).toHaveText(animation.title);
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

    test(`${version} ${animation.file}: with reduced motion, shows its last frame and does not move`, async ({
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
    test(`${version} still: ${still.state} (${still.size}) renders its text`, async ({ page }) => {
      const messages = watchConsole(page);
      await page.goto(url(still.file));
      const text = await page.evaluate(() =>
        [...document.querySelectorAll("text")].map((t) => t.textContent).join(" "),
      );
      expect(text.length).toBeGreaterThan(20);
      const box = await page.locator("svg").boundingBox();
      expect(box?.width).toBeGreaterThan(300);
      expect(messages).toEqual([]);
    });
  }
}
