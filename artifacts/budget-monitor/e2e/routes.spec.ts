import { expect, test, type Page, type Route } from '@playwright/test';
import type { DashboardProjection } from '@workspace/api-client-react';
import { buildDashboardProjection } from '../../api-server/src/lib/dashboard-projection';

type Role =
  | 'account'
  | 'workspace_admin'
  | 'team_admin'
  | 'member'
  | 'denied'
  | 'signed_out'
  | 'unavailable';

const WORKSPACE_ID = 'workspace-smoke';
const GROUP_ID = 'group-smoke';
const FAMILY_KEY = 'family-smoke';
const MANY_GROUP_IDS = [
  GROUP_ID,
  'group-smoke-admin',
  'group-smoke-billing',
  'group-smoke-member-2',
  'group-smoke-member-3',
  'group-smoke-member-4',
  'group-smoke-member-5',
  'group-smoke-member-6',
];
const usageHealth = {
  status: 'complete',
  dataAsOf: '2026-09-04T00:00:00.000Z',
  coverage: {
    requestedDays: 1,
    requestedWorkspaceDays: 1,
    presentWorkspaceDays: 1,
    failedWorkspaceDays: [],
    missingWorkspaceDays: [],
    presentAccountDays: 1,
    missingAccountDays: [],
    ratio: 1,
  },
  accountWorkspaceUnreconciledUsd: 0,
};
const group = {
  groupId: GROUP_ID,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Smoke Workspace',
  name: 'Smoke Team - Member',
  familyKey: FAMILY_KEY,
  familyName: 'Smoke Team',
  role: 'member',
  isLegacy: false,
  teamName: 'Smoke Team',
  type: 'custom',
  memberCount: 1,
  rollupMemberCount: 1,
  spendUsd: 10,
  paceSpendUsd: 10,
  projectSpendUsd: 10,
  rollupSpendUsd: 10,
  budgetUsd: 100,
  budgetSource: 'app',
  remainingUsd: 90,
  percentUsed: 10,
  thresholdsFired: [],
  history: [],
  projectedSpendUsd: 20,
};
const member = {
  userId: 'member-smoke',
  username: 'smoke-member',
  email: 'smoke@example.test',
  name: 'Smoke Member',
  role: 'member',
  isDisabled: false,
  spendUsd: 10,
  aiSpendUsd: 10,
  nonAiSpendUsd: 0,
};

function fundingInventory(revision: string, teamName: string | null = null) {
  return {
    revision,
    groups: [
      {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        groupId: 'funding-unmapped',
        groupName: 'Executive Group',
        memberCount: 0,
        teamName,
        origin: teamName === null ? 'unmapped' : 'explicit',
        isHidden: false,
      },
      {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        groupId: 'funding-mapped',
        groupName: 'Smoke Members',
        memberCount: 3,
        teamName: 'Smoke Team',
        origin: 'inferred',
        isHidden: false,
      },
    ],
    teams: [{ teamName: 'Smoke Team', isHidden: false }],
    freshness: { status: 'fresh', dataAsOf: '2026-09-04T00:00:00.000Z', error: null },
  };
}

function alertFixture(id: number) {
  return {
    id,
    entityType: 'group',
    entityId: GROUP_ID,
    entityName: `Smoke alert ${id}`,
    alertType: 'threshold',
    threshold: 75,
    spendUsd: 75,
    budgetUsd: 100,
    recipients: ['owner@example.test'],
    status: 'sent',
    error: null,
    sentAt: '2026-09-04T00:00:00.000Z',
    blockedMemberCount: 0,
  };
}
const limitMembers = Array.from({ length: 27 }, (_, index) => {
  const ordinal = index + 101;
  const userId = String(ordinal);
  return {
    userId,
    username: `limit-member-${ordinal}`,
    name: ordinal === 101 ? 'Alex Explicit' : ordinal === 102 ? 'Blair Inherited' : `Limit Member ${ordinal}`,
    email: `limit-${ordinal}@example.test`,
    role: 'member',
    groupIds: ordinal === 101
      ? ['limit-group-a']
      : ordinal === 102
        ? ['limit-group-a', 'limit-group-b']
        : ordinal === 103
          ? ['limit-group-b']
          : [],
    isInternal: ordinal === 125,
    isDisabled: ordinal === 126,
    eligible: ordinal !== 125 && ordinal !== 126,
    usageUsd: ordinal === 103 ? null : ordinal - 100,
    explicitLimitUsd: ordinal === 101 ? 75 : null,
    effectiveLimitUsd: ordinal === 101 ? 75 : ordinal === 102 ? 50 : null,
    limitState: ordinal === 101
      ? 'explicit'
      : ordinal === 102
        ? 'inherited'
        : ordinal === 124
          ? 'unavailable'
          : 'no_limit',
  };
});

const limitGroups = [
  {
    groupId: 'limit-group-a',
    name: 'Platform Operations',
    familyName: 'Platform',
    role: 'member',
    eligibleUserIds: ['101', '102'],
  },
  {
    groupId: 'limit-group-b',
    name: 'Incident Response',
    familyName: 'Platform',
    role: 'member',
    eligibleUserIds: ['102', '103'],
  },
  {
    groupId: 'limit-group-readonly',
    name: 'Read-only Contractors',
    familyName: null,
    role: 'member',
    eligibleUserIds: [],
  },
];

type LimitRequest = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
};

const LIMIT_OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const LIMIT_REVIEW_FINGERPRINT = 'a'.repeat(64);

function limitWorkspaceFixture(canWrite = true) {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Smoke Workspace',
    canWrite,
    unavailableReason: null,
    billingPeriod: {
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-10-01T00:00:00.000Z',
    },
    limitObservation: {
      status: 'available',
      observedAt: '2026-09-04T00:00:00.000Z',
      error: null,
    },
    groups: limitGroups,
    members: limitMembers,
  };
}

function limitOperationFixture(
  state: 'prepared' | 'completed',
  userIds: string[],
  retrySucceeded = false,
) {
  const targets = userIds.map((userId, index) => {
    const failed = state === 'completed' && index === 0 && !retrySucceeded;
    const source = limitMembers.find((item) => item.userId === userId);
    return {
      workspaceId: WORKSPACE_ID,
      userId,
      memberName: source?.name ?? userId,
      memberEmail: source?.email ?? null,
      oldAmountUsd: source?.effectiveLimitUsd ?? null,
      newAmountUsd: 60,
      state: state === 'prepared' ? 'queued' : failed ? 'failed' : 'verified',
      attempts: state === 'prepared' ? 0 : 1,
      history: [],
      errorStage: failed ? 'write' : null,
      errorCode: failed ? 'fixture_failure' : null,
      errorMessage: failed ? 'Safe fixture failure; no provider request was made.' : null,
      upstreamRequestId: null,
      queuedAt: state === 'prepared' ? null : '2026-09-04T00:01:00.000Z',
      applyingAt: state === 'prepared' ? null : '2026-09-04T00:01:01.000Z',
      verifiedAt: state === 'completed' && !failed ? '2026-09-04T00:01:02.000Z' : null,
      failedAt: failed ? '2026-09-04T00:01:02.000Z' : null,
    };
  });
  const failed = targets.filter((target) => target.state === 'failed').length;
  return {
    id: LIMIT_OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    state,
    amountUsd: 60,
    reviewFingerprint: LIMIT_REVIEW_FINGERPRINT,
    actorUserId: 'account-smoke',
    preparedAt: '2026-09-04T00:00:00.000Z',
    committedAt: state === 'prepared' ? null : '2026-09-04T00:01:00.000Z',
    completedAt: state === 'prepared' ? null : '2026-09-04T00:01:02.000Z',
    counts: {
      total: targets.length,
      queued: state === 'prepared' ? targets.length : 0,
      applying: 0,
      verified: state === 'completed' ? targets.length - failed : 0,
      failed,
      verificationPending: 0,
    },
    targets,
  };
}

function capabilities(role: Role, canPreviewRoles = false) {
  const account = role === 'account';
  return {
    canManageAccess: account,
    canViewAccountUsage: account,
    canEditAllocations: account,
    canManageFundingMappings: account,
    canManageNotifications: account,
    canManageSystem: account,
    canPreviewRoles,
    canWriteGroupLimits: account,
    canWriteUserLimitsIn: account || role === 'workspace_admin' ? [WORKSPACE_ID] : [],
    canRunChecks: account,
    canSendTestEmail: false,
  };
}

function orgBudgetOverviewFixture() {
  const reporting = {
    acquisitionCoverage: 'complete',
    rosterAttributionBasis: 'current_membership',
    creatorCoverage: 'not_applicable',
    creatorAttributionBasis: 'not_applicable',
    freshness: 'fresh',
    valueBasis: 'verified',
    comparisonsVerified: true,
  };
  return {
    periodStart: '2026-05-20',
    periodEnd: '2027-05-20',
    asOf: '2026-09-08',
    complete: true,
    reporting,
    qualification: null,
    summary: {
      accountSpendUsd: 10,
      teamAllocationUsd: 100,
      remainingUsd: 90,
      teamsOverBudget: 0,
      unassignedSpendUsd: 0,
      fundedTeamCount: 1,
      resolvedTeamCount: 1,
      unresolvedTeamCount: 0,
    },
    accountPoints: [
      { date: '2026-06-01', spendUsd: 2 },
      { date: '2026-07-01', spendUsd: 5 },
      { date: '2026-08-01', spendUsd: 8 },
      { date: '2026-09-01', spendUsd: 10 },
    ],
    teams: [{
      id: 'smoke-team',
      name: 'Smoke Team',
      allocationUsd: 100,
      spendUsd: 10,
      remainingUsd: 90,
      percentUsed: 10,
      complete: true,
      reporting,
      points: [
        { date: '2026-06-01', spendUsd: 2 },
        { date: '2026-07-01', spendUsd: 5 },
        { date: '2026-08-01', spendUsd: 8 },
        { date: '2026-09-01', spendUsd: 10 },
      ],
    }],
  };
}

function authEnvelope(role: Role, canPreviewRoles = false, previewAs: string | null = null) {
  if (role === 'signed_out') {
    return { user: null, auth: null, capabilities: capabilities(role) };
  }
  const user = {
    id: `${role}-smoke`,
    email: `${role}@example.test`,
    firstName: 'Route',
    lastName: 'Smoke',
    profileImageUrl: null,
  };
  if (role === 'denied') return { user, auth: null, capabilities: capabilities(role) };
  const previewRole = canPreviewRoles && previewAs
    ? previewAs.split(':', 1)[0] as Role
    : null;
  const effectiveRole = previewRole && ['workspace_admin', 'team_admin', 'member'].includes(previewRole)
    ? previewRole
    : role;
  return {
    user,
    auth: {
      authorizationRevision: `smoke-${role}-${effectiveRole}`,
      role: effectiveRole,
      roles: [effectiveRole],
      workspaceIds: effectiveRole === 'workspace_admin' ? [WORKSPACE_ID] : [],
      teamNames: effectiveRole === 'team_admin' ? ['Smoke Team'] : [],
      groupIds: [GROUP_ID],
      managedGroupIds: effectiveRole === 'team_admin' ? [GROUP_ID] : [],
      groupUserIds: { [GROUP_ID]: [member.userId] },
      userIds: [member.userId],
      isPreview: effectiveRole !== role,
      previewReadOnly: effectiveRole !== role,
    },
    capabilities: {
      ...capabilities(effectiveRole, canPreviewRoles),
      canPreviewRoles,
    },
  };
}

function projectionFixture(url: URL): DashboardProjection {
  const kind = (['month_end', 'year_end', 'term_end'].includes(url.searchParams.get('projectionHorizon') ?? '')
    ? url.searchParams.get('projectionHorizon')
    : 'month_end') as 'month_end' | 'year_end' | 'term_end';
  const endExclusive = {
    month_end: '2026-10-01T00:00:00.000Z',
    year_end: '2027-01-01T00:00:00.000Z',
    term_end: '2027-05-21T00:00:00.000Z',
  }[kind];
  const dayMs = 86_400_000;
  const paceStart = Date.parse('2026-08-08T00:00:00.000Z');
  const firstSpend = Date.parse('2026-08-27T00:00:00.000Z');
  const days = Array.from({ length: 28 }, (_, index) => {
    const timestamp = paceStart + index * dayMs;
    return {
      day: new Date(timestamp).toISOString().slice(0, 10),
      spendUsd: timestamp < firstSpend ? 0 : index - 18,
      complete: true,
    };
  });
  const historical = url.searchParams.get('rangeType') === 'custom';
  const actualPeriod = historical
    ? {
        start: `${url.searchParams.get('startDate') ?? '2026-09-01'}T00:00:00.000Z`,
        endExclusive: new Date(Date.parse(`${url.searchParams.get('endDate') ?? '2026-09-04'}T00:00:00.000Z`) + dayMs).toISOString(),
      }
    : {
        start: '2026-05-20T00:00:00.000Z',
        endExclusive: '2026-09-06T00:00:00.000Z',
      };
  return buildDashboardProjection({
    now: new Date('2026-09-05T12:00:00.000Z'),
    actualPeriod,
    target: {
      kind,
      start: '2026-05-20T00:00:00.000Z',
      endExclusive,
      verified: true,
    },
    days,
    budget: null,
    stale: false,
  }) as DashboardProjection;
}

