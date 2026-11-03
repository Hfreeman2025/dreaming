import { defineConfig, devices } from "@playwright/test";

// Cross-browser checks for the recorded assets (shots/): the animated demos and
// every still must render, animate (or not, under reduced motion) and log
// nothing to the console, in Chromium, WebKit and Firefox.
//
// The machine is shared, so: at most two workers, one browser at a time
// (npm run test:browsers runs the projects one after another), and every
// browser silent. The recordings have no audio; Chromium is muted and
// Firefox's volume is zero anyway, so no run can reach the speakers.
export default defineConfig({
  testDir: "test/browser",
  fullyParallel: true,
  workers: 2,
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--mute-audio"] } },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: { "media.volume_scale": "0.0" } } },
    },
  ],
});
