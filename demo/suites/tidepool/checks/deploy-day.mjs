// Pass: the first line says YES. The release train moved to Tuesdays and Thursdays (per Sam, last week).
import { answer, fail, pass } from "./_check.mjs";

const first =
  answer()
    .split("\n")
    .map((line) => line.replace(/[*_#>`]/g, "").trim())
    .find((line) => line !== "") ?? "";
if (/^yes\b/i.test(first)) pass("answered YES: Thursday deploys are allowed now");
if (/^no\b/i.test(first)) fail("answered NO: it still thinks deploys are Tuesdays only");
fail(`no YES or NO on the first line: "${first.slice(0, 60)}"`);