function dashboardFixture(role: Role, url: URL, generation = 'generation-1') {
  const personal = role === 'member';
  const hasCompleteCoverage = (url.searchParams.get('rangeType') ?? 'billing') === 'billing';
  const viewScope = personal
    ? 'my'
    : (url.searchParams.get('viewScope') ?? 'managed');
  return {
    scope: {
      viewScope,
      label: personal ? 'My usage' : viewScope === 'all_authorized' ? 'All authorized usage' : 'Managed usage',
      workspaceIds: role === 'workspace_admin' || role === 'account' ? [WORKSPACE_ID] : [],
      groupIds: [GROUP_ID],
      isPersonal: personal,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    cardVariant: personal ? 'personal_usage' : 'usage_analysis',
    projection: projectionFixture(url),
    cards: [
      { key: personal ? 'your_agent_spend' : 'spend', label: personal ? 'Your Agent spend' : 'Spend', value: 10, unit: 'usd', qualification: null },
      { key: 'agent_spend', label: 'Agent spend', value: 8, unit: 'usd', qualification: null },
      { key: 'other_services', label: 'Other services', value: 2, unit: 'usd', qualification: null },
      { key: 'members_with_spend', label: 'Members with spend', value: 1, unit: 'count', qualification: 'Known members only' },
    ],
    trend: {
      granularity: url.searchParams.get('granularity') ?? 'day',
      mode: url.searchParams.get('trendMode') ?? 'period',
      buckets: [
        { start: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-02T00:00:00.000Z', spendUsd: 10, valueUsd: 10, isPartial: false, isMissing: false },
        { start: '2026-09-02T00:00:00.000Z', endExclusive: '2026-09-03T00:00:00.000Z', spendUsd: null, valueUsd: null, isPartial: true, isMissing: true },
      ],
    },
    breakdown: [{
      id: `group:${WORKSPACE_ID}:${GROUP_ID}`,
      label: 'Smoke Team',
      spendUsd: 10,
      kind: 'group',
      drillThrough: `/spend?tab=groups&viewScope=${viewScope}&rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&search=Smoke+Team`,
    }],
    accounting: {
      eligibleSpendUsd: 10,
      grossSpendUsd: 12,
      internalExcludedUsd: 2,
      unbudgetedUsd: 0,
      unattributedUsd: 0,
      reconciliationUsd: 0,
      agentSpendUsd: 8,
      otherServicesUsd: 2,
    },
    insights: {
      previousPeriodSpendUsd: 8,
      changePercent: 25,
      activeUsers: 2,
      activeDays: 3,
      projectCount: 2,
      avgSpendPerActiveUserUsd: 5,
      busiestDay: { date: '2026-09-03T00:00:00.000Z', spendUsd: 6 },
      categories: [
        { key: 'agent', label: 'Agent', spendUsd: 8, percent: 80, activeUsers: 2 },
        { key: 'other', label: 'Other', spendUsd: 2, percent: 20, activeUsers: 1 },
      ],
      monthly: [
        { start: '2026-04-01', endExclusive: '2026-05-01', spendUsd: null, agentSpendUsd: null, otherSpendUsd: null, isPartial: false, isMissing: true },
        { start: '2026-05-20', endExclusive: '2026-06-01', spendUsd: 0, agentSpendUsd: 0, otherSpendUsd: 0, isPartial: true, isMissing: false },
        { start: '2026-06-01', endExclusive: '2026-07-01', spendUsd: 6, agentSpendUsd: 5, otherSpendUsd: 1, isPartial: false, isMissing: false },
        { start: '2026-07-01', endExclusive: '2026-08-01', spendUsd: 7, agentSpendUsd: 5, otherSpendUsd: 2, isPartial: false, isMissing: false },
        { start: '2026-08-01', endExclusive: '2026-09-01', spendUsd: 8, agentSpendUsd: 6, otherSpendUsd: 2, isPartial: false, isMissing: false },
        { start: '2026-09-01', endExclusive: '2026-09-05', spendUsd: 10, agentSpendUsd: 8, otherSpendUsd: 2, isPartial: true, isMissing: false },
      ],
      topSpenders: [
        { id: 'member-smoke', name: 'Smoke Member', spendUsd: 6 },
        { id: 'member-two', name: 'Second Member', spendUsd: 4 },
      ],
    },
    metadata: {
      generationId: generation,
      costBasis: 'allocation_eligible_committed',
      status: hasCompleteCoverage ? 'complete' : 'partial',
      dataAsOf: '2026-09-04T00:00:00.000Z',
      directoryDataAsOf: '2026-09-04T00:00:00.000Z',
      stale: !hasCompleteCoverage,
      coverage: {
        ratio: hasCompleteCoverage ? 1 : 0.75,
        requestedDays: 4,
        missingDays: hasCompleteCoverage ? [] : ['2026-09-02'],
        failedWorkspaceDays: [],
      },
      qualifications: hasCompleteCoverage
        ? []
        : ['Partial usage coverage; missing facts are not zero.'],
      limitObservation: {
        status: 'unavailable',
        observedAt: null,
        lastSuccessfulAt: null,
        lastAttemptAt: null,
        refreshStartedAt: null,
        generation: null,
        error: null,
      },
    },
  };
}

function spendFixture(view: 'pools' | 'groups' | 'people' | 'projects', url: URL) {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  const totalRows = 125;
  const kind = view === 'pools' ? 'pool' : view === 'groups' ? 'group' : view === 'people' ? 'person' : 'project';
  const start = (page - 1) * pageSize;
  const rows = Array.from({ length: Math.min(pageSize, Math.max(0, totalRows - start)) }, (_, index) => {
    const ordinal = start + index + 1;
    return {
      id: kind === 'group'
        ? `group:${WORKSPACE_ID}:${ordinal === 1 ? GROUP_ID : `group-${ordinal}`}`
        : `${kind}:${WORKSPACE_ID}:${ordinal}`,
      kind,
      name: ordinal === 1 ? 'Smoke Team' : `${view.slice(0, -1)} ${ordinal}`,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Smoke Workspace',
      spendUsd: ordinal === 1 ? 10 : ordinal,
      agentSpendUsd: ordinal === 1 ? 8 : ordinal,
      otherServicesUsd: ordinal === 1 ? 2 : 0,
      allocationUsd: view === 'projects' ? null : 100,
      remainingUsd: view === 'projects' ? null : 90,
      percentUsed: view === 'projects' ? null : 10,
      status: view === 'pools' ? 'shared' : view === 'people' ? 'unavailable' : 'budgeted',
      memberCount: view === 'groups' ? 1 : null,
      ownerName: view === 'projects' ? 'Smoke Member' : null,
      limitState: view === 'people' ? 'unavailable' : 'not_applicable',
      limitObservationStatus: view === 'people' ? 'unavailable' : 'not_applicable',
      sharedPool: view === 'pools' && ordinal === 1,
    };
  });
  return {
    view,
    scope: {
      viewScope: url.searchParams.get('viewScope') ?? 'managed',
      label: 'Managed usage',
      workspaceIds: [WORKSPACE_ID],
      groupIds: [GROUP_ID],
      isPersonal: false,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    rows,
    page,
    pageSize,
    totalRows,
    filteredRows: totalRows,
    totals: {
      spendUsd: 7875,
      agentSpendUsd: 7873,
      otherServicesUsd: 2,
      allocationUsd: view === 'projects' ? 0 : 12500,
      internalExcludedUsd: 2,
      unbudgetedUsd: 0,
      unattributedUsd: 0,
      reconciliationUsd: 0,
    },
    facets: {
      statuses: { budgeted: 124, unavailable: 1 },
      workspaces: [
        { id: WORKSPACE_ID, name: 'Smoke Workspace', count: totalRows },
        { id: 'workspace-secondary', name: 'Secondary Workspace', count: 0 },
      ],
    },
    metadata: dashboardFixture('account', url).metadata,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function groupDetailFixture(groupId: string) {
  const role = groupId.includes('admin')
    ? 'admin'
    : groupId.includes('billing')
      ? 'billing'
      : 'member';
  return {
    group: {
      ...group,
      groupId,
      name: `Smoke Team - ${role}`,
      role,
    },
    members: [{ ...member, role }],
    membersSpendUsd: 10,
    unattributedSpendUsd: 0,
    usageHealth,
    rangeLabel: 'September 2026',
  };
}

function reportingDetailFixture(
  groupIds: string[],
  url = new URL('http://fixture.test/?rangeType=billing'),
) {
  const groups = groupIds.map((groupId) => groupDetailFixture(groupId).group);
  const reporting = dashboardFixture('account', url);
  return {
    kind: groupIds.length === 1 ? 'group' : 'family',
    sourceGroups: groups.map(({ groupId, workspaceId, workspaceName, role }) => ({
      groupId, workspaceId, workspaceName, role,
    })),
    headline: {
      familyKey: FAMILY_KEY,
      familyName: 'Smoke Team',
      spendUsd: 10,
      agentSpendUsd: 10,
      otherServicesUsd: 0,
      allocationUsd: groupIds.length === 1 ? 100 : null,
      remainingUsd: groupIds.length === 1 ? 90 : null,
      percentUsed: groupIds.length === 1 ? 10 : null,
      memberCount: 1,
      membersSpendUsd: 10,
      unattributedSpendUsd: 0,
      isComplete: true,
    },
    groups: groups.map((item) => ({
      groupId: item.groupId,
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName,
      name: item.name,
      familyKey: item.familyKey,
      familyName: item.familyName,
      role: item.role,
      isLegacy: item.isLegacy,
      memberCount: item.memberCount,
      spendUsd: 10,
      agentSpendUsd: 10,
      otherServicesUsd: 0,
      allocationUsd: 100,
      remainingUsd: 90,
      percentUsed: 10,
      sharedPool: false,
    })),
    members: [{
      workspaceId: WORKSPACE_ID,
      userId: member.userId,
      username: member.username,
      email: member.email,
      name: member.name,
      role: 'member',
      isDisabled: false,
      isInternal: false,
      groupIds,
      spendUsd: 10,
      agentSpendUsd: 10,
      otherServicesUsd: 0,
      currentCycleAgentSpendUsd: 10,
      limitUsd: 100,
      remainingUsd: 90,
      percentUsed: 10,
      limitState: 'explicit',
      limitObservationStatus: 'complete',
    }],
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-10-01T00:00:00.000Z',
      timezone: 'UTC',
      label: 'September 2026',
    },
    metadata: reporting.metadata,
  };
}

type DrilldownObservation = {
  requests: string[];
  decodedResponseBytes: number;
};

async function mockMeasuredDrilldownFixture(
  page: Page,
  observation: DrilldownObservation,
  projectGate?: Promise<void>,
) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const reportingMatch = path.match(/^\/api\/reporting\/details\/([^/]+)$/);
    const detailMatch = path.match(/^\/api\/groups\/([^/]+)$/);
    const isProjects = /^\/api\/(?:groups\/[^/]+|clusters\/[^/]+)\/projects$/.test(path);
    const isHeadline = /^\/api\/clusters\/[^/]+\/headline$/.test(path);
    const isWorkspaceMembers = /^\/api\/directory\/workspaces\/[^/]+\/members$/.test(path);
    const isAudits = /^\/api\/directory\/workspaces\/[^/]+\/usage-limit-audits$/.test(path);
    if (!reportingMatch && !detailMatch && !isProjects && !isHeadline && !isWorkspaceMembers && !isAudits) {
      await route.fallback();
      return;
    }

    observation.requests.push(`${route.request().method()} ${path}${url.search}`);
    if (isProjects && projectGate) await projectGate;
    let body: unknown;
    if (reportingMatch) {
      body = reportingDetailFixture(
        decodeURIComponent(reportingMatch[1]).split(',').filter(Boolean),
      );
    } else if (detailMatch) {
      body = groupDetailFixture(decodeURIComponent(detailMatch[1]));
    } else if (isHeadline) {
      body = {
        familyName: 'Smoke Team',
        roles: ['admin', 'billing', 'member'],
        spendUsd: 10,
        usageHealth,
      };
    } else if (isWorkspaceMembers) {
      body = {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        billingPeriod: 'current',
        connector: { status: 'available', canWrite: true, error: null },
        limitObservation: {
          status: 'complete',
          observedAt: 1788480000000,
          lastSuccessfulAt: 1788480000000,
          lastAttemptAt: 1788480000000,
          refreshStartedAt: null,
          generation: 'limits-generation-1',
          error: null,
        },
        directoryFreshness: {
          dataAsOf: '2026-09-04T00:00:00.000Z',
          isStale: false,
          isRefreshing: false,
        },
        members: [{
          ...member,
          isInternal: false,
          budgetUsd: 100,
          effectiveLimitUsd: 100,
          limitState: 'explicit',
          usageUsd: 10,
          remainingUsd: 90,
          percentUsed: 10,
          blocked: false,
          effectiveBaselineUsd: null,
          baselineSourceType: null,
          baselineSourceId: null,
          isHandSetOverride: true,
        }],
      };
    } else if (isAudits) {
      body = [];
    } else {
      body = { projects: [], unattributedSpendUsd: 0, usageHealth, titlesComplete: true };
    }
    const encoded = JSON.stringify(body);
    observation.decodedResponseBytes += Buffer.byteLength(encoded);
    await route.fulfill({ status: 200, contentType: 'application/json', body: encoded });
  });
}

async function mockApi(
  page: Page,
  role: Role,
  canPreviewRoles = false,
  previewHeaders: Array<string | null> = [],
  observedRequests: string[] = [],
  rejectPreview = false,
  limitRequests: LimitRequest[] = [],
  emailTestAvailable = false,
) {
  let dashboardGeneration = 0;
  let preparedLimitUserIds = ['101'];
  let limitOperation = limitOperationFixture('prepared', preparedLimitUserIds);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    observedRequests.push(`${route.request().method()} ${path}${url.search}`);
    if (path === '/api/auth/user') {
      if (role === 'unavailable') {
        return json(route, { error: 'Authorization temporarily unavailable' }, 503);
      }
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      previewHeaders.push(previewAs);
      if (rejectPreview && previewAs) {
        return json(route, { error: 'Preview target is no longer available' }, 400);
      }
      const envelope = authEnvelope(role, canPreviewRoles, previewAs);
      if (emailTestAvailable) envelope.capabilities.canSendTestEmail = true;
      return json(route, envelope);
    }
    if (path === '/api/dashboard') {
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      const effectiveRole = previewAs?.startsWith('member:')
        ? 'member'
        : previewAs?.startsWith('team_admin:')
          ? 'team_admin'
          : previewAs?.startsWith('workspace_admin:')
            ? 'workspace_admin'
            : role;
      dashboardGeneration += 1;
      return json(route, dashboardFixture(effectiveRole, url, `generation-${dashboardGeneration}`));
    }
    if (path === '/api/org-insights') {
      return json(route, orgBudgetOverviewFixture());
    }
    const spendMatch = path.match(/^\/api\/spend\/(pools|groups|people|projects)$/);
    if (spendMatch) {
      return json(route, spendFixture(spendMatch[1] as 'pools' | 'groups' | 'people' | 'projects', url));
    }
    if (/^\/api\/spend\/(pools|groups|people|projects)\.csv$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: { 'Content-Disposition': 'attachment; filename="spend.csv"' },
        body: '"name","spend_usd"\r\n"Smoke Team","10.00"\r\n',
      });
    }
    if (path === '/api/groups') {
      return json(route, {
        groups: [group],
        usageHealth,
        billingPeriodLabel: 'September 2026',
        unattributedProjectSpendUsd: 0,
        teamRawSpend: { 'Smoke Team': { spendUsd: 10 } },
        workspaceTeamRawSpend: [{ workspaceId: WORKSPACE_ID, teamName: 'Smoke Team', spendUsd: 10 }],
        teamBudgets: { 'Smoke Team': 100 },
      });
    }
    if (path === '/api/users/activity') {
      return json(route, {
        usageHealth,
        users: [{
          userId: member.userId,
          username: member.username,
          email: member.email,
          teamName: 'Smoke Team',
          groupName: group.name,
          spendUsd: 10,
          aiSpendUsd: 10,
          nonAiSpendUsd: 0,
          workspaceRole: 'member',
        }],
      });
    }
    if (path === '/api/teams/budgets') {
      return json(route, { budgets: [{ teamName: 'Smoke Team', amountUsd: 100, workspaceIds: [WORKSPACE_ID] }] });
    }
    if (path === '/api/directory/workspaces') {
      return json(route, [{ workspaceId: WORKSPACE_ID, workspaceName: 'Smoke Workspace', memberCount: 1 }]);
    }
    if (path === '/api/directory/members') {
      return json(route, [{
        userId: member.userId,
        username: member.username,
        name: member.name,
        email: member.email,
        isAccountAdmin: false,
        workspaces: [{
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Smoke Workspace',
          role: 'member',
          isDisabled: false,
          spendUsd: 10,
          reAttributedSpendUsd: 0,
        }],
      }]);
    }
    if (path === '/api/directory/groups') {
      return json(route, [{
        groupId: GROUP_ID,
        groupName: group.name,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        familyKey: FAMILY_KEY,
        familyName: 'Smoke Team',
        role: 'member',
        isLegacy: false,
        teamName: 'Smoke Team',
      }]);
    }
    if (path === '/api/workspace-admins') {
      return json(route, [{
        groupId: GROUP_ID,
        groupName: group.name,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        familyKey: FAMILY_KEY,
        familyName: 'Smoke Team',
        role: 'member',
        isLegacy: false,
        teamName: 'Smoke Team',
        admins: [{ userId: 'admin-smoke', username: 'smoke-admin', email: null, name: null }],
      }]);
    }
    if (path === '/api/alerts') {
      const beforeId = Number(url.searchParams.get('beforeId'));
      const newest = Number.isSafeInteger(beforeId) && beforeId > 0 ? beforeId - 1 : 205;
      const count = Math.min(100, Math.max(0, newest));
      return json(route, Array.from({ length: count }, (_, index) => alertFixture(newest - index)));
    }
    if (path === '/api/app-admins' || path === '/api/admins') return json(route, []);
    if (path === '/api/settings/email') {
      return json(route, { automatedEmailEnabled: false, updatedAt: '2026-09-04T00:00:00.000Z' });
    }
    if (path === '/api/status') {
      return json(route, {
        enterpriseApiConfigured: true,
        enterpriseApiOk: true,
        enterpriseApiError: null,
        emailConfigured: emailTestAvailable,
        automatedEmailEnabled: false,
        checkerIntervalMinutes: 15,
        lastCheckAt: null,
        lastSuccessfulEvaluationAt: null,
        lastEvaluatedDataAsOf: null,
        lastCheckerAttemptAt: null,
        lastCheckerSkipReason: null,
        billingPeriodStart: '2026-09-01T00:00:00.000Z',
        billingPeriodEnd: '2026-10-01T00:00:00.000Z',
        billingPeriodLabel: 'September 2026',
        billingPeriodFetchedAt: '2026-09-04T00:00:00.000Z',
        billingPeriodFresh: true,
        billingPeriodFallback: false,
        billingPeriodDiffersFromReportingCutoff: false,
        reportingCutoff: '2026-09-01T00:00:00.000Z',
        reportingRangeStart: '2026-09-01T00:00:00.000Z',
        reportingRangeEnd: '2026-09-05T00:00:00.000Z',
        reportingRangeLabel: 'September 1–4, 2026',
        recentRuns: [],
        remainingBackfillCount: 0,
        currentMonthReconciliation: [],
        directoryDataAsOf: '2026-09-04T00:00:00.000Z',
        directoryAgeMs: 0,
        projectEnrichment: {
          totalWorkspaces: 1, successfulWorkspaces: 1,
          failedWorkspaces: 0, pendingWorkspaces: 0,
          lastSuccessfulAt: '2026-09-04T00:00:00.000Z',
        },
        rateLimitTelemetry: { peakRequestsPerMinute: 0, lowestRateLimitRemaining: null },
      });
    }
    if (path === `/api/limits/workspaces/${WORKSPACE_ID}`) {
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      return json(route, limitWorkspaceFixture(!previewAs));
    }
    if (path === `/api/directory/workspaces/${WORKSPACE_ID}/limit-policies`) {
      return json(route, { workspaceId: WORKSPACE_ID, defaultAmountUsd: null, groups: [] });
    }
    if (path === '/api/limits/operations/prepare' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      limitRequests.push({ method: 'POST', path, body });
      preparedLimitUserIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
      limitOperation = limitOperationFixture('prepared', preparedLimitUserIds);
      return json(route, limitOperation);
    }
    if (path === `/api/limits/operations/${LIMIT_OPERATION_ID}/commit` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      limitRequests.push({ method: 'POST', path, body });
      limitOperation = limitOperationFixture('completed', preparedLimitUserIds);
      return json(route, limitOperation, 202);
    }
    if (path === `/api/limits/operations/${LIMIT_OPERATION_ID}/retry` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      limitRequests.push({ method: 'POST', path, body });
      limitOperation = limitOperationFixture('completed', preparedLimitUserIds, true);
      return json(route, limitOperation, 202);
    }
    if (path === `/api/limits/operations/${LIMIT_OPERATION_ID}`) {
      return json(route, limitOperation);
    }
    if (path === '/api/admin/team-budgets/history') {
      return json(route, {
        teams: [{
          teamName: 'Smoke Team',
          originalAmountUsd: 100,
          effectiveAmountUsd: 100,
          annualAllocationUsd: 100,
          monthlyLimitUsd: 8.33,
          monthlyLimitSource: 'derived',
          isHidden: false,
          adjustments: [],
        }],
        issues: [],
      });
    }
    if (path === '/api/admin/team-budgets/audit') return json(route, { changes: [] });
    if (path === '/api/admin/funding-groups') {
      return json(route, fundingInventory('funding-smoke-r1'));
    }
    if (path === '/api/admin/funding-groups/audit') return json(route, { changes: [], nextBeforeId: null });
    if (/^\/api\/directory\/workspaces\/[^/]+\/members$/.test(path)) {
      return json(route, {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        billingPeriod: 'current',
        connector: { status: 'available', canWrite: true, error: null },
        limitObservation: {
          status: 'complete',
          observedAt: 1788480000000,
          lastSuccessfulAt: 1788480000000,
          lastAttemptAt: 1788480000000,
          refreshStartedAt: null,
          generation: 'limits-generation-1',
          error: null,
        },
        directoryFreshness: {
          dataAsOf: '2026-09-04T00:00:00.000Z',
          isStale: false,
          isRefreshing: false,
        },
        members: [{
          userId: member.userId,
          username: member.username,
          name: member.name,
          email: member.email,
          isInternal: false,
          role: 'member',
          isDisabled: false,
          budgetUsd: 100,
          effectiveLimitUsd: 100,
          limitState: 'explicit',
          usageUsd: 10,
          remainingUsd: 90,
          percentUsed: 10,
          blocked: false,
          effectiveBaselineUsd: null,
          baselineSourceType: null,
          baselineSourceId: null,
          isHandSetOverride: true,
        }],
      });
    }
    if (/^\/api\/directory\/workspaces\/[^/]+\/usage-limit-audits$/.test(path)) return json(route, []);
    const reportingMatch = path.match(/^\/api\/reporting\/details\/([^/]+)$/);
    if (reportingMatch) {
      if (role === 'signed_out' || role === 'denied') {
        return json(route, { error: 'Forbidden' }, 403);
      }
      const groupIds = [...new Set(decodeURIComponent(reportingMatch[1])
        .split(',').map((id) => id.trim()).filter(Boolean))];
      if (!groupIds.length || groupIds.some((id) => id !== GROUP_ID)) {
        return json(route, { error: 'Reporting detail not found' }, 404);
      }
      return json(route, reportingDetailFixture(groupIds, url));
    }
    const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      if (groupMatch[1] !== GROUP_ID) return json(route, { error: 'Not found' }, 404);
      return json(route, {
        group,
        members: [member],
        membersSpendUsd: 10,
        unattributedSpendUsd: 0,
        usageHealth,
        rangeLabel: 'September 2026',
      });
    }
    const groupProjectsMatch = path.match(/^\/api\/groups\/([^/]+)\/projects$/);
    if (groupProjectsMatch) {
      if (groupProjectsMatch[1] !== GROUP_ID) return json(route, { error: 'Not found' }, 404);
      return json(route, { projects: [], unattributedSpendUsd: 0, usageHealth, titlesComplete: true });
    }
    if (/^\/api\/clusters\/[^/]+\/projects$/.test(path)) {
      return path.includes(GROUP_ID)
        ? json(route, { projects: [], unattributedSpendUsd: 0, usageHealth, titlesComplete: true })
        : json(route, { error: 'Not found' }, 404);
    }
    if (/^\/api\/clusters\/[^/]+\/headline$/.test(path)) {
      return path.includes(GROUP_ID)
        ? json(route, { spendUsd: 10, usageHealth })
        : json(route, { error: 'Not found' }, 404);
    }
    return json(route, {});
  });
}

function watchBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

async function expectReady(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading page' })).toHaveCount(0);
}

async function openCompactMenu(page: Page, name: 'Management' | 'Support' | 'Account') {
  const testId = `button-${name.toLowerCase()}-menu`;
  const trigger = page.locator(
    `[data-testid="${testId}"], button[aria-label*="${name}" i], button:has-text("${name}")`,
  ).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
}

async function revealAccountControl(page: Page, testId: string) {
  const control = page.locator(`[data-testid="${testId}"]`);
  if (!await control.isVisible()) await openCompactMenu(page, 'Account');
  await expect(control).toBeVisible();
  return control;
}

async function expectAccountRole(page: Page, role: string) {
  await openCompactMenu(page, 'Account');
  await expect(page.getByRole('dialog').getByText(role, { exact: true })).toBeVisible();
}

async function openMobileSheet(page: Page) {
  const trigger = page.getByTestId('button-open-navigation');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Replit Budget Monitor' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

async function expectOnscreen(page: Page, selector: string) {
  const target = page.locator(selector).first();
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectTouchTarget(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function expectPhoneInputFont(page: Page, selector: string) {
  const size = await page.locator(selector).first().evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
}

test.describe('authenticated account route smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, 'account');
  });

  test('opens every navigation page by link and hard refresh without browser failures', async ({ page }) => {
  const failures = watchBrowserFailures(page);
    const primaryRoutes = [
      ['nav-org-insights', '/org-insights', 'h1:text-is("Organization Budget Overview")'],
      ['nav-limits', '/limits', 'h1:text-is("Limits")'],
      ['nav-help', '/help', 'h1:text-is("Use Budget Monitor")'],
    ] as const;
    const menuRoutes = [
      ['Management', 'nav-alerts', '/alerts', '[data-testid="text-alerts-title"]'],
      ['Management', 'nav-settings', '/settings', '[data-testid="text-settings-title"]'],
      ['Management', 'nav-access', '/access', 'h1:text-is("Access")'],
    ] as const;

    await page.goto('/');
    await expect(page).toHaveURL(/\/org-insights$/);
    await expect(page.getByTestId('nav-help')).toHaveAccessibleName('Help and contact');
    await expect(page.getByTestId('nav-spend')).toHaveCount(0);
    await expectReady(page, 'h1:text-is("Organization Budget Overview")');
    for (const [navId, path, ready] of primaryRoutes) {
      await page.locator(`[data-testid="${navId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`));
      await expectReady(page, ready);
      await page.reload();
      await expectReady(page, ready);
    }
    for (const [menu, navId, path, ready] of menuRoutes) {
      await openCompactMenu(page, menu);
      await page.locator(`[data-testid="${navId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expectReady(page, ready);
      await page.reload();
      await expectReady(page, ready);
    }
    expect(failures).toEqual([]);
  });

  test('capability-derived navigation has one landing item on desktop and mobile', async ({ page }) => {
    await page.goto('/?rangeType=billing&viewScope=my');
    await expect(page).toHaveURL(/\/org-insights$/);
    await expect(page.locator('header nav a')).toHaveText([
      'Org Insights', 'My Team', 'My Projects', 'Budget allocations', 'Limits',
    ]);
    await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
    await expect(page.getByTestId('link-overview-brand')).toHaveAttribute('href', '/org-insights');
    await page.getByTestId('nav-my-projects').click();
    await expect(page).toHaveURL(/\/spend\?[^#]*tab=projects/);
    expect(new URL(page.url()).searchParams.get('viewScope')).toBe('my');
    expect(new URL(page.url()).searchParams.has('rangeType')).toBe(false);
    await expect(page.getByRole('heading', { name: 'My Projects', exact: true })).toBeVisible();
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByTestId('nav-allocations')).toBeVisible();
    await expect(page.getByTestId('nav-limits')).toBeVisible();
    await openCompactMenu(page, 'Management');
    await expect(page.getByTestId('nav-spend')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?rangeType=billing&viewScope=my');
    await expect(page).toHaveURL(/\/org-insights$/);
    await expect(page.getByTestId('link-overview-brand-mobile')).toHaveAttribute('href', '/org-insights');
    const sheet = await openMobileSheet(page);
    expect((await sheet.locator('a[data-testid^="nav-"]').allTextContents()).slice(0, 5)).toEqual([
      'Org Insights', 'My Team', 'My Projects', 'Budget allocations', 'Limits',
    ]);
    await sheet.getByTestId('nav-my-projects').click();
    await expect(page).toHaveURL(/\/spend\?[^#]*tab=projects/);
    await expect(page.getByRole('heading', { name: 'My Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('nav-my-team')).toBeVisible();
    await page.getByTestId('nav-my-team').click();
    await expect(page).toHaveURL(/\/my-team$/);
    await expect(page.getByRole('heading', { name: 'My Team', exact: true })).toBeVisible();
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);

    await page.unrouteAll();
    await mockApi(page, 'member');
    await page.goto('/');
    await expect(page.getByTestId('nav-dashboard').filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId('nav-org-insights')).toHaveCount(0);
  });

  test('loads discovered dynamic routes and gives invalid URLs terminal fallbacks', async ({ page }) => {
  const failures = watchBrowserFailures(page);
    await page.goto('/');
    const discoveredGroupId = await page.evaluate(async () => {
      const response = await fetch('/api/groups');
      const body = await response.json();
      return body.groups[0].groupId as string;
    });

    await page.goto(`/groups/${discoveredGroupId}`);
    await expectReady(page, '[data-testid="page-group-detail"]');
    await page.reload();
    await expectReady(page, '[data-testid="page-group-detail"]');

    await page.goto(`/clusters?ids=${discoveredGroupId}&name=Smoke%20Team`);
    await expectReady(page, '[data-testid="page-cluster-detail"]');
    await page.reload();
    await expectReady(page, '[data-testid="page-cluster-detail"]');
    expect(failures).toEqual([]);

    await page.goto('/groups/unavailable');
    await expectReady(page, '[data-testid="group-detail-unavailable"]');
    await page.goto('/clusters?ids=unavailable&name=Unavailable');
    await expectReady(page, '[data-testid="cluster-detail-unavailable"]');
    await page.goto(`/clusters?ids=${discoveredGroupId},unavailable&name=Partial`);
    await expectReady(page, '[data-testid="cluster-detail-unavailable"]');
    expect(failures.every((failure) =>
      failure === 'console: Failed to load resource: the server responded with a status of 404 (Not Found)'
    )).toBe(true);
  });

  test('ordinary account admins do not receive builder preview controls', async ({ page }) => {
    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');
    await openCompactMenu(page, 'Account');
    await expect(page.locator('[data-testid="rbac-preview-control"]')).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('Account admin', { exact: true })).toBeVisible();
  });
});

test('builder capability enters and resets a scoped preview without losing real access', async ({ page }) => {
  const previewHeaders: Array<string | null> = [];
  const failures = watchBrowserFailures(page);
  await mockApi(page, 'account', true, previewHeaders);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await (await revealAccountControl(page, 'select-rbac-preview')).click();
  await page.getByLabel('Members').getByText('Smoke Member', { exact: true }).click();
  await expect(page.getByTestId('active-preview-banner')).toContainText('Read-only');
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
  await page.getByTestId('button-reset-rbac-preview').click();
  await expect(page.getByTestId('active-preview-banner')).toHaveCount(0);
  await openCompactMenu(page, 'Account');
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  expect(previewHeaders.some((value) => value?.startsWith('member:'))).toBe(true);
  expect(failures).toEqual([]);
});

test('denied users see only the access-denied gate', async ({ page }) => {
  const failures = watchBrowserFailures(page);
  await mockApi(page, 'denied');
  await page.goto('/workspace-admins');
  await expectReady(page, '[data-testid="auth-denied"]');
  await expect(page.locator('[data-testid^="nav-"]')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('signed-out users see only the login gate after direct refresh', async ({ page }) => {
  const failures = watchBrowserFailures(page);
  await mockApi(page, 'signed_out');
  await page.goto('/workspace-admins');
  await expectReady(page, '[data-testid="auth-signed-out"]');
  await expect(page.getByRole('heading', { name: 'Replit Budget Monitor' })).toBeVisible();
  await page.reload();
  await expectReady(page, '[data-testid="auth-signed-out"]');
  expect(failures).toEqual([]);
});

test('authorization unavailable never paints protected data and remains retryable', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', true, [], observedRequests);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  expect(observedRequests.filter((request) => request.includes('/api/dashboard?'))).toHaveLength(1);
  expect(observedRequests.some((request) => request.includes('/api/spend/'))).toBe(false);

  observedRequests.length = 0;
  await page.goto('/spend?tab=groups');
  await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();
  expect(observedRequests.filter((request) => request.includes('/api/spend/groups?'))).toHaveLength(1);
  expect(observedRequests.some((request) => /\/api\/spend\/(pools|people|projects)\?/.test(request))).toBe(false);
});

test('forecast history keeps canonical horizons, inclusive dates, and reporting context on desktop and mobile', async ({ page }) => {
  const observedRequests: string[] = [];
  const failures = watchBrowserFailures(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/?rangeType=full-term&viewScope=all_authorized');

  const assertReportingContext = async () => {
    const params = new URL(page.url()).searchParams;
    expect(params.get('rangeType')).toBe('full-term');
    expect(params.get('viewScope')).toBe('all_authorized');
  };
  const assertInclusiveChartValue = async (date: string, actual?: string) => {
    const details = page.getByTestId('projection-method');
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await details.locator('summary').click();
    }
    const row = page.getByRole('row', { name: new RegExp(date) });
    await expect(row).toBeAttached();
    if (actual) await expect(row).toContainText(actual);
  };
  const chooseHorizon = async (name: 'End of month' | 'End of year' | 'End of term') => {
    await page.getByTestId('select-projection-horizon').click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByTestId('select-projection-horizon')).toContainText(name);
    await assertReportingContext();
    const targetDate = { 'End of month': 'Sep 30, 2026', 'End of year': 'Dec 31, 2026', 'End of term': 'May 20, 2027' }[name];
    await expect(page.getByTestId('projection-method').getByText('Forecast Through', { exact: true }).locator('..')).toContainText(targetDate);
  };

  await expect(page.getByTestId('text-projected-total')).toContainText('$');
  await expect(page.getByText('Projected Known', { exact: true })).toBeVisible();
  await page.getByTestId('projection-method').locator('summary').click();
  await expect(page.getByText('History', { exact: true })).toBeVisible();
  await expect(page.getByText('Forecast Through', { exact: true })).toBeVisible();
  await expect(page.getByTestId('input-planning-end')).toHaveCount(0);
  await expect(page.getByText(/billing cycle/i)).toHaveCount(0);
  await expect(page.getByText(/chart options/i)).toHaveCount(0);
  const chart = page.getByTestId('container-dashboard-projection');
  await expect(chart).toBeVisible();
  await expect(chart.locator('.recharts-bar-rectangle').first()).toBeAttached();
  await page.getByTestId('select-projection-horizon').click();
  const canonicalOptions = page.getByRole('option');
  await expect(canonicalOptions).toHaveCount(3);
  await expect(canonicalOptions.nth(0)).toHaveText('End of month');
  await expect(canonicalOptions.nth(1)).toHaveText('End of year');
  await expect(canonicalOptions.nth(2)).toHaveText('End of term');
  await page.keyboard.press('Escape');

  await assertInclusiveChartValue('May 20, 2026', '$0.00');
  await assertInclusiveChartValue('Aug 27, 2026', '$1.00');
  await assertInclusiveChartValue('Sep 4, 2026', '$45.00');
  await assertInclusiveChartValue('Sep 30, 2026');
  await expect(page.getByRole('row', { name: /Oct 1, 2026/ })).toHaveCount(0);

  await chooseHorizon('End of year');
  await assertInclusiveChartValue('Dec 31, 2026');
  await chooseHorizon('End of term');
  await assertInclusiveChartValue('May 20, 2027');
  await chooseHorizon('End of month');
  await assertInclusiveChartValue('Sep 30, 2026');
  await page.goBack();
  await expect(page.getByTestId('select-projection-horizon')).toContainText('End of term');
  await assertReportingContext();
  await expect(page.getByTestId('projection-method').getByText('Forecast Through', { exact: true }).locator('..')).toContainText('May 20, 2027');
  await assertInclusiveChartValue('May 20, 2027');
  await expect(chart.locator('.recharts-bar-rectangle').first()).toBeAttached();
  await page.screenshot({ path: 'e2e/evidence/forecast/desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(chart).toBeVisible();
  await expect(chart.locator('.recharts-bar-rectangle').first()).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByTestId('select-projection-horizon').click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await expect(page.getByRole('option', { name: 'End of month', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'End of year', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'End of term', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await assertReportingContext();
  await assertInclusiveChartValue('Aug 27, 2026', '$1.00');
  await assertInclusiveChartValue('May 20, 2027');
  await page.screenshot({ path: 'e2e/evidence/forecast/mobile.png', fullPage: true });
  expect(observedRequests.filter((request) => request.includes('/api/dashboard?')).every((request) =>
    request.includes('rangeType=full-term') && request.includes('viewScope=all_authorized'))).toBe(true);
  expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  expect(failures).toEqual([]);
});

test('projection keeps partial, unknown, stale, and historical comparisons safe', async ({ page }) => {
  await mockApi(page, 'member');
  let stale = false;
  await page.route('**/api/dashboard?*', async (route) => {
    const url = new URL(route.request().url());
    const fixture = dashboardFixture('member', url);
    fixture.projection.stale = stale;
    await json(route, fixture);
  });
  await page.goto('/?rangeType=billing');
  await expect(page.getByText('Projected Known', { exact: true })).toBeVisible();
  await expect(page.getByTestId('text-projected-total')).not.toHaveText('—');
  await page.getByTestId('projection-method').locator('summary').click();
  await expect(page.getByText(/no matching budget applies/i)).toBeVisible();
  await expect(page.getByText(/projected remaining|projected overage|projected budget/i)).toHaveCount(0);
  await expect(page.locator('.budget-meter__projection--green')).toHaveCount(0);
  stale = true;
  await page.reload();
  await page.getByTestId('projection-method').locator('summary').click();
  await expect(page.getByText(/stale/i).first()).toBeVisible();
  await expect(page.locator('.budget-meter__projection--green')).toHaveCount(0);
});

test('dashboard and Spend keep one authorized billing period through drill-through and back', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/?rangeType=billing&viewScope=all_authorized');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await expect(page.locator('[data-testid="text-dashboard-scope"]')).toHaveText('Overview');
  await expect(page.locator('[data-testid="text-dashboard-period"]')).toContainText('All authorized usage');
  await expect(page.getByRole('combobox', { name: 'Reporting period' })).toContainText('Sep 1–4, 2026');
  await expect(page.locator('[data-testid="status-dashboard-partial"]')).toBeVisible();
  await expect(page.locator('[data-testid="status-dashboard-stale"]')).toBeVisible();
  await expect(page.getByText('Top budget groups by spend', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Understand what drove spend', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Explore Spend', { exact: true })).toHaveCount(0);
  await expect(page.getByText('What needs my attention?', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Reconciliation details', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Data details', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Partial usage coverage; missing facts are not zero.', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'e2e/evidence/overview/simplified-overview.png', fullPage: true });

  await page.goto('/spend?rangeType=billing&viewScope=all_authorized');
  await expect(page).toHaveURL(/\/spend\?/);
  await expect(page.getByRole('heading', { name: 'Spend', exact: true })).toBeVisible();
  const spendView = page.getByRole('combobox', { name: 'Spend view' });
  if (!(await spendView.textContent())?.includes('Groups')) {
    await spendView.click();
    await page.getByRole('option', { name: 'Groups' }).click();
  }
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();
  await page.locator('a').filter({ hasText: 'Explore' }).first().click();
  await expectReady(page, '[data-testid="page-group-detail"]');
  await page.goBack();
  await expect(page).toHaveURL(/\/spend\?/);
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();

  const dashboardRequest = observedRequests.find((request) => request.includes('/api/dashboard?'));
  expect(dashboardRequest).toContain('rangeType=billing');
  expect(dashboardRequest).toContain('viewScope=all_authorized');
  const spendRequest = observedRequests.find((request) => request.includes('/api/spend/groups?'));
  expect(spendRequest).toContain('rangeType=billing');
  expect(spendRequest).toContain('viewScope=all_authorized');
});

test('Settings preserves accounting while the reporting period refreshes', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/settings');
  await expectReady(page, '[data-testid="text-settings-title"]');
  await expect(page.locator('[data-testid="internal-spend-accounting"]')).toContainText('$12.00 gross');
  await expect(page.locator('[data-testid="internal-spend-accounting"]')).toContainText('$2.00 internal');
  await expect(page.locator('[data-testid="internal-spend-accounting"]')).toContainText('$10.00 eligible');

  const initialRequest = observedRequests.find((request) => request.includes('/api/dashboard?'));
  expect(initialRequest).toContain('rangeType=billing');
  expect(initialRequest).toContain('viewScope=all_authorized');
  expect(observedRequests.some((request) => request.includes('/api/summary'))).toBe(false);

  let releaseFullTermRequest!: () => void;
  const fullTermRequestBlocked = new Promise<void>((resolve) => {
    releaseFullTermRequest = resolve;
  });
  await page.route('**/api/dashboard?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('rangeType') !== 'full-term') {
      await route.fallback();
      return;
    }
    observedRequests.push(`GET ${url.pathname}${url.search}`);
    await fullTermRequestBlocked;
    await json(route, dashboardFixture('account', url, 'full-term-generation'));
  });

  await page.locator('button[role="combobox"]').filter({ hasText: 'Sep 1–4, 2026' }).click();
  await page.getByRole('option', { name: 'Full term' }).click();
  await expect(page.locator('[data-testid="internal-spend-accounting"]')).toContainText('$12.00 gross');
  await expect(page.locator('[data-testid="status-settings-accounting-refresh"]')).toContainText(
    'previous successful range remains visible',
  );
  releaseFullTermRequest();
  await expect(page.locator('[data-testid="status-settings-accounting-partial"]')).toBeVisible();
  await expect(page.locator('[data-testid="internal-spend-accounting"]')).toContainText(
    'Accounting is unavailable until usage for this reporting range is complete.',
  );

  const fullTermRequest = observedRequests.find((request) =>
    request.includes('/api/dashboard?') && request.includes('rangeType=full-term'));
  expect(fullTermRequest).toContain('viewScope=all_authorized');
});

test('closed preview controls and disabled Spend tabs issue no data requests', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', true, [], observedRequests);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  expect(observedRequests.filter((request) => request.includes('/api/dashboard?'))).toHaveLength(1);
  expect(observedRequests.some((request) => request.includes('/api/spend/'))).toBe(false);

  observedRequests.length = 0;
  await page.goto('/spend?tab=groups');
  await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();
  expect(observedRequests.filter((request) => request.includes('/api/spend/groups?'))).toHaveLength(1);
  expect(observedRequests.some((request) => /\/api\/spend\/(pools|people|projects)\?/.test(request))).toBe(false);
});

test('large Spend view supports paging, density, keyboard focus, and authorized CSV', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/spend?tab=groups&pageSize=100&viewScope=managed');
  await expect(page.getByText('Showing 1–100 of 125 results')).toBeVisible();
  await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '126');
  await page.getByRole('searchbox', { name: 'Search groups' }).focus();
  await expect(page.getByRole('searchbox', { name: 'Search groups' })).toBeFocused();
  await page.getByRole('button', { name: 'Table options' }).click();
  await page.getByRole('menuitem', { name: 'Compact' }).click();
  await expect(page).toHaveURL(/density=compact/);

  const csvRequest = page.waitForRequest((request) =>
    request.url().includes('/api/spend/groups.csv'));
  await page.getByRole('button', { name: 'Table options' }).click();
  await page.getByRole('menuitem', { name: 'Export filtered CSV' }).click();
  const request = await csvRequest;
  const exportUrl = new URL(request.url());
  expect(exportUrl.searchParams.get('pageSize')).toBeNull();
  expect(exportUrl.searchParams.get('page')).toBeNull();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});

test('Spend view dropdown and contextual filters preserve deep links and reset paging', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/spend?tab=groups&page=3&pageSize=25&viewScope=managed');
  await expect(page.getByText('Showing 51–75 of 125 results')).toBeVisible();

  await page.getByRole('combobox', { name: 'Spend view' }).click();
  await page.getByRole('option', { name: 'Members' }).click();
  await expect(page).toHaveURL(/tab=people/);
  await expect(page).not.toHaveURL(/page=3/);
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();

  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('#spend-workspace-filter').click();
  await page.getByRole('option', { name: /Smoke Workspace/ }).click();
  await expect(page).toHaveURL(new RegExp(`workspaceId=${WORKSPACE_ID}`));
  await expect(page.getByRole('region', { name: 'Applied filters' }).or(page.locator('[aria-label="Applied filters"]'))).toContainText('Smoke Workspace');
  await page.getByRole('button', { name: 'Clear filters' }).last().click();
  await expect(page).not.toHaveURL(/workspaceId=/);

  expect(observedRequests.some((request) => request.includes('/api/spend/groups?') && request.includes('page=3'))).toBe(true);
  expect(observedRequests.some((request) => request.includes('/api/spend/people?') && request.includes('page=1'))).toBe(true);
});

test('Limits deduplicates overlapping groups, preserves hidden selections, and supports review and retry', async ({ page }) => {
  const limitRequests: LimitRequest[] = [];
  await mockApi(page, 'account', false, [], [], false, limitRequests);
  await page.goto(`/limits?workspaceId=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: 'Limits', exact: true })).toBeVisible();

  await expect(page.locator('[data-testid="input-limit-amount"]')).toHaveCount(0);

  await page.locator('[data-testid="checkbox-member-101"]').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('[data-testid="warning-selection-outside"]')).toContainText('1 selected member is outside');
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.locator('[data-testid="button-clear-selection"]').click();

  await page.locator('[data-testid="tab-limits-groups"]').click();
  await expect(page.locator('[data-testid="card-limit-group-limit-group-a"]')).toContainText('2 eligible');
  await page.locator('[data-testid="button-limits-filters"]').click();
  await page.locator('[data-testid="select-group-filter"]').click();
  await page.getByRole('option', { name: 'Has eligible members' }).click();
  await expect(page.locator('[data-testid="card-limit-group-limit-group-readonly"]')).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Has eligible members' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Eligibility and limit state', { exact: true })).toBeHidden();
  await page.locator('[data-testid="button-limits-filters"]').click();
  const clearLimitFilters = page.getByRole('button', { name: 'Clear filters' });
  await expect(clearLimitFilters).toBeVisible();
  await clearLimitFilters.click();
  await expect(page.locator('[data-testid="card-limit-group-limit-group-readonly"]')).toBeVisible();

  await page.locator('[data-testid="button-select-group-limit-group-a"]').click();
  await page.locator('[data-testid="button-select-group-limit-group-b"]').click();
  await expect(page.locator('[data-testid="bar-limit-selection"]')).toContainText('3 members selected');

  await page.locator('[data-testid="search-groups"]').fill('no matching group');
  await expect(page.locator('[data-testid="warning-selection-outside"]')).toContainText('3 selected members are outside');
  await page.locator('[data-testid="search-groups"]').fill('');

  await page.locator('[data-testid="tab-limits-members"]').click();
  await page.locator('[data-testid="button-limits-filters"]').click();
  await page.locator('[data-testid="select-member-filter"]').click();
  await page.getByRole('option', { name: 'Explicit limit' }).click();
  await expect(page.getByText('Alex Explicit')).toBeVisible();
  await expect(page.getByText('Blair Inherited')).toHaveCount(0);
  await expect(page.locator('[data-testid="warning-selection-outside"]')).toContainText('2 selected members are outside');

  await page.locator('[data-testid="input-limit-amount"]').fill('60');
  await page.locator('[data-testid="button-review-limit-changes"]').click();
  await expect(page.getByRole('dialog')).toContainText('Review limit changes');
  const prepare = limitRequests.find((request) => request.path.endsWith('/prepare'));
  expect(prepare?.body?.userIds).toEqual(['101', '102', '103']);

  await page.getByRole('button', { name: 'Confirm and apply limits' }).click();
  await expect(page.getByRole('dialog')).toContainText('Finished with failures');
  await expect(page.getByRole('dialog')).toContainText('Safe fixture failure');
  await page.getByRole('button', { name: 'Retry unresolved targets' }).click();
  await expect(page.getByRole('dialog')).toContainText('Limit operation complete');
  expect(limitRequests.map((request) => request.path)).toEqual([
    '/api/limits/operations/prepare',
    `/api/limits/operations/${LIMIT_OPERATION_ID}/commit`,
    `/api/limits/operations/${LIMIT_OPERATION_ID}/retry`,
  ]);
});

