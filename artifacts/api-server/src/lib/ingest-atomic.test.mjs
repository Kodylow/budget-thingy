import assert from "node:assert/strict";
import test from "node:test";

process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";

const { pool } = await import("@workspace/db");
const enterprise = await import("./enterprise.ts");
const { ingestWorkspaceDay } = await import("./ingest.ts");

const workspaceId = `atomic-ingest-${crypto.randomUUID()}`;
const usageDate = "2099-04-12";
const successfulFetchAt = new Date("2099-04-13T01:02:03.000Z");
const originalFetch = globalThis.fetch;

test.after(async () => {
  enterprise.setEnterpriseFetchForTests(null);
  globalThis.fetch = originalFetch;
  await pool.query(
    "delete from usage_member_day where workspace_id=$1 and usage_date=$2::date",
    [workspaceId, usageDate],
  );
  await pool.query(
    "delete from usage_project_day where workspace_id=$1 and usage_date=$2::date",
    [workspaceId, usageDate],
  );
  await pool.query(
    "delete from usage_workspace_day where workspace_id=$1 and usage_date=$2::date",
    [workspaceId, usageDate],
  );
});

test("terminal grouped-fetch failure preserves the previous complete workspace day", async () => {
  await pool.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,total_cost_usd,member_attributable_usd,
        member_unattributable_usd,metrics_json,fetched_at,status,error)
     values ($1,$2::date,44,40,4,$3::jsonb,$4,'complete',null)`,
    [
      workspaceId,
      usageDate,
      JSON.stringify([{ id: "old-total", name: "Old total", category: "test", costUsd: 44 }]),
      successfulFetchAt,
    ],
  );
  await pool.query(
    `insert into usage_member_day
       (workspace_id,usage_date,user_id,total_cost_usd,ai_cost_usd,metrics_json,fetched_at)
     values ($1,$2::date,'old-user',40,30,$3::jsonb,$4)`,
    [
      workspaceId,
      usageDate,
      JSON.stringify([{ id: "old-member", name: "Old member", category: "test", costUsd: 40 }]),
      successfulFetchAt,
    ],
  );
  await pool.query(
    `insert into usage_project_day
       (workspace_id,usage_date,project_id,total_cost_usd,metrics_json,fetched_at)
     values ($1,$2::date,'old-project',44,$3::jsonb,$4)`,
    [
      workspaceId,
      usageDate,
      JSON.stringify([{ id: "old-project", name: "Old project", category: "test", costUsd: 44 }]),
      successfulFetchAt,
    ],
  );

  let memberRequests = 0;
  let projectRequests = 0;
  enterprise.setEnterpriseFetchForTests(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("groupBy") === "project") {
      projectRequests++;
      return new Response("forced project failure", { status: 503 });
    }
    memberRequests++;
    return Response.json({
      data: {
        totalCostUsd: 99,
        attributableTotalCostUsd: 99,
        unattributableTotalCostUsd: 0,
        metrics: [{ id: "new-total", name: "New total", category: "test", costUsd: 99 }],
        groups: [{
          key: { userId: "new-user" },
          totalCostUsd: 99,
          metrics: [{ id: "new-member", name: "New member", category: "test", costUsd: 99 }],
        }],
        pagination: { hasMore: false, nextCursor: null },
      },
    });
  });

  const result = await enterprise.withEnterpriseIngestAccess(
    () => ingestWorkspaceDay(workspaceId, usageDate),
  );
  assert.equal(result.ok, false);
  assert.equal(memberRequests, 3);
  assert.equal(projectRequests, 3);

  const [workspace, members, projects] = await Promise.all([
    pool.query(
      `select total_cost_usd,member_attributable_usd,member_unattributable_usd,
              metrics_json,fetched_at,status,error
       from usage_workspace_day where workspace_id=$1 and usage_date=$2::date`,
      [workspaceId, usageDate],
    ),
    pool.query(
      `select user_id,total_cost_usd,ai_cost_usd,metrics_json,fetched_at
       from usage_member_day where workspace_id=$1 and usage_date=$2::date`,
      [workspaceId, usageDate],
    ),
    pool.query(
      `select project_id,total_cost_usd,metrics_json,fetched_at
       from usage_project_day where workspace_id=$1 and usage_date=$2::date`,
      [workspaceId, usageDate],
    ),
  ]);

  assert.deepEqual(members.rows, [{
    user_id: "old-user",
    total_cost_usd: 40,
    ai_cost_usd: 30,
    metrics_json: [{ id: "old-member", name: "Old member", category: "test", costUsd: 40 }],
    fetched_at: successfulFetchAt,
  }]);
  assert.deepEqual(projects.rows, [{
    project_id: "old-project",
    total_cost_usd: 44,
    metrics_json: [{ id: "old-project", name: "Old project", category: "test", costUsd: 44 }],
    fetched_at: successfulFetchAt,
  }]);
  assert.deepEqual(workspace.rows, [{
    total_cost_usd: 44,
    member_attributable_usd: 40,
    member_unattributable_usd: 4,
    metrics_json: [{ id: "old-total", name: "Old total", category: "test", costUsd: 44 }],
    fetched_at: successfulFetchAt,
    status: "failed",
    error: "Enterprise API /usage failed (503): forced project failure",
  }]);
});