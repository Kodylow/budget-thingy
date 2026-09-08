import { Router } from "express";
import {
  GetFundingGroupAuditResponse,
  GetFundingGroupAuditQueryParams,
  GetFundingGroupsResponse,
  UpdateFundingGroupBody,
  UpdateFundingGroupResponse,
} from "@workspace/api-zod";

import { getConfigurationSnapshot } from "../lib/configuration-snapshot";
import {
  buildCanonicalAccountDirectory,
  isCustomGroup,
} from "../lib/enterprise";
import {
  getFundingGroupOverrideAudits,
  setFundingGroupOverride,
} from "../lib/team-budgets";
import {
  buildCanonicalEffectiveTeams,
  getDirectory,
  getDirectoryFreshness,
  requireCapability,
  scopeGroups,
} from "./monitor.shared";

const router = Router();

type Directory = Awaited<ReturnType<typeof getDirectory>>;
type Configuration = NonNullable<Express.Request["configurationSnapshot"]>;

function fundingInventory(
  authz: NonNullable<Express.Request["authz"]>,
  directory: Directory,
  configuration: Configuration,
) {
  const hiddenTeams = new Set(
    configuration.teamBudgets
      .filter((team) => team.isHidden)
      .map((team) => team.teamName),
  );
  const configuredAccount = buildCanonicalAccountDirectory({
    workspaces: directory.workspaces,
    groups: directory.groups,
    groupMembers: directory.groupMembers,
    members: directory.members,
    mappings: configuration.familyTeamMappings,
  });
  const effective = buildCanonicalEffectiveTeams(
    configuredAccount,
    configuration.teamLimitTargets,
    configuration.fundingGroupOverrides,
  );
  const inferred = buildCanonicalEffectiveTeams(
    configuredAccount,
    configuration.teamLimitTargets,
    [],
  );
  const overrides = new Map(
    configuration.fundingGroupOverrides.map((override) => [
      `${override.workspaceId}\0${override.groupId}`,
      override,
    ]),
  );
  const groups = scopeGroups(authz, directory.groups.filter(isCustomGroup))
    .map((group) => {
      const override = overrides.get(`${group.workspaceId}\0${group.id}`);
      const teamName = effective.byRoleGroupId.get(group.id) ?? null;
      const policyTeamName = teamName ??
        inferred.byRoleGroupId.get(group.id) ??
        null;
      return {
        workspaceId: group.workspaceId,
        workspaceName:
          directory.workspaces.get(group.workspaceId)?.name ?? group.workspaceId,
        groupId: group.id,
        groupName: group.name,
        teamName,
        origin: override
          ? override.teamName === null ? "unmapped" as const : "explicit" as const
          : teamName === null ? "unmapped" as const : "inferred" as const,
        isHidden: policyTeamName !== null && hiddenTeams.has(policyTeamName),
      };
    })
    .filter((group) => authz.isTrueAccountAdmin || !group.isHidden)
    .sort((left, right) =>
      left.workspaceName.localeCompare(right.workspaceName) ||
      left.groupName.localeCompare(right.groupName) ||
      left.groupId.localeCompare(right.groupId)
    );
  const freshness = getDirectoryFreshness();
  const freshnessStatus = freshness.dataAsOf === null
    ? "unavailable" as const
    : freshness.isStale
      ? "stale" as const
      : "fresh" as const;
  return {
    revision: configuration.revision,
    groups,
    teams: configuration.teamBudgets
      .filter((team) => authz.isTrueAccountAdmin || !team.isHidden)
      .map((team) => ({ teamName: team.teamName, isHidden: team.isHidden }))
      .sort((left, right) => left.teamName.localeCompare(right.teamName)),
    freshness: {
      status: freshnessStatus,
      dataAsOf: freshness.dataAsOf,
      error: freshnessStatus === "unavailable"
        ? "Enterprise directory inventory is unavailable"
        : null,
    },
  };
}

router.get(
  "/admin/funding-groups",
  requireCapability("canViewAccountUsage"),
  async (req, res): Promise<void> => {
    const directory = await getDirectory();
    res.json(GetFundingGroupsResponse.parse(
      fundingInventory(req.authz!, directory, req.configurationSnapshot!),
    ));
  },
);

