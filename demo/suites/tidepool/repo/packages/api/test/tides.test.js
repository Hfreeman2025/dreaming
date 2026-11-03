import assert from "node:assert/strict";
import { test } from "node:test";
import { tideTable } from "../src/index.js";

test("converts readings to metres and finds high water", () => {
  const table = tideTable("Whitby", [
    { at: "06:00", feet: 10 },
    { at: "12:00", feet: 16 },
  ]);
  assert.deepEqual(table.rows[1], { at: "12:00", metres: 4.88 });
  assert.equal(table.highWater.at, "12:00");
});