test('Limits never presents unavailable current-cycle usage as known', async ({ page }) => {
  await mockApi(page, 'account');
  await page.route(`**/api/limits/workspaces/${WORKSPACE_ID}`, async (route) => {
    const fixture = limitWorkspaceFixture();
    fixture.limitObservation = {
      status: 'unavailable',
      observedAt: null,
      error: 'Current-cycle observation failed',
    };
    await json(route, fixture);
  });

  await page.goto(`/limits?workspaceId=${WORKSPACE_ID}`);
  const memberCard = page.locator('[data-testid="checkbox-member-101"]').locator('xpath=ancestor::*[@data-testid="card-limit-member-101"]');
  await expect(memberCard).toContainText('Usage / remaining');
  await expect(memberCard.locator('[data-testid="text-cycle-usage-101"]')).toHaveText('Unknown');
  await expect(memberCard).toContainText('Current-cycle usage is unavailable.');
  await expect(memberCard).not.toContainText('$10.00 / $90.00');
});

test('selected navigation remains readable in dark mode', async ({ page }) => {
  await mockApi(page, 'account');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.locator('[data-testid="button-open-navigation"]').click();

  await expect(page.locator('[data-testid="nav-dashboard"]:visible')).toHaveCSS('color', 'rgb(255, 255, 255)');
});

