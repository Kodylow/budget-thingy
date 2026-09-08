import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import {
  GetGroupPlanInventoryResponse,
  SaveGroupPlanBody,
  SaveGroupPlanParams,
  SaveGroupPlanResponse,
} from "@workspace/api-zod";
import { db, groupPlansTable } from "@workspace/db";
import {
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  getBillingPeriodMetadata,
  getCachedDirectory,
  getDirectoryFreshness,
  isCustomGroup,
} from "../lib/enterprise";
import {
  allocateCentsByWeight,
  calculateFundingEnvelope,
  overlappingRosterWeights,
  saveGroupPlan,
} from "../lib/group-planning";
import { deriveEffectiveTeamBudgets } from "../lib/team-budgets";
import {
  buildScopedAccounting,
  canExposeCanonicalAllocation,
  canonicalTeamPoolId,
  prepareScopedAccounting,
  reportingSemanticsForGroups,
} from "../services/scoped-accounting";
import { FIXED_TEAM_BUDGET_PERIOD } from "../lib/usage-window";
import { scopeGroups } from "../lib/authz";

const router: IRouter = Router();
const DAY_MS = 86_400_000;
const planningGroupKey = (workspaceId: string, groupId: string) =>
  `${workspaceId}\0${groupId}`;

function billingAlignment(): {
  status: "aligned" | "misaligned" | "unavailable";
  reason: string;
} {
  const billing = getBillingPeriodMetadata();
  if (billing.isFallback) {
    return {
      status: "unavailable",
      reason: "Verified billing-period alignment is unavailable.",
    };
  }
  const start = new Date(billing.start);
  const expectedEnd = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    1,
  )).toISOString();
  const currentMonthStart = new Date(Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), 1,
  )).toISOString();
  return billing.start === start.toISOString() &&
      billing.start === currentMonthStart &&
      start.getUTCDate() === 1 &&
      start.getUTCHours() === 0 &&
      start.getUTCMinutes() === 0 &&
      start.getUTCSeconds() === 0 &&
      start.getUTCMilliseconds() === 0 &&
      billing.end === expectedEnd
    ? {
        status: "aligned",
        reason: "The verified billing period matches a UTC calendar month.",
      }
    : {
        status: "misaligned",
        reason: "The verified billing period does not match the planning calendar month.",
      };
}

function exactMappingIdentity(input: {
  workspaceId: string;
  groupId: string;
  teamName: string | null;
  familyKey: string | null;
  configuration: NonNullable<Express.Request["configurationSnapshot"]>;
}): string {
  const override = input.configuration.fundingGroupOverrides.find((row) =>
    row.workspaceId === input.workspaceId && row.groupId === input.groupId);
  const target = input.configuration.teamLimitTargets.find((row) =>
    row.workspaceId === input.workspaceId && row.groupId === input.groupId);
  const familyMapping = input.familyKey === null ? null
    : input.configuration.familyTeamMappings.find((row) =>
        row.workspaceId === input.workspaceId && row.familyKey === input.familyKey);
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    teamName: input.teamName,
    override: override ? {
      teamName: override.teamName,
      updatedAt: override.updatedAt.toISOString(),
    } : null,
    target: target ? {
      teamName: target.teamName,
      assignmentSource: target.assignmentSource,
    } : null,
    familyMapping: familyMapping ? {
      familyKey: familyMapping.familyKey,
      teamName: familyMapping.teamName,
      isLegacy: familyMapping.isLegacy,
    } : null,
  })).digest("hex");
}

