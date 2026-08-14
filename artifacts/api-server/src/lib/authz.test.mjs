import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAuthorization,
  scopeGroups,
  canSeeGroup,
  canSeeWorkspace,
  isAccountAdmin,
  isAccountEditor,
  isApplicationAdmin,
  isAccountWide,
  normalizeEmail,
  BOOTSTRAP_EDITOR_EMAIL,
  setEditorAllowlistLookup,
} from "./authz.ts";
import { __setDirectoryCacheForTests } from "./enterprise.ts";

// ---------------------------------------------------------------------------
// Representative fixture: a Comcast-style Enterprise directory with three
// workspaces, several custom groups, and members spanning account admins,
// single- and multi-workspace admins, disabled admins, and plain members.
// ---------------------------------------------------------------------------

function member(userId, isAccountAdmin, workspaces) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

const groups = [
  { id: "g-ws1-a", workspaceId: "ws-1", name: "Alpha", type: "custom" },
  { id: "g-ws1-b", workspaceId: "ws-1", name: "Beta", type: "custom" },
  { id: "g-ws2-a", workspaceId: "ws-2", name: "Gamma", type: "custom" },
  { id: "g-ws3-a", workspaceId: "ws-3", name: "Delta", type: "custom" },
];

const members = new Map([
  // Account admin — no per-workspace admin roles needed.
  ["acct", member("acct", true, {})],
  // Admin of a single workspace.
  ["ws1admin", member("ws1admin", false, { "ws-1": { role: "admin", isDisabled: false } })],
  // Admin of two workspaces (multi-workspace union).
  ["ws12admin", member("ws12admin", false, {
    "ws-1": { role: "admin", isDisabled: false },
    "ws-2": { role: "admin", isDisabled: false },
  })],
  // Admin role but disabled — must be denied.
  ["disabled", member("disabled", false, { "ws-1": { role: "admin", isDisabled: true } })],
  // Non-admin member — must be denied.
  ["plain", member("plain", false, { "ws-1": { role: "member", isDisabled: false } })],
  // Admin of one workspace + non-admin of another (union excludes non-admin ws).
  ["mixed", member("mixed", false, {
    "ws-1": { role: "member", isDisabled: false },
    "ws-2": { role: "admin", isDisabled: false },
  })],
]);

// In-memory editor allowlist injected in place of the DB-backed lookup so
// authorization logic can be exercised without a database.
let editorIds = new Set();

function seed() {
  editorIds = new Set();
  __setDirectoryCacheForTests({ groups, members });
  setEditorAllowlistLookup((userId) => Promise.resolve(editorIds.has(userId)));
}

test.beforeEach(seed);
test.after(() => {
  __setDirectoryCacheForTests(null);
  setEditorAllowlistLookup(null);
});

test("unknown user is denied (fail closed)", async () => {
  assert.equal(await resolveAuthorization("nobody"), null);
});

test("account admin resolves to account_admin with empty workspaceIds", async () => {
  const authz = await resolveAuthorization("acct");
  assert.deepEqual(authz, { role: "account_admin", workspaceIds: [] });
  assert.equal(isAccountAdmin(authz), true);
});

test("single-workspace admin scopes to that workspace only", async () => {
  const authz = await resolveAuthorization("ws1admin");
  assert.equal(authz.role, "workspace_admin");
  assert.deepEqual(authz.workspaceIds, ["ws-1"]);
});

test("multi-workspace admin scopes to the union of admin workspaces", async () => {
  const authz = await resolveAuthorization("ws12admin");
  assert.equal(authz.role, "workspace_admin");
  assert.deepEqual([...authz.workspaceIds].sort(), ["ws-1", "ws-2"]);
});

test("mixed member only counts workspaces where the role is admin", async () => {
  const authz = await resolveAuthorization("mixed");
  assert.equal(authz.role, "workspace_admin");
  assert.deepEqual(authz.workspaceIds, ["ws-2"]);
});

test("disabled admin is denied", async () => {
  assert.equal(await resolveAuthorization("disabled"), null);
});

test("plain member is denied", async () => {
  assert.equal(await resolveAuthorization("plain"), null);
});

test("scopeGroups returns all groups for account admins", () => {
  const authz = { role: "account_admin", workspaceIds: [] };
  assert.equal(scopeGroups(authz, groups).length, groups.length);
});