router.patch(
  "/admin/funding-groups",
  requireCapability("canManageFundingMappings"),
  async (req, res): Promise<void> => {
    const body = UpdateFundingGroupBody.safeParse(req.body);
    const keys = req.body && typeof req.body === "object"
      ? Object.keys(req.body as Record<string, unknown>).sort()
      : [];
    if (
      !body.success ||
      keys.join(",") !== "expectedRevision,groupId,teamName,workspaceId"
    ) {
      res.status(400).json({ error: "Invalid funding group update" });
      return;
    }
    const configuration = req.configurationSnapshot!;
    if (body.data.expectedRevision !== configuration.revision) {
      res.status(409).json({ error: "Funding configuration revision is stale" });
      return;
    }
    const freshness = getDirectoryFreshness();
    if (freshness.dataAsOf === null || freshness.isStale) {
      res.status(503).json({
        error: "A current directory inventory is required to update funding",
      });
      return;
    }
    const directory = await getDirectory();
    const group = directory.groups.find((candidate) =>
      isCustomGroup(candidate) &&
      candidate.workspaceId === body.data.workspaceId &&
      candidate.id === body.data.groupId
    );
    if (!group) {
      res.status(404).json({ error: "Funding group not found" });
      return;
    }
    const configuredAccount = buildCanonicalAccountDirectory({
      workspaces: directory.workspaces,
      groups: directory.groups,
      groupMembers: directory.groupMembers,
      members: directory.members,
      mappings: configuration.familyTeamMappings,
    });
    const effective = buildCanonicalEffectiveTeams(
      configuredAccount,
      configuration.teamLimitTargets,
      configuration.fundingGroupOverrides,
    );
    const inferred = buildCanonicalEffectiveTeams(
      configuredAccount,
      configuration.teamLimitTargets,
      [],
    );
    const hiddenTeamNames = new Set(
      configuration.teamBudgets
        .filter((team) => team.isHidden)
        .map((team) => team.teamName),
    );
    const effectiveTeamName = effective.byRoleGroupId.get(group.id) ?? null;
    const policyTeamName = effectiveTeamName ??
      inferred.byRoleGroupId.get(group.id) ??
      null;
    if (
      !req.authz!.isTrueAccountAdmin &&
      (
        (policyTeamName !== null && hiddenTeamNames.has(policyTeamName)) ||
        (
          body.data.teamName !== null &&
          hiddenTeamNames.has(body.data.teamName)
        )
      )
    ) {
      res.status(404).json({ error: "Funding group or team not found" });
      return;
    }
    const result = await setFundingGroupOverride({
      ...body.data,
      previousEffectiveTeamName: effectiveTeamName,
      actorUserId: req.user!.id,
    });
    if (result.status === "conflict") {
      res.status(409).json({ error: "Funding configuration revision is stale" });
      return;
    }
    if (result.status === "team_not_found") {
      res.status(404).json({ error: "Funding team not found" });
      return;
    }
    const committed = result.revision === configuration.revision
      ? configuration
      : await getConfigurationSnapshot();
    res.json(UpdateFundingGroupResponse.parse(
      fundingInventory(req.authz!, directory, committed),
    ));
  },
);

router.get(
  "/admin/funding-groups/audit",
  requireCapability("canManageFundingMappings"),
  async (req, res): Promise<void> => {
    const query = GetFundingGroupAuditQueryParams.safeParse(req.query);
    if (
      !query.success ||
      (
        query.data.beforeId !== undefined &&
        !Number.isSafeInteger(query.data.beforeId)
      )
    ) {
      res.status(400).json({ error: "Invalid funding group audit cursor" });
      return;
    }
    const [directory, changes] = await Promise.all([
      getDirectory(),
      getFundingGroupOverrideAudits({
        beforeId: query.data.beforeId,
        limit: 200,
      }),
    ]);
    const configuration = req.configurationSnapshot!;
    const hiddenTeamNames = new Set(
      configuration.teamBudgets
        .filter((team) => team.isHidden)
        .map((team) => team.teamName),
    );
    const current = fundingInventory(req.authz!, directory, configuration);
    const visibleGroupKeys = new Set(
      current.groups.map((group) => `${group.workspaceId}\0${group.groupId}`),
    );
    const visibleChanges = req.authz!.isTrueAccountAdmin
      ? changes
      : changes.filter((change) =>
          visibleGroupKeys.has(`${change.workspaceId}\0${change.groupId}`) &&
          (
            change.previousTeamName === null ||
            !hiddenTeamNames.has(change.previousTeamName)
          ) &&
          (
            change.newTeamName === null ||
            !hiddenTeamNames.has(change.newTeamName)
          )
        );
    res.json(GetFundingGroupAuditResponse.parse({
      changes: visibleChanges.map((change) => ({
        id: change.id,
        workspaceId: change.workspaceId,
        workspaceName:
          directory.workspaces.get(change.workspaceId)?.name ??
          change.workspaceId,
        groupId: change.groupId,
        groupName: directory.groups.find((group) =>
          group.workspaceId === change.workspaceId &&
          group.id === change.groupId
        )?.name ?? change.groupId,
        previousTeamName: change.previousTeamName,
        newTeamName: change.newTeamName,
        actor: change.actorUserId,
        changedAt: change.createdAt,
      })),
      nextBeforeId: changes.length === 200 ? changes.at(-1)!.id : null,
    }));
  },
);

export default router;