async function inventory(req: Express.Request) {
  const authz = req.authz!;
  const configuration = req.configurationSnapshot!;
  const directory = await getCachedDirectory();
  const freshness = getDirectoryFreshness();
  const account = buildCanonicalAccountDirectory({
    workspaces: directory.workspaces,
    groups: directory.groups,
    groupMembers: directory.groupMembers,
    members: directory.members,
    mappings: configuration.familyTeamMappings,
  });
  const effective = buildCanonicalEffectiveTeams(
    account,
    configuration.teamLimitTargets,
    configuration.fundingGroupOverrides,
  );
  const hiddenTeams = new Set(
    configuration.teamBudgets.filter((team) => team.isHidden)
      .map((team) => team.teamName),
  );
  const administrativelyVisibleGroupIds = new Set(
    authz.roles.includes("account")
      ? directory.groups.map((group) => group.id)
      : [
          ...(authz.managedGroupIds ?? []),
          ...directory.groups
            .filter((group) => authz.workspaceIds.includes(group.workspaceId))
            .map((group) => group.id),
        ],
  );
  const groups = scopeGroups(
    authz,
    directory.groups.filter(isCustomGroup),
  ).map((group) => ({
    group,
    teamName: effective.byRoleGroupId.get(group.id) ?? null,
    mappingIdentity: exactMappingIdentity({
      workspaceId: group.workspaceId,
      groupId: group.id,
      teamName: effective.byRoleGroupId.get(group.id) ?? null,
      familyKey: account.roleGroupsById.get(group.id)?.familyKey ?? null,
      configuration,
    }),
  })).filter(({ group, teamName }) =>
    administrativelyVisibleGroupIds.has(group.id) &&
    (teamName === null || authz.isTrueAccountAdmin || !hiddenTeams.has(teamName)));
  const workspaceIds = [...new Set(groups.map(({ group }) => group.workspaceId))];
  const storedPlans = workspaceIds.length === 0
    ? []
    : await db.select().from(groupPlansTable)
      .where(inArray(groupPlansTable.workspaceId, workspaceIds));
  const planByIdentity = new Map(storedPlans.map((plan) => [
    `${plan.workspaceId}\0${plan.groupId}`,
    plan,
  ]));
  const effectiveBudgets = new Map(deriveEffectiveTeamBudgets(
    configuration.teamBudgets,
    configuration.teamBudgetAdjustments,
  ).filter((team) => !team.isHidden)
    .map((team) => [team.teamName, Math.round(team.effectiveAmountUsd * 100)]));
  const now = new Date();
  const periodStart = FIXED_TEAM_BUDGET_PERIOD.start.slice(0, 10);
  const periodEnd = new Date(
    Date.parse(FIXED_TEAM_BUDGET_PERIOD.endExclusive) - DAY_MS,
  ).toISOString().slice(0, 10);
  const currentMonthStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), 1,
  ));
  const active = now.getTime() >= Date.parse(FIXED_TEAM_BUDGET_PERIOD.start) &&
    now.getTime() < Date.parse(FIXED_TEAM_BUDGET_PERIOD.endExclusive);
  const priorSpendByTeam = new Map<string, number | null>();
  if (active && currentMonthStart.getTime() > Date.parse(FIXED_TEAM_BUDGET_PERIOD.start)) {
    const priorEnd = new Date(currentMonthStart.getTime() - DAY_MS)
      .toISOString().slice(0, 10);
    const query = {
      rangeType: "custom",
      startDate: periodStart,
      endDate: priorEnd,
      viewScope: "all_authorized",
    };
    const prepared = await prepareScopedAccounting(
      authz, query, undefined, configuration);
    const accounting = await buildScopedAccounting(
      authz, query, undefined, prepared);
    for (const teamName of new Set(groups.flatMap(({ teamName }) =>
      teamName === null ? [] : [teamName]))) {
      const fullGroups = directory.groups.filter((group) =>
        isCustomGroup(group) &&
        effective.byRoleGroupId.get(group.id) === teamName);
      const row = accounting.poolRows.find((candidate) =>
        candidate.id === canonicalTeamPoolId(teamName));
      const completeScope = canExposeCanonicalAllocation(authz, fullGroups);
      const completeSources = row !== undefined &&
        fullGroups.every((group) => row.sourceGroupIds?.includes(group.id));
      const coverage = accounting.usage.snapshot.coverage;
      const completeStoredDays = coverage.requestedWorkspaceDays > 0 &&
        coverage.presentWorkspaceDays === coverage.requestedWorkspaceDays &&
        coverage.missingWorkspaceDays.length === 0 &&
        coverage.failedWorkspaceDays.length === 0;
      const completeCanonicalRollups =
        [...accounting.daily.values()].every((rollup) => rollup.isComplete) &&
        reportingSemanticsForGroups(accounting.daily, fullGroups)
          .comparisonsVerified;
      priorSpendByTeam.set(
        teamName,
        completeScope && completeSources && completeStoredDays &&
            completeCanonicalRollups && row.usageObserved &&
            row.status !== "unavailable"
          ? Math.round(row.spendUsd * 100)
          : null,
      );
    }
  } else if (active) {
    for (const { teamName } of groups) {
      if (teamName !== null) {
        const fullGroups = directory.groups.filter((group) =>
          isCustomGroup(group) &&
          effective.byRoleGroupId.get(group.id) === teamName);
        priorSpendByTeam.set(
          teamName,
          canExposeCanonicalAllocation(authz, fullGroups) ? 0 : null,
        );
      }
    }
  }

  const teamGroups = new Map<string, typeof groups>();
  for (const item of groups) {
    if (item.teamName === null) continue;
    const items = teamGroups.get(item.teamName) ?? [];
    items.push(item);
    teamGroups.set(item.teamName, items);
  }
  const groupRecommendation = new Map<string, number>();
  const groupWeight = new Map<string, number>();
  const teamEnvelope = new Map<string, ReturnType<typeof calculateFundingEnvelope>>();
  const rosterAvailable = freshness.dataAsOf !== null && !freshness.isStale;
  const eligibleRoster = (group: (typeof groups)[number]["group"]): string[] | null => {
    const referenced = directory.groupMembers.get(group.id);
    if (!rosterAvailable || referenced === undefined) return null;
    const eligible: string[] = [];
    for (const userId of new Set(referenced)) {
      const member = directory.members.get(userId);
      const membership = member?.workspaces.get(group.workspaceId);
      if (!member || !membership) return null;
      if (!membership.isDisabled && !member.isInternalReplitUser) eligible.push(userId);
    }
    return eligible;
  };
  const completeTeamScope = new Map<string, boolean>();
  for (const [teamName, items] of teamGroups) {
    const fullGroups = directory.groups.filter((group) =>
      isCustomGroup(group) &&
      effective.byRoleGroupId.get(group.id) === teamName);
    const hasFullScope = canExposeCanonicalAllocation(authz, fullGroups);
    completeTeamScope.set(teamName, hasFullScope);
    const rosterGroups = items.map(({ group }) => ({
      id: planningGroupKey(group.workspaceId, group.id),
      workspaceId: group.workspaceId,
      eligibleUserIds: eligibleRoster(group) ?? [],
    }));
    const completeRoster = hasFullScope &&
      fullGroups.every((group) => eligibleRoster(group) !== null);
    const envelope = calculateFundingEnvelope({
      now,
      periodStart: FIXED_TEAM_BUDGET_PERIOD.start,
      periodEndExclusive: FIXED_TEAM_BUDGET_PERIOD.endExclusive,
      allocationUsdCents: effectiveBudgets.get(teamName) ?? null,
      priorSpendUsdCents: completeRoster
        ? priorSpendByTeam.get(teamName) ?? null
        : null,
    });
    teamEnvelope.set(teamName, completeRoster ? envelope : {
      ...envelope,
      status: "missing_history",
      amountUsdCents: null,
      reason: "Complete active membership is unavailable.",
    });
    const weights = overlappingRosterWeights(rosterGroups);
    for (const [id, weight] of weights) groupWeight.set(id, weight);
    if (completeRoster && envelope.amountUsdCents !== null) {
      const allocations = allocateCentsByWeight(
        envelope.amountUsdCents,
        [...weights].map(([id, weight]) => ({ id, weight })),
      );
      for (const [id, cents] of allocations) groupRecommendation.set(id, cents);
    }
  }

  const alignment = billingAlignment();
  const knownLimits = directory.budgets.observation.lastSuccessfulAt !== null;
  const plans = groups.map(({ group, teamName, mappingIdentity }) => {
    const currentPlan = planByIdentity.get(`${group.workspaceId}\0${group.id}`);
    const sameFundingIdentity = currentPlan !== undefined &&
      currentPlan.teamName === teamName &&
      currentPlan.fundingPeriodStart === periodStart &&
      currentPlan.fundingPeriodEnd === periodEnd;
    const savedStatus = currentPlan === undefined
      ? "unset" as const
      : !sameFundingIdentity
        ? "requires_reconfirmation" as const
      : currentPlan.mappingIdentity === mappingIdentity
        ? "confirmed" as const
        : "requires_reconfirmation" as const;
    const eligibleUserIds = eligibleRoster(group);
    const recommendationAmountUsdCents =
      teamName === null
        ? null
        : groupRecommendation.get(planningGroupKey(group.workspaceId, group.id)) ?? null;
    const envelope = teamName === null ? null : teamEnvelope.get(teamName) ?? null;
    const usablePlan = savedStatus === "confirmed"
      ? currentPlan!.amountUsdCents
      : recommendationAmountUsdCents;
    const memberSuggestionAmountUsdCents =
      alignment.status === "aligned" && eligibleUserIds && eligibleUserIds.length > 0 &&
          usablePlan !== null
        ? Math.floor(usablePlan / eligibleUserIds.length)
        : null;
    const explicit = directory.budgets.userLimits.get(group.workspaceId);
    const inherited = directory.budgets.workspaceDefaults.get(group.workspaceId);
    const existing = !knownLimits || eligibleUserIds === null
      ? null
      : eligibleUserIds.map((userId) => {
          const amount = explicit?.get(userId) ?? inherited;
          return amount === undefined ? null : Math.round(amount * 100);
        });
    const values = existing === null ? [] : [...new Set(existing)];
    const existingStatus = existing === null
      ? "unavailable" as const
      : values.length === 1 && values[0] === null
        ? "none" as const
        : values.length === 1
          ? "uniform" as const
          : "mixed" as const;
    return {
      workspaceId: group.workspaceId,
      workspaceName: directory.workspaces.get(group.workspaceId)?.name ??
        group.workspaceId,
      groupId: group.id,
      groupName: group.name,
      teamName,
      canEditPlan: teamName !== null &&
        completeTeamScope.get(teamName) === true &&
        authz.capabilities.canEditAllocations && !authz.isPreview,
      savedAmountUsdCents: sameFundingIdentity
        ? currentPlan!.amountUsdCents
        : null,
      savedStatus,
      planRevision: currentPlan?.revision ?? null,
      recommendationAmountUsdCents,
      recommendationStatus: teamName === null
        ? "missing_funding" as const
        : envelope?.status ?? "missing_history" as const,
      recommendationReason: teamName === null
        ? "This group is not mapped to a funding team."
        : envelope?.reason ?? "Recommendation inputs are unavailable.",
      teamEnvelopeUsdCents: envelope?.amountUsdCents ?? null,
      overlapAdjustedMemberWeight: eligibleUserIds === null
        ? null
        : groupWeight.get(planningGroupKey(group.workspaceId, group.id)) ?? 0,
      eligibleMemberCount: eligibleUserIds?.length ?? null,
      writableMemberCount: eligibleUserIds?.filter(() =>
        authz.capabilities.canWriteUserLimitsIn.includes(group.workspaceId)).length ?? null,
      skippedMemberCount: eligibleUserIds?.filter(() =>
        !authz.capabilities.canWriteUserLimitsIn.includes(group.workspaceId)).length ?? null,
      memberSuggestionAmountUsdCents,
      memberSuggestionReason: eligibleUserIds === null
        ? "Complete active membership is unavailable."
        : eligibleUserIds.length === 0
          ? "No eligible active members."
          : alignment.status !== "aligned"
            ? alignment.reason
            : "The group planning amount is divided equally and rounded down.",
      billingAlignmentStatus: alignment.status,
      existingIndividualLimitStatus: existingStatus,
      existingIndividualLimitAmountUsdCents:
        existingStatus === "uniform" ? values[0] as number : null,
      savedExceedsRecommendation: savedStatus === "confirmed" &&
        recommendationAmountUsdCents !== null &&
        currentPlan!.amountUsdCents > recommendationAmountUsdCents,
      suggestedAllowancesExceedPlan: memberSuggestionAmountUsdCents !== null &&
        usablePlan !== null && eligibleUserIds !== null &&
        memberSuggestionAmountUsdCents * eligibleUserIds.length > usablePlan,
    };
  });
  return {
    revision: configuration.revision,
    fundingPeriod: { start: periodStart, end: periodEnd },
    plans,
  };
}

