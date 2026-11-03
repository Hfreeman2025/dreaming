#!/usr/bin/env node
// Stand-in for $EDITOR in recordings: rewrites the description, as a person might.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const text = readFileSync(path, "utf8");
writeFileSync(
  path,
  text.replace(/^description: .*$/m, "description: Always pnpm in tidepool; npm breaks the workspace links"),
);