test('Limits preview deep link cannot auto-select or expose policy and write actions', async ({ page }) => {
  const limitRequests: LimitRequest[] = [];
  await mockApi(page, 'account', true, [], [], false, limitRequests);
  await page.goto(`/limits?workspaceId=${WORKSPACE_ID}&groupId=limit-group-a`);
  await expect(page.locator('[data-testid="bar-limit-selection"]')).toContainText('2 members selected');
  await expect(page.getByText('Advanced defaults and baseline policies', { exact: true })).toBeVisible();

  await (await revealAccountControl(page, 'select-rbac-preview')).click();
  await page.getByLabel('Workspaces').getByText('Smoke Workspace', { exact: true }).click();
  await expect(page.locator('[data-testid="active-preview-banner"]')).toContainText('Read-only');
  await expect(page).toHaveURL(new RegExp(`/limits\\?workspaceId=${WORKSPACE_ID}&groupId=limit-group-a`));
  await expect(page.locator('[data-testid="bar-limit-selection"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="button-clear-selection"]')).toHaveCount(0);
  await expect(page.getByText('Advanced defaults and baseline policies', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid="checkbox-member-101"]')).toBeDisabled();
  await page.locator('[data-testid="tab-limits-groups"]').click();
  await expect(page.locator('[data-testid="checkbox-group-limit-group-a"]')).toBeDisabled();
  await expect(page.locator('[data-testid="bar-limit-selection"]')).toHaveCount(0);
  expect(limitRequests).toEqual([]);
});

test('records isolated drilldown request and payload evidence', async ({ page }) => {
  const scenarios = [
    { name: 'group', path: `/groups/${GROUP_ID}`, ready: '[data-testid="page-group-detail"]' },
    {
      name: 'cluster-small',
      path: `/clusters?ids=${MANY_GROUP_IDS.slice(0, 2).join(',')}&name=Smoke%20Team`,
      ready: '[data-testid="page-cluster-detail"]',
    },
    {
      name: 'cluster-many',
      path: `/clusters?ids=${MANY_GROUP_IDS.join(',')}&name=Smoke%20Team`,
      ready: '[data-testid="page-cluster-detail"]',
    },
  ] as const;

  for (const scenario of scenarios) {
    const observation: DrilldownObservation = { requests: [], decodedResponseBytes: 0 };
    let releaseProjects!: () => void;
    const projectsGate = new Promise<void>((resolve) => {
      releaseProjects = resolve;
    });
    await mockApi(page, 'account');
    await mockMeasuredDrilldownFixture(page, observation, projectsGate);
    const startedAt = performance.now();
    const releaseTimer = setTimeout(releaseProjects, 250);
    await page.goto(scenario.path);
    await expectReady(page, scenario.ready);
    clearTimeout(releaseTimer);
    console.log(JSON.stringify({
      scenario: scenario.name,
      usefulMs: Math.round((performance.now() - startedAt) * 10) / 10,
      requestCount: observation.requests.length,
      decodedResponseBytes: observation.decodedResponseBytes,
      requests: observation.requests,
    }));
    await page.unrouteAll();
  }
});

test('group members render without requesting the hidden Projects tab', async ({ page }) => {
  const observation: DrilldownObservation = { requests: [], decodedResponseBytes: 0 };
  await mockApi(page, 'account');
  await mockMeasuredDrilldownFixture(page, observation, new Promise<void>(() => {}));

  await page.goto(`/groups/${GROUP_ID}`);
  await expect(page.locator('[data-testid="page-group-detail"]')).toBeVisible({ timeout: 3_000 });
  expect(observation.requests.some((request) => request.includes(`/groups/${GROUP_ID}/projects`))).toBe(false);
  await page.getByTestId('tab-group-projects').click();
  await expect.poll(() => observation.requests.filter(
    (request) => request.includes(`/groups/${GROUP_ID}/projects`),
  ).length).toBe(1);
  await page.getByTestId('tab-group-members').click();
  await expect(page.getByTestId('page-group-detail')).toContainText('Smoke Member');
});

test('many-group cluster uses one compact detail request and survives project failure', async ({ page }) => {
  const observation: DrilldownObservation = { requests: [], decodedResponseBytes: 0 };
  const sourceWorkspace = 'legacy-workspace';
  const sourceGroup = 'legacy-group';
  await mockApi(page, 'account');
  await page.route('**/api/auth/user', (route) => {
    const auth = authEnvelope('account');
    auth.capabilities.canWriteUserLimitsIn.push(sourceWorkspace);
    return json(route, auth);
  });
  await page.route('**/api/reporting/details/*', (route) => {
    const detail = reportingDetailFixture([GROUP_ID]);
    detail.sourceGroups.push({
      groupId: sourceGroup,
      workspaceId: sourceWorkspace,
      workspaceName: 'Legacy Workspace',
      role: 'admin',
    });
    detail.members.push({
      ...detail.members[0],
      workspaceId: sourceWorkspace,
      groupIds: [sourceGroup],
      currentCycleAgentSpendUsd: 25,
      limitUsd: 60,
      remainingUsd: 35,
    });
    return json(route, detail);
  });

  await page.goto(`/groups/${GROUP_ID}`);
  const sourceRow = page.getByTestId('page-group-detail').locator('tr')
    .filter({ hasText: 'Legacy Workspace' });
  await expect(sourceRow).toContainText('$35.00');
  await expect(sourceRow.getByRole('link')).toHaveAttribute(
    'href', `/limits?workspaceId=${sourceWorkspace}&groupIds=${sourceGroup}`,
  );
  await page.goto(`/clusters?ids=${GROUP_ID}`);
  const sourceClusterRow = page.getByTestId('page-cluster-detail').locator('tr')
    .filter({ hasText: 'Legacy Workspace' });
  await expect(sourceClusterRow).toContainText('Admin');
  await expect(page.getByTestId(`link-manage-people-budgets-${sourceWorkspace}`))
    .toHaveAttribute('href', `/limits?workspaceId=${sourceWorkspace}&groupIds=${sourceGroup}`);
});

test.describe('mobile regression', () => {
  test('Replit brand returns to Overview on desktop and mobile', async ({ page }) => {
    await mockApi(page, 'account');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/spend?rangeType=full-term');
      const brand = page.locator('[data-testid="link-overview-brand"]:visible');
      await expect(brand).toHaveText('Replit Budget Monitor');
      await expect(page.getByText('Comcast Enterprise', { exact: true })).toHaveCount(0);
      await expectNoDocumentOverflow(page);
      await brand.click();
      await expect(page).toHaveURL(/\/\?rangeType=full-term$/);
      await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
      if (width === 1280) await page.screenshot({ path: 'e2e/evidence/branding/replit-header.png' });
    }
    await page.goto('/spend');
    const sheet = await openMobileSheet(page);
    await sheet.getByRole('link', { name: 'Replit Budget Monitor' }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test('account main routes remain reachable through the mobile sheet at 390x844', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, 'account', false, [], observedRequests);
    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');

    const routes = [
      ['nav-help', '/help', 'Use Budget Monitor'],
      ['nav-limits', '/limits', 'Limits'],
      ['nav-allocations', '/allocations', 'Budget allocations'],
      ['nav-settings', '/settings', 'Settings'],
      ['nav-dashboard', '/', 'Overview'],
    ] as const;
    for (const [testId, path, heading] of routes) {
      const sheet = await openMobileSheet(page);
      const link = sheet.getByTestId(testId);
      await expectTouchTarget(page, `[data-testid="${testId}"]:visible`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(path === '/' ? '/$' : `${path}$`));
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      await expectNoDocumentOverflow(page);
    }
    expect(observedRequests.filter((request) => / (POST|PUT|PATCH|DELETE) /.test(` ${request} `))).toEqual([]);
  });

  test('scoped member navigation is restricted and usable at 320x640', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 320, height: 640 });
    await mockApi(page, 'member', false, [], observedRequests);
    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');
    const sheet = await openMobileSheet(page);
    await expect(sheet.getByTestId('nav-dashboard')).toBeVisible();
    await expect(sheet.getByTestId('nav-spend')).toHaveCount(0);
    await expect(sheet.getByTestId('nav-my-projects')).toBeVisible();
    await expect(sheet.getByTestId('nav-help')).toBeVisible();
    await expect(sheet.locator('[data-testid="nav-limits"], [data-testid="nav-allocations"], [data-testid="nav-settings"], [data-testid="nav-access"]')).toHaveCount(0);
    await sheet.getByTestId('nav-my-projects').click();
    await expect(page).toHaveURL(/tab=projects/);
    await expectNoDocumentOverflow(page);
    await expectPhoneInputFont(page, 'input[type="search"]');
    expect(observedRequests.some((request) => request.includes('viewScope=all_authorized'))).toBe(false);
  });

  test('Spend filters, search, and its local table scroller stay reachable at 430x932', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 430, height: 932 });
    await mockApi(page, 'account', false, [], observedRequests);
    await page.goto('/spend?tab=groups&pageSize=25');
    await expect(page.getByRole('heading', { name: 'Spend', exact: true })).toBeVisible();
    const search = page.getByRole('searchbox', { name: 'Search groups' });
    await search.fill('Smoke');
    await expect(page).toHaveURL(/search=Smoke/);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByText('Filter spend', { exact: true })).toBeVisible();
    await expectOnscreen(page, '[data-radix-popper-content-wrapper]');
    await page.keyboard.press('Escape');
    await expectPhoneInputFont(page, 'input[type="search"]');
    await expectTouchTarget(page, 'button[aria-label="Table options"]');

    const scroller = page.locator('[data-virtual-scroll]');
    await expect(scroller).toBeVisible();
    const dimensions = await scroller.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expectNoDocumentOverflow(page);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  test('Overview reporting period selector fits at 390x844', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, 'account', false, [], observedRequests);
    await page.goto('/?rangeType=full-term&viewScope=all_authorized');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');
    await page.getByRole('combobox', { name: 'Reporting period' }).click();
    await expect(page.getByRole('option')).toHaveText(['Full term', 'Billing period']);
    await expectNoDocumentOverflow(page);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  test('group and cluster details avoid document overflow in short landscape', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 640, height: 320 });
    await mockApi(page, 'account', false, [], observedRequests);
    await page.goto(`/groups/${GROUP_ID}`);
    await expectReady(page, '[data-testid="page-group-detail"]');
    await expect(page.getByTestId('page-group-detail')).toContainText('Smoke Member');
    await expectNoDocumentOverflow(page);
    await page.goto(`/clusters?ids=${GROUP_ID}&name=Smoke%20Team`);
    await expectReady(page, '[data-testid="page-cluster-detail"]');
    await expect(page.getByTestId('page-cluster-detail')).toContainText('Smoke Team');
    await expectNoDocumentOverflow(page);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  test('allocation addition can be reviewed and cancelled without a write at 390x844', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page, 'account', false, [], observedRequests);
    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    const ledger = page.getByTestId('table-team-budget-history');
    const hierarchy = page.getByTestId('funding-groups-hierarchy');
    expect(await ledger.evaluate(node => {
      const fundingHierarchy = document.querySelector('[data-testid="funding-groups-hierarchy"]');
      return fundingHierarchy !== null &&
        Boolean(node.compareDocumentPosition(fundingHierarchy) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await expect(page.getByText('Unmapped groups', { exact: true }).first()).toBeVisible();
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' }).click();
    await page.getByRole('option', { name: 'Smoke Team', exact: true }).click();
    const mappingDialog = page.getByRole('dialog', { name: 'Assign funding group' });
    await expect(mappingDialog).toContainText('Smoke Workspace');
    await expect(mappingDialog).toContainText('Executive Group');
    await mappingDialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    for (const name of ['Team', 'Starting allocation', 'August', 'September']) {
      await expect(ledger.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    await expect(ledger.getByRole('columnheader', { name: /^Total through/ })).toBeVisible();
    const rowHeights = await ledger.locator('tbody tr').first().locator(':scope > th, :scope > td')
      .evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().height));
    expect(Math.max(...rowHeights) - Math.min(...rowHeights)).toBeLessThanOrEqual(1);
    await expect(ledger.getByRole('columnheader', { name: /January|February|March|April|May|June|July|October|November|December/ })).toHaveCount(0);
    await page.screenshot({ path: 'e2e/evidence/reference-redesign/allocations-table-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
    await page.screenshot({ path: 'e2e/evidence/reference-redesign/allocations-table-mobile.png' });
    await page.getByTestId('button-edit-opening-funding-Smoke Team').click();
    const openingDialog = page.getByRole('dialog', { name: 'Update opening funding' });
    await expect(openingDialog).toContainText('preserved and will not be added twice');
    await openingDialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(openingDialog).toBeHidden();
    await page.getByTestId('button-new-monthly-allocation').click();
    const dialog = page.getByRole('dialog', { name: 'Add monthly funding' });
    await expect(dialog).toBeVisible();
    await dialog.locator('#allocation-team').click();
    await page.getByRole('option', { name: 'Smoke Team' }).click();
    await dialog.getByTestId('input-monthly-allocation-month').fill('2026-10');
    await dialog.getByTestId('input-monthly-allocation-amount').fill('125.50');
    await expectPhoneInputFont(page, '[data-testid="input-monthly-allocation-amount"]');
    await dialog.getByTestId('button-review-monthly-allocation').click();
    await expect(dialog.getByTestId('summary-monthly-allocation-review')).toContainText('$125.50');
    await expectOnscreen(page, '[data-testid="button-save-monthly-allocation"]');
    await expectTouchTarget(page, '[data-testid="button-save-monthly-allocation"]');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  test('Limits completes mocked review, progress, failure recovery at 430x932', async ({ page }) => {
    const observedRequests: string[] = [];
    const limitRequests: LimitRequest[] = [];
    await page.setViewportSize({ width: 430, height: 932 });
    await mockApi(page, 'account', false, [], observedRequests, false, limitRequests);
    await page.goto('/limits');
    await expect(page.getByRole('heading', { name: 'Limits', exact: true })).toBeVisible();
    await expect(page.getByTestId('select-limits-workspace')).toContainText('Smoke Workspace');
    await page.getByTestId('checkbox-member-101').click();
    await page.getByTestId('input-limit-amount').fill('60');
    await expectPhoneInputFont(page, '[data-testid="input-limit-amount"]');
    await page.getByTestId('button-review-limit-changes').click();
    await expectOnscreen(page, '[role="dialog"]');
    await expectTouchTarget(page, 'button:has-text("Confirm and apply limits")');
    await page.screenshot({ path: 'e2e/evidence/mobile/limits-review-430.png' });
    await page.getByRole('button', { name: 'Confirm and apply limits' }).click();
    await expect(page.getByRole('dialog')).toContainText('Limits failed');
    await page.getByRole('button', { name: 'Recover unresolved targets' }).click();
    await expect(page.getByRole('dialog')).toContainText('Limits verified');
    expect(limitRequests.map(({ path }) => path)).toEqual([
      '/api/limits/operations/prepare',
      `/api/limits/operations/${LIMIT_OPERATION_ID}/commit`,
      `/api/limits/operations/${LIMIT_OPERATION_ID}/retry`,
    ]);
    expect(observedRequests.filter((request) =>
      /^(POST|PUT|PATCH|DELETE) /.test(request) &&
      !request.includes('/api/limits/operations/'))).toEqual([]);
  });

  test('Settings forms fit at 320x640 without writes', async ({ page }) => {
    const observedRequests: string[] = [];
    await page.setViewportSize({ width: 320, height: 640 });
    await mockApi(page, 'account', false, [], observedRequests, false, [], true);
    await page.goto('/settings');
    await expectReady(page, '[data-testid="text-settings-title"]');
    const emailTrigger = page.getByTestId('button-test-email-modal');
    await expect(emailTrigger).toBeEnabled();
    await expectTouchTarget(page, '[data-testid="button-test-email-modal"]:visible');
    await emailTrigger.click();
    const emailDialog = page.getByRole('dialog', { name: 'Send Test Email' });
    await expect(emailDialog).toBeVisible();
    await expectOnscreen(page, '[data-testid="select-test-entity-type"]');
    await emailDialog.getByTestId('select-test-threshold').click();
    await page.getByRole('option', { name: '75%' }).click();
    await expect(emailDialog.getByTestId('select-test-threshold')).toContainText('75%');
    await emailDialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(emailDialog).toBeHidden();
    const adminInput = page.getByTestId('input-new-editor');
    await adminInput.fill('fixture-admin-user');
    await expectPhoneInputFont(page, '[data-testid="input-new-editor"]');
    await expectTouchTarget(page, '[data-testid="button-add-editor"]');
    await adminInput.fill('');

    await expectNoDocumentOverflow(page);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });
});

test.describe('reference-home-org focused mocked pass', () => {
  test('account capability lands directly on canonical Org Insights without mounting personal Home', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'account', false, [], observedRequests);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/?rangeType=custom&workspaceId=personal-workspace&viewScope=my');
    await expect(page).toHaveURL(/\/org-insights$/);
    await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toHaveCount(0);
    await expect(page.getByText('My Last 6 Months')).toHaveCount(0);
    await expect(page.getByText('My Spend Story')).toHaveCount(0);
    await expect(page.getByTestId('nav-org-insights')).toBeVisible();
    await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
    await expect(page.getByTestId('link-overview-brand')).toHaveAttribute('href', '/org-insights');
    await expect(page.getByTestId('org-card-account-spend')).toBeVisible();
    await expect(page.getByTestId('org-budget-chart')).toBeVisible();
    await expect(page.getByText('Smoke Team', { exact: true }).first()).toBeVisible();
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
    expect(observedRequests.some((request) => request.includes('/api/dashboard'))).toBe(false);
    expect(observedRequests.some((request) => request.includes('/api/spend/'))).toBe(false);
    expect(observedRequests.some((request) => request.includes('workspaceId=personal-workspace'))).toBe(false);
    expect(observedRequests.filter((request) => request.includes('/api/org-insights'))).toEqual([
      'GET /api/org-insights',
    ]);
    await expect(page.getByText('Invalid Date', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'e2e/evidence/reference-exact/OrgInsights-desktop.png' });
  });

  test('member Home is personal-only and Org Insights is denied before account queries', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'member', false, [], observedRequests);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    await expect(page.getByTestId('nav-org-insights')).toHaveCount(0);
    await expect(page.getByText('Managed usage')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/evidence/reference-exact/Home-mobile.png' });
    const homeRequestCount = observedRequests.length;
    await page.goto('/org-insights?rangeType=billing');
    await expect(page.getByTestId('org-insights-forbidden')).toBeVisible();
    const directOrgRequests = observedRequests.slice(homeRequestCount);
    expect(directOrgRequests.some((request) => request.includes('/api/dashboard?'))).toBe(false);
    expect(directOrgRequests.some((request) => request.includes('/api/spend/people?'))).toBe(false);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  test('Org Insights uses its fixed account-wide endpoint without personal filters', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'account', false, [], observedRequests);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/org-insights');
    await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();
    await expect(page.getByText('Funding Period: 2026-05-20 to 2027-05-20')).toBeVisible();
    await expect(page.getByPlaceholder('Search user...')).toHaveCount(0);
    expect(observedRequests.filter((request) => request.includes('/api/org-insights'))).toEqual([
      'GET /api/org-insights',
    ]);
    expect(observedRequests.some((request) => request.includes('/api/dashboard'))).toBe(false);
    expect(observedRequests.some((request) => request.includes('/api/spend/'))).toBe(false);
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
    await page.screenshot({ path: 'e2e/evidence/reference-exact/OrgInsights-desktop.png' });
  });

  test('capability-derived Org Insights landing fits compact mobile layout', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'account', false, [], observedRequests);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveURL(/\/org-insights$/);
    await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByTestId('button-open-navigation').click();
    const mobileOrgLink = page.getByTestId('nav-org-insights').filter({ visible: true });
    await expect(mobileOrgLink).toBeVisible();
    await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
    await mobileOrgLink.click();
    await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await expect(page.getByTestId('org-budget-chart')).toBeVisible();
    await page.screenshot({ path: 'e2e/evidence/reference-exact/OrgInsights-mobile.png' });
    expect(observedRequests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });
});

