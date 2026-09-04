// @ts-nocheck
import { test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  editorAllowlistTable,
  editorBootstrapStateTable,
} from "@workspace/db";

import {
  BOOTSTRAP_EDITOR_EMAIL,
  canUseEmailTesting,
  isPersistedEditor,
  getPersistedEditorRole,
  maybeBootstrapEditor,
} from "./authz.ts";

// ---------------------------------------------------------------------------
// Bootstrap helper backed by the real editor_allowlist table. Each test cleans
// up its own fixture rows so runs are isolated and repeatable.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SUB = "test-bootstrap-sub";
const IMPOSTER_SUB = "test-imposter-sub";

async function cleanup() {
  for (const sub of [BOOTSTRAP_SUB, IMPOSTER_SUB]) {
    await db
      .delete(editorAllowlistTable)
      .where(eq(editorAllowlistTable.userId, sub));
    await db
      .delete(editorBootstrapStateTable)
      .where(eq(editorBootstrapStateTable.userId, sub));
  }
}

beforeAll(cleanup);
beforeEach(cleanup);
afterAll(cleanup);

test("bootstrap persists the designated editor keyed by stable sub", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  });
  expect(created).toBe(true);
  expect(await isPersistedEditor(BOOTSTRAP_SUB)).toBe(true);
  expect(await getPersistedEditorRole(BOOTSTRAP_SUB)).toBe("account_delegate");
  expect(await canUseEmailTesting(BOOTSTRAP_SUB)).toBe(true);

  const [row] = await db
    .select()
    .from(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));
  expect(row.userId).toBe(BOOTSTRAP_SUB);
  expect(row.email).toBe(BOOTSTRAP_EDITOR_EMAIL);
  expect(row.createdBy).toBe(null);
  expect(row.createdAt instanceof Date).toBeTruthy();
});

test("bootstrap is idempotent and keeps the original row", async () => {
  await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  });
  // Second call with a different email snapshot must not overwrite the row.
  const again = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: "  KODY.Low@Repl.it  ",
    email_verified: true,
  });
  expect(again).toBe(true);
  const rows = await db
    .select()
    .from(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));
  expect(rows.length).toBe(1);
  expect(rows[0].email).toBe(BOOTSTRAP_EDITOR_EMAIL);
});

test("removing the bootstrapped editor remains effective after a later login", async () => {
  const claims = {
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  };
  expect(await maybeBootstrapEditor(claims)).toBe(true);
  await db
    .delete(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));

  expect(await maybeBootstrapEditor(claims)).toBe(false);
  expect(await isPersistedEditor(BOOTSTRAP_SUB)).toBe(false);

  const state = await db
    .select()
    .from(editorBootstrapStateTable)
    .where(eq(editorBootstrapStateTable.userId, BOOTSTRAP_SUB));
  expect(state.length).toBe(1);
});

test("bootstrap normalizes email before matching", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: "  Kody.Low@REPL.IT ",
    email_verified: true,
  });
  expect(created).toBe(true);
  expect(await isPersistedEditor(BOOTSTRAP_SUB)).toBe(true);
});

test("bootstrap refuses when email is not verified", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: false,
  });
  expect(created).toBe(false);
  expect(await isPersistedEditor(BOOTSTRAP_SUB)).toBe(false);
});

test("bootstrap refuses a non-matching (imposter) email", async () => {
  const created = await maybeBootstrapEditor({
    sub: IMPOSTER_SUB,
    email: "kody.low@evil.example.com",
    email_verified: true,
  });
  expect(created).toBe(false);
  expect(await isPersistedEditor(IMPOSTER_SUB)).toBe(false);
  expect(await canUseEmailTesting(IMPOSTER_SUB)).toBe(false);
});

test("bootstrap refuses when sub or email is missing", async () => {
  expect(await maybeBootstrapEditor({ email: BOOTSTRAP_EDITOR_EMAIL, email_verified: true })).toBe(false);
  expect(await maybeBootstrapEditor({ sub: BOOTSTRAP_SUB, email_verified: true })).toBe(false);
});
