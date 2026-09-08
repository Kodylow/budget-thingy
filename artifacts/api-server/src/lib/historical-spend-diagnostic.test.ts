import { expect, test, vi } from "vitest";
import { diagnoseHistoricalSpend } from "./historical-spend-diagnostic";

test.each(["2026-05-19", "2026-02-30", "2028-01-01", "bad"])(
  "rejects unbounded or invalid diagnostic date %s before connecting", async (date) => {
    const connect = vi.fn();
    await expect(diagnoseHistoricalSpend(date, { connect } as never)).rejects.toThrow("valid date");
    expect(connect).not.toHaveBeenCalled();
  },
);

test("diagnostic uses one read-only transaction and aggregate queries only", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ count: 1 }] }));
  const release = vi.fn();
  const result = await diagnoseHistoricalSpend("2026-09-08", {
    connect: async () => ({ query, release }),
  } as never);
  expect(query.mock.calls[0]).toEqual(["begin transaction isolation level repeatable read read only"]);
  expect(query.mock.calls.at(-1)).toEqual(["commit"]);
  expect(query.mock.calls.map((call) => String(call[0])).join("\n"))
    .not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  expect(result.source).toContain("no fresh upstream");
  expect(release).toHaveBeenCalledOnce();
});