test.describe('funding assignment mocked browser coverage', () => {
  test('assigns, reassigns, and explicitly unmaps one exact funding group', async ({ page }) => {
    await mockApi(page, 'account');
    let revisionNumber = 1;
    let destination: string | null = null;
    const patchBodies: Array<Record<string, unknown>> = [];
    const inventory = () => ({
      ...fundingInventory(`funding-lifecycle-r${revisionNumber}`, destination),
      teams: [
        { teamName: 'Smoke Team', isHidden: false },
        { teamName: 'Zero Team', isHidden: false },
      ],
    });
    await page.route('**/api/admin/funding-groups', async route => {
      if (route.request().method() === 'GET') return json(route, inventory());
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      destination = body.teamName as string | null;
      revisionNumber += 1;
      return json(route, inventory());
    });

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    const hierarchy = page.getByTestId('funding-groups-hierarchy');
    const unmappedToggle = hierarchy.getByTestId('button-toggle-unmapped-groups');
    const mappedToggle = hierarchy.getByTestId('button-toggle-mapped-groups');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(0);
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByText('Smoke Members', { exact: true })).toHaveCount(0);

    await mappedToggle.focus();
    await page.keyboard.press('Enter');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    const initialSmokeTeamToggle = hierarchy.getByRole('button', { name: /Smoke Team.*total through.*1 group/ });
    await expect(initialSmokeTeamToggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(initialSmokeTeamToggle).toHaveCount(0);

    await unmappedToggle.focus();
    await page.keyboard.press('Enter');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(1);
    await expect(hierarchy.getByText('0 people', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(0);

    const fundingSearch = page.getByRole('textbox', { name: 'Search funding teams, groups, and workspaces' });
    await fundingSearch.fill('Executive Group');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();
    await fundingSearch.fill('');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(0);

    await fundingSearch.fill('Smoke Members');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByRole('button', { name: /Smoke Team.*total through.*1 group/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Smoke Members', { exact: true })).toBeVisible();
    await fundingSearch.fill('');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByText('Smoke Members', { exact: true })).toHaveCount(0);

    await unmappedToggle.focus();
    await page.keyboard.press('Space');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'true');
    const executiveDestination = hierarchy.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' });
    await executiveDestination.click();
    await page.getByRole('option', { name: 'Smoke Team', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Assign funding group' });
    expect(patchBodies).toEqual([]);
    await dialog.getByTestId('button-save-funding-group').click();
    await expect(dialog).toBeHidden();

    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(0);
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    const smokeTeamToggle = hierarchy.getByRole('button', { name: /Smoke Team.*total through.*2 groups/ });
    await expect(smokeTeamToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();

    await page.reload();
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'false');
    if (await mappedToggle.getAttribute('aria-expanded') === 'false') {
      await mappedToggle.click();
    }
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    const reloadedSmokeTeamToggle = hierarchy.getByRole('button', { name: /Smoke Team.*total through/ });
    await expect(reloadedSmokeTeamToggle).toHaveAttribute('aria-expanded', 'false');
    if (await reloadedSmokeTeamToggle.getAttribute('aria-expanded') === 'false') {
      await reloadedSmokeTeamToggle.click();
    }
    await expect(reloadedSmokeTeamToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();
    await executiveDestination.click();
    await page.getByRole('option', { name: 'Zero Team', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Change funding assignment' });
    await expect(dialog.getByTestId('button-save-funding-group')).toHaveText('Confirm reassignment');
    await dialog.getByTestId('button-save-funding-group').click();
    await expect(dialog).toBeHidden();

    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    const zeroTeamToggle = hierarchy.getByRole('button', { name: /Zero Team.*total through/ });
    await expect(zeroTeamToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();
    await executiveDestination.click();
    await page.getByRole('option', { name: 'Unmapped groups', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Change funding assignment' });
    await expect(dialog.getByTestId('button-save-funding-group')).toHaveText('Confirm unmap');
    await dialog.getByTestId('button-save-funding-group').click();
    await expect(dialog).toBeHidden();
    await expect(unmappedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toHaveCount(0);
    await unmappedToggle.click();
    await expect(hierarchy.getByTestId('unmapped-group-card')).toHaveCount(1);
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();

    expect(patchBodies).toEqual([
      { workspaceId: WORKSPACE_ID, groupId: 'funding-unmapped', teamName: 'Smoke Team', expectedRevision: 'funding-lifecycle-r1' },
      { workspaceId: WORKSPACE_ID, groupId: 'funding-unmapped', teamName: 'Zero Team', expectedRevision: 'funding-lifecycle-r2' },
      { workspaceId: WORKSPACE_ID, groupId: 'funding-unmapped', teamName: null, expectedRevision: 'funding-lifecycle-r3' },
    ]);
  });

  test('409 preserves destination, pending stays in queue, and refresh requires renewed review', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'account', false, [], observedRequests);
    let inventoryRevision = 'funding-conflict-r1';
    let patchCount = 0;
    const patchBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/admin/funding-groups', async route => {
      if (route.request().method() === 'GET') {
        return json(route, fundingInventory(inventoryRevision));
      }
      patchCount += 1;
      patchBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await new Promise(resolve => setTimeout(resolve, 400));
      if (patchCount === 1) {
        inventoryRevision = 'funding-conflict-r2';
        return json(route, { error: 'The funding configuration changed. Refresh and review again.' }, 409);
      }
      inventoryRevision = 'funding-conflict-r3';
      return json(route, fundingInventory(inventoryRevision, 'Smoke Team'));
    });

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' }).click();
    await page.getByRole('option', { name: 'Smoke Team', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assign funding group' });
    await dialog.getByTestId('button-save-funding-group').click();

    await expect(dialog.getByTestId('button-save-funding-group')).toHaveText('Saving…');
    await expect(page.getByTestId('funding-groups-hierarchy').getByText('Executive Group', { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('status-funding-group-save-error')).toContainText('changed');
    await expect(dialog.getByTestId('select-funding-team-destination')).toHaveCount(0);

    await dialog.getByTestId('button-refresh-funding-group-conflict').click();
    await expect(dialog.getByTestId('select-funding-team-destination')).toContainText('Smoke Team');
    await expect(dialog.getByTestId('button-review-funding-group')).toBeVisible();
    await expect(dialog.getByTestId('button-save-funding-group')).toHaveCount(0);
    await dialog.getByTestId('button-review-funding-group').click();
    await dialog.getByTestId('button-save-funding-group').click();

    await expect(dialog).toBeHidden();
    const hierarchy = page.getByTestId('funding-groups-hierarchy');
    const mappedToggle = hierarchy.getByTestId('button-toggle-mapped-groups');
    await expect(mappedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByRole('button', { name: /Smoke Team.*total through.*2 groups/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('Executive Group', { exact: true })).toBeVisible();
    expect(patchBodies).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        groupId: 'funding-unmapped',
        teamName: 'Smoke Team',
        expectedRevision: 'funding-conflict-r1',
      },
      {
        workspaceId: WORKSPACE_ID,
        groupId: 'funding-unmapped',
        teamName: 'Smoke Team',
        expectedRevision: 'funding-conflict-r2',
      },
    ]);
    await page.screenshot({ path: 'e2e/evidence/funding-assignment-after-conflict.png', fullPage: true });
  });

  test('unavailable inventory is not presented as a zero queue', async ({ page }) => {
    await mockApi(page, 'account');
    await page.route('**/api/admin/funding-groups', route =>
      json(route, { error: 'Directory inventory unavailable' }, 503));

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await expect(page.getByTestId('status-funding-groups-unavailable')).toContainText('not an empty queue');
    await expect(page.getByText('No unmapped groups in this view.')).toHaveCount(0);
  });

  test('stale inventory keeps inline assignment controls read-only', async ({ page }) => {
    await mockApi(page, 'account');
    await page.route('**/api/admin/funding-groups', route => {
      const inventory = fundingInventory('funding-stale-r1');
      inventory.freshness.status = 'stale';
      return json(route, inventory);
    });

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await expect(page.getByText('Directory inventory may be out of date')).toBeVisible();
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await expect(page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' })).toBeDisabled();
  });

  test('delegate and preview remain read-only and do not query privileged mapping audit', async ({ page }) => {
    const observedRequests: string[] = [];
    await mockApi(page, 'account', true, [], observedRequests);
    const delegate = authEnvelope('account');
    delegate.user!.id = 'allocation-delegate';
    delegate.user!.email = 'allocation-delegate@example.test';
    delegate.capabilities.canManageFundingMappings = false;
    delegate.capabilities.canManageAccess = false;
    await page.route('**/api/auth/user', route => json(route, delegate));

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await expect(page.getByText('Executive Group', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' })).toBeDisabled();
    expect(observedRequests.some(request => request.includes('/api/admin/funding-groups/audit'))).toBe(false);

    const preview = authEnvelope('account');
    preview.auth!.isPreview = true;
    preview.auth!.previewReadOnly = true;
    preview.capabilities.canManageFundingMappings = true;
    await page.unroute('**/api/auth/user');
    await page.route('**/api/auth/user', route => json(route, preview));
    await page.reload();
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await expect(page.getByTestId('button-toggle-unmapped-groups')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('button-toggle-mapped-groups')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await expect(page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' })).toBeDisabled();
    expect(observedRequests.some(request => request.includes('/api/admin/funding-groups/audit'))).toBe(false);
  });

  test('identity transition does not retain an open assignment dialog', async ({ page }) => {
    await mockApi(page, 'account');
    let identity = 'funding-identity-a';
    await page.route('**/api/auth/user', route => {
      const envelope = authEnvelope('account');
      envelope.user!.id = identity;
      envelope.user!.email = `${identity}@example.test`;
      return json(route, envelope);
    });

    await page.goto('/allocations');
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await page.getByTestId('button-toggle-unmapped-groups').click();
    await page.getByRole('combobox', { name: 'Budgeted team for Executive Group in Smoke Workspace' }).click();
    await page.getByRole('option', { name: 'Smoke Team', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Assign funding group' })).toBeVisible();
    identity = 'funding-identity-b';
    await page.reload();
    await expectReady(page, '[data-testid="page-team-budgets"]');
    await expect(page.getByTestId('button-toggle-unmapped-groups')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('button-toggle-mapped-groups')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog', { name: 'Assign funding group' })).toHaveCount(0);
  });
});

test.describe('org recorded balances focused mocked browser pass', () => {
  test('shows qualified balances, zero and overspend, while missing funded inputs retain known summaries', async ({ page }) => {
    await mockApi(page, 'account');
    const reporting = {
      acquisitionCoverage: 'partial',
      rosterAttributionBasis: 'current_membership',
      creatorCoverage: 'not_applicable',
      creatorAttributionBasis: 'not_applicable',
      freshness: 'fresh',
      valueBasis: 'partial_known',
      comparisonsVerified: false,
    };
    const team = (id: string, allocationUsd: number | null, spendUsd: number | null, remainingUsd: number | null, percentUsed: number | null) => ({
      id, name: `Sample ${id}`, allocationUsd, spendUsd, remainingUsd, percentUsed,
      complete: false, reporting,
      points: [{ date: '2026-06-01', spendUsd: null }, { date: '2026-09-08', spendUsd }],
    });
    let missing = false;
    const requests: string[] = [];
    await page.route('**/api/org-insights', route => {
      requests.push(route.request().url());
      return json(route, {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', asOf: '2026-09-08',
        complete: false, reporting,
        qualification: 'Missing historical rosters use current membership. Usage coverage is partial; missing facts are not zero.',
        summary: {
          accountSpendUsd: 1804.81,
          teamAllocationUsd: missing ? 13415.74 : 13315.74,
          remainingUsd: 11530.93,
          teamsOverBudget: 2,
          unassignedSpendUsd: 0,
          fundedTeamCount: missing ? 5 : 4,
          resolvedTeamCount: 4,
          unresolvedTeamCount: missing ? 1 : 0,
        },
        accountPoints: [{ date: '2026-06-01', spendUsd: null }, { date: '2026-09-08', spendUsd: 1804.81 }],
        teams: [
          team('Recorded Team', 13115.74, 1609.81, 11505.93, 12.273897927),
          team('Zero Spend', 100, 0, 100, 0),
          team('Overspent', 100, 150, -50, 150),
          team('Zero Allocation', 0, 25, -25, null),
          team('Unfunded', null, 20, null, null),
          ...(missing ? [team('Missing Usage', 100, null, null, null)] : []),
        ],
      });
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto('/org-insights?rangeType=custom&startDate=2026-09-01&endDate=2026-09-08');
    const row = (name: string) => page.getByRole('row').filter({ hasText: `Sample ${name}` });
    await expect(row('Recorded Team')).toContainText('$13,115.74');
    await expect(row('Recorded Team')).toContainText('$1,609.81');
    await expect(row('Recorded Team')).toContainText('$11,505.93');
    await expect(row('Recorded Team')).toContainText('12.3%');
    await expect(row('Zero Spend')).toContainText('0.0%');
    await expect(row('Overspent')).toContainText('-$50.00');
    await expect(row('Overspent')).toContainText('150.0%');
    await expect(row('Zero Allocation')).toContainText('-$25.00');
    await expect(row('Zero Allocation')).toContainText('Not applicable');
    await expect(row('Unfunded')).toContainText('Not set');
    await expect(page.getByTestId('org-card-remaining')).toContainText('$11,530.93');
    await expect(page.getByTestId('org-card-over-budget')).toContainText('2');
    await expect(page.getByTestId('org-card-remaining')).not.toContainText('(Known)');
    await expect(page.getByTestId('org-card-over-budget')).not.toContainText('(Known)');
    await expect(page.getByText(/funded teams; \d+ unresolved\./)).toHaveCount(0);
    await expect(page.getByTestId('org-balance-basis')).toHaveText('Balances based on recorded spend');
    await expect(page.getByText('Partial data', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Recorded, partial coverage', { exact: false })).toHaveCount(0);
    expect(requests.every((url) => new URL(url).search === '')).toBe(true);
    await page.screenshot({ path: 'e2e/evidence/org-recorded-balances.png' });
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByTestId('button-data-quality').click();
    await expect(page.getByTestId('dialog-data-quality')).toContainText('Missing historical rosters use current membership.');
    await expect(page.getByTestId('dialog-data-quality')).toContainText('Sample Recorded Team: Recorded, partial coverage');
    await page.keyboard.press('Escape');
    missing = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row('Missing Usage')).toContainText('Unavailable');
    await expect(page.getByTestId('org-card-remaining')).toContainText('Remaining Team Budgets (Known)');
    await expect(page.getByTestId('org-card-remaining')).toContainText('$11,530.93');
    await expect(page.getByTestId('org-card-remaining')).toContainText('4 of 5 funded teams; 1 unresolved.');
    await expect(page.getByTestId('org-card-over-budget')).toContainText('Teams Over Budget (Known)');
    await expect(page.getByTestId('org-card-over-budget')).toContainText('2');
    await expect(page.getByTestId('org-card-over-budget')).toContainText('4 of 5 funded teams; 1 unresolved.');
    await expect(row('Recorded Team')).toContainText('$11,505.93');
  });
});

test.describe('org budget chart focused mocked browser pass', () => {
  test('renders native chart series and keeps team controls functional on desktop and mobile', async ({ page }) => {
    await mockApi(page, 'account');
    const reporting = {
      acquisitionCoverage: 'complete',
      rosterAttributionBasis: 'current_membership',
      creatorCoverage: 'not_applicable',
      creatorAttributionBasis: 'not_applicable',
      freshness: 'fresh',
      valueBasis: 'verified',
      comparisonsVerified: true,
    };
    const points = (values: Array<number | null>) => values.map((spendUsd, index) => ({
      date: `2026-0${index + 6}-01`,
      spendUsd,
    }));
    const team = (id: string, name: string, allocationUsd: number | null, spendUsd: number | null, complete = true) => ({
      id, name, allocationUsd, spendUsd,
      remainingUsd: allocationUsd != null && spendUsd != null ? allocationUsd - spendUsd : null,
      percentUsed: allocationUsd && spendUsd != null ? (spendUsd / allocationUsd) * 100 : null,
      complete, reporting,
      points: points(spendUsd == null ? [null, null, null, null] : [spendUsd * .25, spendUsd * .55, spendUsd * .8, spendUsd]),
    });
    await page.route('**/api/org-insights', route => json(route, {
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      asOf: '2026-09-08',
      complete: false,
      reporting,
      qualification: 'Partial data for one team',
      summary: {
        accountSpendUsd: 300,
        teamAllocationUsd: 500,
        remainingUsd: 270,
        teamsOverBudget: 0,
        unassignedSpendUsd: 55,
        fundedTeamCount: 4,
        resolvedTeamCount: 4,
        unresolvedTeamCount: 0,
      },
      accountPoints: points([75, 165, 240, 300]),
      teams: [
        team('alpha', 'Alpha Team', 100, 90),
        team('beta', 'Beta Team', 150, 70),
        team('gamma', 'Gamma Team', 120, 50, false),
        team('delta', 'Delta Team', 130, 20),
        team('unfunded', 'Unfunded Team', null, 15),
      ],
    }));

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/org-insights');
    const chart = page.getByTestId('org-budget-chart');
    await expect(chart).toBeVisible();
    const total = chart.getByRole('button', { name: /^Total/ });
    const lines = chart.locator('.recharts-line-curve');
    await expect(total).toHaveAttribute('aria-pressed', 'true');
    await expect(total).toContainText('$300.00');
    await expect(total).toContainText('$500.00');
    await expect(chart.getByRole('button', { name: 'Alpha Team' })).toHaveAttribute('aria-pressed', 'false');
    await expect(chart.getByRole('button', { name: 'Beta Team' })).toHaveAttribute('aria-pressed', 'false');
    await expect(chart.getByRole('button', { name: 'Gamma Team' })).toHaveAttribute('aria-pressed', 'false');
    await expect(chart.getByRole('button', { name: 'Delta Team' })).toHaveAttribute('aria-pressed', 'false');
    await expect(chart.locator('svg').first()).toBeVisible();
    await expect(lines).toHaveCount(2);
    const totalPath = await lines.first().getAttribute('d');
    expect(totalPath).toMatch(/^M/);
    await chart.getByRole('button', { name: 'Alpha Team' }).click();
    await expect(chart.getByRole('button', { name: 'Alpha Team' })).toHaveAttribute('aria-pressed', 'true');
    await expect(lines).toHaveCount(4);
    await expect(lines.first()).toHaveAttribute('d', totalPath!);
    await total.focus();
    await page.keyboard.press('Space');
    await expect(total).toHaveAttribute('aria-pressed', 'false');
    await expect(lines).toHaveCount(2);
    await chart.getByRole('button', { name: 'Alpha Team' }).click();
    await expect(chart.getByText('No series selected.')).toBeVisible();
    await total.click();
    await expect(lines).toHaveCount(2);
    await expect(chart.getByRole('textbox')).toHaveCount(0);
    await expect(chart.getByRole('button', { name: /^(All|Clear)$/ })).toHaveCount(0);
    await expect(chart.getByText('Budgeted teams', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: 'e2e/evidence/org-budget-chart-desktop.png', fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await expect(chart.getByText('Budget Trajectory', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'e2e/evidence/org-budget-chart-mobile.png', fullPage: true });
    await expect(total).toBeVisible();
    await chart.getByRole('button', { name: 'Beta Team' }).click();
    await expect(lines).toHaveCount(4);
  });
});

test('Home spend dates fit the real chart and card at desktop and mobile widths', async ({ page }, testInfo) => {
  await mockApi(page, 'member');
  await page.route('**/api/me/membership-context', route => json(route, {
    defaultWorkspaceId: WORKSPACE_ID,
    qualification: null,
    workspaces: [{
      workspaceId: WORKSPACE_ID, workspaceName: 'Sample Workspace',
      groups: [], budgetTeams: [], unmappedGroups: [], isPreferred: true,
    }],
  }));
  const cycle = (key: string, startDate: string, days: number) => ({
    key, startDate,
    endDate: new Date(Date.parse(startDate) + (days - 1) * 86400000).toISOString().slice(0, 10),
    label: `${startDate} · Sample ${key} period`,
    personalComplete: true, teamComplete: true,
    points: Array.from({ length: days }, (_, index) => ({
      day: index + 1,
      date: new Date(Date.parse(startDate) + index * 86400000).toISOString().slice(0, 10),
      personalSpendUsd: index === 5 ? null : index * 2,
      teamSpendUsd: index * 3,
    })),
  });
  await page.route('**/api/spend/billing-cycles?*', route => {
    const billing = new URL(route.request().url()).searchParams.get('rangeType') === 'billing';
    return json(route, { cycles: billing
      ? [cycle('current', '2024-02-01', 29), cycle('previous', '2024-01-01', 31), cycle('twoAgo', '2023-12-01', 31)]
      : [cycle('current', '2026-05-20', 112), cycle('previous', '2026-01-28', 112)],
    });
  });
  for (const rangeType of ['full-term', 'billing']) {
    let desktopTicks = 0;
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/?rangeType=${rangeType}`);
      const chart = page.locator('.recharts-wrapper').filter({
        has: page.locator('svg[aria-label^="My cumulative spend"]'),
      });
      await expect(chart).toBeVisible();
      await expect(chart.locator('.recharts-line')).toHaveCount(rangeType === 'full-term' ? 1 : 3);
      const ticks = chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value');
      await expect(ticks.first()).toHaveText(rangeType === 'full-term' ? 'May 20' : 'Feb 1');
      await expect(ticks.last()).toHaveText(rangeType === 'full-term' ? 'Sep 8' : 'Feb 29');
      await expect(page.getByText('Period day', { exact: true })).toHaveCount(0);
      if (rangeType === 'billing') await expect(page.getByText('Dates: current period (UTC)')).toBeVisible();
      const tickCount = await ticks.count();
      if (width === 1440) desktopTicks = tickCount;
      else expect(tickCount).toBeLessThan(desktopTicks);
      const geometry = await chart.evaluate(element => {
        const frame = element.closest('.border.bg-muted\\/25')!;
        const bounds = frame.getBoundingClientRect();
        const svg = element.querySelector('svg.recharts-surface')!.getBoundingClientRect();
        const labels = Array.from(element.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value'))
          .map(label => {
            const box = label.getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom };
          });
        return {
          labels,
          frame: { left: bounds.left, right: bounds.right, bottom: bounds.bottom },
          svg: { left: svg.left, right: svg.right, bottom: svg.bottom },
          plotHeight: element.querySelector('.recharts-cartesian-grid')!.getBoundingClientRect().height,
        };
      });
      expect(geometry.plotHeight).toBeGreaterThan(100);
      geometry.labels.forEach((label, index) => {
        expect(label.left).toBeGreaterThanOrEqual(geometry.frame.left + 8);
        expect(label.right).toBeLessThanOrEqual(geometry.frame.right - 8);
        expect(label.bottom).toBeLessThan(geometry.frame.bottom - 12);
        expect(label.bottom).toBeLessThan(geometry.svg.bottom - 4);
        if (index) expect(label.left - geometry.labels[index - 1].right).toBeGreaterThanOrEqual(12);
      });
      await chart.locator('xpath=ancestor::div[contains(@class, "bg-muted/25")]')
        .screenshot({ path: testInfo.outputPath(`spend-${rangeType}-${width}.png`) });
    }
  }
});

function usageLimitAuditFixture(id: number) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Smoke Workspace',
    memberUserId: `member-${id}`,
    memberName: `Member ${id}`,
    memberEmail: null,
    operatorUserId: 'account-smoke',
    operatorName: 'Route Smoke',
    operatorEmail: null,
    action: 'set',
    operation: 'bulk',
    requestedAmountUsd: 60,
    outcome: 'success',
    error: null,
    createdAt: '2026-09-04T00:00:00.000Z',
  };
}
