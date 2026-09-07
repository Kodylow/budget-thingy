import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./monitor.groups-list.ts", import.meta.url),
  "utf8",
);

test("current and legacy families with the same key remain separate", () => {
  expect(source).toMatch(
    /item\.familyKey === group\.familyKey &&\s*item\.isLegacy === group\.isLegacy/,
  );
});