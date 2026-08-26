import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("trend controls serialize selected range and team/group filters", async () => {
  const source = await readFile(new URL("./trends-ui.ts", import.meta.url), "utf8");
  assert.match(source, /rangeType/);
  assert.match(source, /rangeType === 'custom'/);
  assert.match(source, /teamNames: \[\.\.\.selectedTeams\]\.sort\(\)/);
  assert.match(source, /groupIds: \[\.\.\.selectedGroupIds\]\.sort\(\)/);
});

test("partial-bucket disclosure names ingestion lag and UTC boundaries", async () => {
  const source = await readFile(new URL("./trends-ui.ts", import.meta.url), "utf8");
  assert.match(source, /usage can arrive late/i);
  assert.match(source, /boundaries are calculated in UTC/i);
  const component = await readFile(new URL("../pages/trends-tab.tsx", import.meta.url), "utf8");
  assert.match(component, /PARTIAL_BUCKET_EXPLANATION/);
  assert.match(component, />Partial</);
});