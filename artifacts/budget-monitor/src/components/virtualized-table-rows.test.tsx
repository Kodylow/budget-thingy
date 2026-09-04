import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { VirtualizedTableRows } from "./virtualized-table-rows";

test("virtualized spacer rows span the configured seven-column dashboard table", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
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
      createElement(VirtualizedTableRows, { columnCount: 7, children: rows }),
    ),
  );

  expect(markup).toContain('colSpan="7"');
  expect(markup).not.toContain('colSpan="8"');
});