import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  editorAllowlistTable,
  editorBootstrapStateTable,
} from "@workspace/db";

import {
  BOOTSTRAP_EDITOR_EMAIL,
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

test.beforeEach(cleanup);
test.after(cleanup);

test("bootstrap persists the designated editor keyed by stable sub", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  });
  assert.equal(created, true);
  assert.equal(await isPersistedEditor(BOOTSTRAP_SUB), true);
  assert.equal(await getPersistedEditorRole(BOOTSTRAP_SUB), "account_delegate");

  const [row] = await db
    .select()
    .from(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));
  assert.equal(row.userId, BOOTSTRAP_SUB);
  assert.equal(row.email, BOOTSTRAP_EDITOR_EMAIL);
  assert.equal(row.createdBy, null);
  assert.ok(row.createdAt instanceof Date);
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
  assert.equal(again, true);
  const rows = await db
    .select()
    .from(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, BOOTSTRAP_EDITOR_EMAIL);
});

test("removing the bootstrapped editor remains effective after a later login", async () => {
  const claims = {
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  };
  assert.equal(await maybeBootstrapEditor(claims), true);
  await db
    .delete(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, BOOTSTRAP_SUB));

  assert.equal(await maybeBootstrapEditor(claims), false);
  assert.equal(await isPersistedEditor(BOOTSTRAP_SUB), false);

  const state = await db
    .select()
    .from(editorBootstrapStateTable)
    .where(eq(editorBootstrapStateTable.userId, BOOTSTRAP_SUB));
  assert.equal(state.length, 1);
});

test("bootstrap normalizes email before matching", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: "  Kody.Low@REPL.IT ",
    email_verified: true,
  });
  assert.equal(created, true);
  assert.equal(await isPersistedEditor(BOOTSTRAP_SUB), true);
});

test("bootstrap refuses when email is not verified", async () => {
  const created = await maybeBootstrapEditor({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: false,
  });
  assert.equal(created, false);
  assert.equal(await isPersistedEditor(BOOTSTRAP_SUB), false);
});

test("bootstrap refuses a non-matching (imposter) email", async () => {
  const created = await maybeBootstrapEditor({
    sub: IMPOSTER_SUB,
    email: "kody.low@evil.example.com",
    email_verified: true,
  });
  assert.equal(created, false);
  assert.equal(await isPersistedEditor(IMPOSTER_SUB), false);
});

test("bootstrap refuses when sub or email is missing", async () => {
  assert.equal(
    await maybeBootstrapEditor({ email: BOOTSTRAP_EDITOR_EMAIL, email_verified: true }),
    false,
  );
  assert.equal(
    await maybeBootstrapEditor({ sub: BOOTSTRAP_SUB, email_verified: true }),
    false,
  );
});
