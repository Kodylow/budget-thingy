import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import {
  getMeasuredVirtualWindow,
  getRestoredFocusIndex,
  VirtualizedTableRows,
} from "./virtualized-table-rows";

test("virtualized rows expose logical indexes and spacer columns for a large table", () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    createElement(
      "tr",
      { key: index },
      Array.from({ length: 7 }, (_, column) =>
        createElement("td", { key: column }, `${index}:${column}`),
      ),
    ),
  );

  const markup = renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(VirtualizedTableRows, {
        columnCount: 7,
        logicalRowIndexOffset: 25,
        children: rows,
      }),
    ),
  );

  expect(markup).toContain('colSpan="7"');
  expect(markup).not.toContain('colSpan="8"');
  expect(markup).toContain('aria-rowindex="27"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).not.toContain('99:0');
});

test("wrapped row measurements control spacer and focus offsets", () => {
  const measured = new Map([
    [0, 120],
    [1, 80],
  ]);
  const window = getMeasuredVirtualWindow(10, 200, 50, 40, measured, 0);
  expect(window.start).toBe(2);
  expect(window.before).toBe(200);
  expect(window.offsets[3]).toBe(240);
  expect(window.after).toBe(240);
});

test("filter shrink restores the removed focused row to the nearest survivor", () => {
  expect(getRestoredFocusIndex(
    { index: 5, key: 'removed-row' },
    Array.from({ length: 10 }, (_, index) => `remaining-${index}`),
  )).toBe(5);
  expect(getRestoredFocusIndex(
    { index: 19, key: 'removed-last-row' },
    ['first', 'second'],
  )).toBe(1);
  expect(getRestoredFocusIndex(
    { index: 5, key: 'still-present' },
    ['first', 'still-present', 'last'],
  )).toBeNull();
});