router.get("/limits/group-plans", async (req, res): Promise<void> => {
  if (!req.authz!.roles.some((role) =>
    role === "account" || role === "workspace_admin" || role === "team_admin")) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  try {
    res.json(GetGroupPlanInventoryResponse.parse(await inventory(req)));
  } catch (error) {
    req.log.error({ err: error }, "Group plan inventory failed");
    res.status(503).json({ error: "Group planning inventory is unavailable" });
  }
});

router.put(
  "/limits/group-plans/:workspaceId/:groupId",
  async (req, res): Promise<void> => {
    const params = SaveGroupPlanParams.safeParse(req.params);
    const body = SaveGroupPlanBody.safeParse(req.body);
    if (!params.success || !body.success ||
        !Number.isSafeInteger(body.data.amountUsdCents) ||
        (
          body.data.expectedPlanRevision !== null &&
          !Number.isSafeInteger(body.data.expectedPlanRevision)
        )) {
      res.status(400).json({ error: "Invalid group plan save" });
      return;
    }
    if (!req.authz!.capabilities.canEditAllocations || req.authz!.isPreview) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const configuration = req.configurationSnapshot!;
    if (body.data.expectedConfigurationRevision !== configuration.revision) {
      res.status(409).json({ error: "Funding configuration revision is stale" });
      return;
    }
    const directory = await getCachedDirectory();
    const group = directory.groups.find((candidate) =>
      isCustomGroup(candidate) &&
      candidate.workspaceId === params.data.workspaceId &&
      candidate.id === params.data.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const account = buildCanonicalAccountDirectory({
      workspaces: directory.workspaces,
      groups: directory.groups,
      groupMembers: directory.groupMembers,
      members: directory.members,
      mappings: configuration.familyTeamMappings,
    });
    const teamName = buildCanonicalEffectiveTeams(
      account,
      configuration.teamLimitTargets,
      configuration.fundingGroupOverrides,
    ).byRoleGroupId.get(group.id) ?? null;
    const team = configuration.teamBudgets.find((candidate) =>
      candidate.teamName === teamName && !candidate.isHidden);
    if (!teamName || !team) {
      res.status(404).json({ error: "Mapped funding group not found" });
      return;
    }
    const fullGroups = directory.groups.filter((candidate) =>
      isCustomGroup(candidate) &&
      buildCanonicalEffectiveTeams(
        account,
        configuration.teamLimitTargets,
        configuration.fundingGroupOverrides,
      ).byRoleGroupId.get(candidate.id) === teamName);
    if (!canExposeCanonicalAllocation(req.authz!, fullGroups)) {
      res.status(403).json({ error: "Complete funding-team scope is required" });
      return;
    }
    const mappingIdentity = exactMappingIdentity({
      workspaceId: group.workspaceId,
      groupId: group.id,
      teamName,
      familyKey: account.roleGroupsById.get(group.id)?.familyKey ?? null,
      configuration,
    });
    const result = await saveGroupPlan({
      ...params.data,
      teamName,
      fundingPeriodStart: FIXED_TEAM_BUDGET_PERIOD.start.slice(0, 10),
      fundingPeriodEnd: new Date(
        Date.parse(FIXED_TEAM_BUDGET_PERIOD.endExclusive) - DAY_MS,
      ).toISOString().slice(0, 10),
      expectedConfigurationRevision: configuration.revision,
      mappingIdentity,
      expectedPlanRevision: body.data.expectedPlanRevision,
      amountUsdCents: body.data.amountUsdCents,
      actorUserId: req.user!.id,
    });
    if (result.status === "conflict") {
      res.status(409).json({ error: "Group plan or funding identity is stale" });
      return;
    }
    res.json(SaveGroupPlanResponse.parse({
      workspaceId: result.plan.workspaceId,
      groupId: result.plan.groupId,
      amountUsdCents: result.plan.amountUsdCents,
      status: "confirmed",
      revision: result.plan.revision,
      updatedAt: result.plan.updatedAt,
    }));
  },
);

export default router;