test("scopeGroups filters to admin workspaces for workspace admins", () => {
  const authz = { role: "workspace_admin", workspaceIds: ["ws-1"] };
  const scoped = scopeGroups(authz, groups);
  assert.deepEqual(scoped.map((g) => g.id), ["g-ws1-a", "g-ws1-b"]);
});

test("canSeeGroup / canSeeWorkspace enforce scope", () => {
  const authz = { role: "workspace_admin", workspaceIds: ["ws-2"] };
  assert.equal(canSeeWorkspace(authz, "ws-2"), true);
  assert.equal(canSeeWorkspace(authz, "ws-1"), false);
  assert.equal(canSeeGroup(authz, groups[2]), true); // g-ws2-a
  assert.equal(canSeeGroup(authz, groups[0]), false); // g-ws1-a
  const acct = { role: "account_admin", workspaceIds: [] };
  assert.equal(canSeeWorkspace(acct, "any"), true);
});

// ---------------------------------------------------------------------------
// Managed account_editor allowlist resolution.
// ---------------------------------------------------------------------------

test("persisted editor resolves to account_editor with account-wide access", async () => {
  editorIds.add("plain");
  const authz = await resolveAuthorization("plain");
  assert.deepEqual(authz, { role: "account_editor", workspaceIds: [] });
  assert.equal(isAccountEditor(authz), true);
  assert.equal(isAccountWide(authz), true);
  assert.equal(isAccountAdmin(authz), false);
  // Account-wide visibility: every workspace/group is visible.
  assert.equal(canSeeWorkspace(authz, "ws-1"), true);
  assert.equal(canSeeWorkspace(authz, "ws-unknown"), true);
  assert.equal(scopeGroups(authz, groups).length, groups.length);
});

test("designated persisted identity resolves to full application-admin delegate", async () => {
  setEditorAllowlistLookup((userId) =>
    Promise.resolve(userId === "plain" ? "account_delegate" : false));
  const authz = await resolveAuthorization("plain");
  assert.deepEqual(authz, { role: "account_delegate", workspaceIds: [] });
  assert.equal(isApplicationAdmin(authz), true);
  assert.equal(isAccountWide(authz), true);
  assert.equal(isAccountEditor(authz), false);
});

test("persisted editor not in the directory still gets account-wide access", async () => {
  editorIds.add("external-editor");
  const authz = await resolveAuthorization("external-editor");
  assert.deepEqual(authz, { role: "account_editor", workspaceIds: [] });
  assert.equal(isAccountWide(authz), true);
});

test("workspace admin who is also a persisted editor is upgraded to editor", async () => {
  editorIds.add("ws1admin");
  const authz = await resolveAuthorization("ws1admin");
  assert.equal(authz.role, "account_editor");
  assert.deepEqual(authz.workspaceIds, []);
});

test("true account admin takes precedence over the editor allowlist", async () => {
  editorIds.add("acct");
  const authz = await resolveAuthorization("acct");
  assert.equal(authz.role, "account_admin");
  assert.equal(isAccountAdmin(authz), true);
  assert.equal(isAccountEditor(authz), false);
});

test("non-editor ordinary member is still denied (fail closed)", async () => {
  // "plain" is a non-admin member and not on the allowlist.
  assert.equal(await resolveAuthorization("plain"), null);
});

test("workspace admin who is not an editor retains scoped workspace_admin", async () => {
  const authz = await resolveAuthorization("ws12admin");
  assert.equal(authz.role, "workspace_admin");
  assert.deepEqual([...authz.workspaceIds].sort(), ["ws-1", "ws-2"]);
  // Scoping still applies: not account-wide.
  assert.equal(isAccountWide(authz), false);
  assert.equal(canSeeWorkspace(authz, "ws-3"), false);
});

test("isAccountWide / isAccountEditor handle null authz", () => {
  assert.equal(isAccountWide(null), false);
  assert.equal(isAccountEditor(undefined), false);
  assert.equal(isAccountWide({ role: "workspace_admin", workspaceIds: [] }), false);
});

// ---------------------------------------------------------------------------
// Bootstrap helper: verified-email-only, exact normalized match.
// ---------------------------------------------------------------------------

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  KODY.Low@Repl.it \n"), BOOTSTRAP_EDITOR_EMAIL);
});
