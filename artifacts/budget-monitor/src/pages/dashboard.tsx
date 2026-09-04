import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UnassignedSummaryRow } from "@/components/unassigned-summary-row";
import {
  RefreshCw,
  AlertTriangle,
  DollarSign,
  TrendingUp,
  Wallet,
  ChevronDown,
  ChevronRight,
  Layers,
  TrendingDown,
} from "lucide-react";

import { useAuthContext, useCanWrite } from "@/components/auth-context";

type PaceStatus = "on-track" | "at-risk" | "over-pace";
interface PaceResult {
  status: PaceStatus;
  projectedUsd: number;
  daysRemaining: number;
}

function calcPace(
  spendUsd: number,
  budgetUsd: number,
  periodStart: string,
  periodEnd: string,
): PaceResult | null {
  if (budgetUsd <= 0 || spendUsd == null) return null;
  const now = Date.now();
  const startMs = new Date(periodStart).getTime();
  const endMs = new Date(periodEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    return null;
  const daysElapsed = (now - startMs) / 86_400_000;
  if (daysElapsed <= 0) return null;
  const daysRemaining = Math.max(0, (endMs - now) / 86_400_000);
  const projectedUsd =
    (spendUsd / daysElapsed) * ((endMs - startMs) / 86_400_000);
  const ratio = projectedUsd / budgetUsd;
  const status: PaceStatus =
    ratio <= 1.0 ? "on-track" : ratio <= 1.15 ? "at-risk" : "over-pace";
  return { status, projectedUsd, daysRemaining };
}

function PaceCell({
  spendUsd,
  budgetUsd,
  semibold,
  periodStart,
  periodEnd,
  periodLabel,
  isFallback,
}: {
  spendUsd: number;
  budgetUsd: number | null;
  semibold?: boolean;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  isFallback: boolean;
}) {
  if (budgetUsd == null || budgetUsd <= 0)
    return <span className="text-sm text-muted-foreground">—</span>;
  const pace = calcPace(spendUsd, budgetUsd, periodStart, periodEnd);
  if (!pace) return <span className="text-sm text-muted-foreground">—</span>;
  const cfg = {
    "on-track": {
      label: "On Track",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    },
    "at-risk": {
      label: "At Risk",
      cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    },
    "over-pace": {
      label: "Over Pace",
      cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    },
  }[pace.status];
  return (
    <div
      className="flex flex-col items-end gap-0.5"
      title={`Pace period: ${periodLabel}${isFallback ? " (safe fallback)" : ""}`}
    >
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.cls} ${semibold ? "font-semibold" : ""}`}
      >
        {cfg.label}
      </span>
      <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
        ${pace.projectedUsd.toFixed(0)} proj.
      </span>
    </div>
  );
}
import {
  useListGroups,
  useGetSummary,
  useGetTeamsBudgets,
  useGetUserActivity,
  getListGroupsQueryKey,
  getGetSummaryQueryKey,
  getGetTeamsBudgetsQueryKey,
  getGetUserActivityQueryKey,
  getListVisibleWorkspaceMembersQueryOptions,
  getListVisibleWorkspaceMembersQueryKey,
  type Group,
  type GroupFamilyHierarchy,
} from "@workspace/api-client-react";
import { ThresholdBadge } from "@/components/threshold-badge";
import { BudgetInput } from "@/components/budget-input";
import { useLocation } from "wouter";
import { useRange } from "@/components/range-context";
import { RangeFilter } from "@/components/range-filter";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { roleBadgeClass, roleLabel } from "@/lib/hierarchy-presentation";
import {
  reportDashboardNumbersPainted,
} from "@/lib/client-performance";
import {
  allocateWorkspaceTeamBudgets,
  indexWorkspaceTeamSpend,
  workspaceTeamSpendKey,
} from "@/lib/workspace-team-spend";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  InternalSpendExplanation,
  InternalUserBadge,
} from "@/components/internal-user-badge";

type DashboardGroup = Group;

interface TeamSection {
  workspaceId: string;
  workspaceName: string;
  teamName: string;
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
  paceSpendUsd: number;
  paceSpendLoaded: boolean;
  budgetUsd: number | null;
  budgetIsShared: boolean;
  budgetAllocationMethod: "full" | "proportional" | "equal";
  remainingUsd: number | null;
  percentUsed: number | null;
  monthlyAgentLimitUsd: number | null;
  cycleAgentSpendUsd: number;
  agentRemainingUsd: number | null;
  agentPercentUsed: number | null;
  agentBlocked: boolean;
  groups: DashboardGroup[];
  families: GroupFamilyHierarchy[];
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const canWrite = useCanWrite();
  const { auth, isAccountWide, role, user, capabilities } = useAuthContext();
  const { rangeSelection, rangeType, startDate, endDate } = useRange();
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(
    () => new Set(),
  );
  const [showLegacyGroups, setShowLegacyGroups] = useState(false);
  const dashboardReadyMeasured = useRef(false);

  const queryParams = useMemo(
    () => ({
      rangeType,
      ...(rangeType === "custom" ? { startDate, endDate } : {}),
    }),
    [rangeType, startDate, endDate],
  );

  const { data: groupsData, isFetching: groupsFetching } = useListGroups(
    queryParams,
    {
      query: {
        queryKey: getListGroupsQueryKey(queryParams),
        placeholderData: (previousData) => previousData,
      },
    },
  );

  const { data: summary, isFetching: summaryFetching } = useGetSummary(
    queryParams,
    {
      query: {
        queryKey: getGetSummaryQueryKey(queryParams),
        placeholderData: (previousData) => previousData,
      },
    },
  );
  const { data: teamBudgetsData, isLoading: teamBudgetsLoading } =
    useGetTeamsBudgets({
      query: {
        queryKey: getGetTeamsBudgetsQueryKey(),
      },
    });
  const { data: memberCycleActivity } = useGetUserActivity(
    { rangeType: "billing" },
    {
      query: {
        enabled: role === "member",
        queryKey: getGetUserActivityQueryKey({ rangeType: "billing" }),
      },
    },
  );
  const { data: memberTermActivity } = useGetUserActivity(
    { rangeType: "full-term" },
    {
      query: {
        enabled: role === "member",
        queryKey: getGetUserActivityQueryKey({ rangeType: "full-term" }),
      },
    },
  );

  const usageAvailable = groupsData?.usageHealth.status !== "empty";
  const groups = useMemo(
    () =>
      (groupsData?.groups ?? [])
        .filter((group) => showLegacyGroups || !group.isLegacy)
        .map((group) => {
          return {
            ...group,
            spendUsd: group.rollupSpendUsd,
            spendLoaded: usageAvailable,
            paceSpendLoaded: usageAvailable,
          };
        }),
    [groupsData?.groups, usageAvailable, showLegacyGroups],
  );
  const memberWorkspaceIds = [
    ...new Set(groups.map((group) => group.workspaceId)),
  ];
  const memberLimitQueries = useQueries({
    queries: memberWorkspaceIds.map((workspaceId) =>
      getListVisibleWorkspaceMembersQueryOptions(workspaceId, {
        query: {
          enabled: role === "member",
          queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId),
        },
      }),
    ),
  });

  useLayoutEffect(() => {
    if (
      dashboardReadyMeasured.current ||
      !groupsData ||
      !summary ||
      groupsFetching ||
      summaryFetching
    ) return;
    dashboardReadyMeasured.current = true;
    return reportDashboardNumbersPainted();
  }, [groupsData, groupsFetching, summary, summaryFetching]);

  // Build team budget map
  const teamBudgetMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const tb of teamBudgetsData?.budgets ?? []) {
      m.set(tb.teamName, tb.amountUsd);
    }
    return m;
  }, [teamBudgetsData]);
  const teamAgentStateMap = useMemo(
    () => new Map(
      (teamBudgetsData?.budgets ?? []).map((team) => [team.teamName, team]),
    ),
    [teamBudgetsData],
  );
  const workspaceTeamSpendMap = useMemo(
    () => indexWorkspaceTeamSpend(groupsData?.workspaceTeamRawSpend ?? []),
    [groupsData?.workspaceTeamRawSpend],
  );
  const visibleNonlegacyWorkspaceTeams = useMemo(() => {
    return (groupsData?.hierarchy ?? []).flatMap((workspace) =>
      workspace.teams.flatMap((team) => {
        if (
          !team.teamName ||
          !team.families.some((family) => !family.isLegacy)
        ) {
          return [];
        }
        const key = workspaceTeamSpendKey(workspace.workspaceId, team.teamName);
        return [{
          workspaceId: workspace.workspaceId,
          teamName: team.teamName,
          spendUsd: workspaceTeamSpendMap.get(key) ?? 0,
        }];
      }),
    );
  }, [groupsData?.hierarchy, workspaceTeamSpendMap]);
  const workspaceTeamBudgetMap = useMemo(
    () =>
      allocateWorkspaceTeamBudgets(
        visibleNonlegacyWorkspaceTeams,
        teamBudgetMap,
      ),
    [visibleNonlegacyWorkspaceTeams, teamBudgetMap],
  );
  const visibleNonlegacyTeamNames = useMemo(
    () =>
      new Set(
        visibleNonlegacyWorkspaceTeams.map((section) => section.teamName),
      ),
    [visibleNonlegacyWorkspaceTeams],
  );

  // Compute team sections
  const teamSections = useMemo(() => {
    const teamSections: TeamSection[] = [];
    for (const workspace of groupsData?.hierarchy ?? []) {
      for (const team of workspace.teams) {
        const families = team.families.filter(
          (family) => showLegacyGroups || !family.isLegacy,
        );
        const teamGroups = families.flatMap((family) => family.groups);
        if (teamGroups.length === 0) continue;
        if (!team.teamName) {
          continue;
        }
        const teamName = team.teamName;
        const memberCount = families.reduce(
          (total, family) => total + family.memberCount,
          0,
        );
      // Financial values remain server-owned. Provisional server values stay
      // visible while canonical data refreshes in the background.
        const spendUsd =
          workspaceTeamSpendMap.get(
            workspaceTeamSpendKey(workspace.workspaceId, teamName),
          ) ?? 0;
        const spendLoaded = usageAvailable;
        const paceSpendLoaded = teamGroups.every(
          (group) => group.paceSpendLoaded,
        );
        const paceSpendUsd = teamGroups.reduce(
          (sum, group) => sum + (group.paceSpendUsd ?? 0),
          0,
        );
        const budgetAllocation = workspaceTeamBudgetMap.get(
          workspaceTeamSpendKey(workspace.workspaceId, teamName),
        );
        const budgetUsd = budgetAllocation?.budgetUsd ?? null;
        const hasBudget = budgetUsd !== null && budgetUsd > 0;
        const remainingUsd = hasBudget ? budgetUsd! - spendUsd : null;
        const percentUsed = hasBudget ? (spendUsd / budgetUsd!) * 100 : null;
        const agentState = teamAgentStateMap.get(teamName);

        teamSections.push({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName ?? workspace.workspaceId,
          teamName,
          memberCount,
          spendUsd,
          spendLoaded,
          paceSpendUsd,
          paceSpendLoaded,
          budgetUsd: budgetUsd ?? null,
          budgetIsShared: budgetAllocation?.isShared ?? false,
          budgetAllocationMethod: budgetAllocation?.method ?? "full",
          remainingUsd,
          percentUsed,
          monthlyAgentLimitUsd: agentState?.monthlyAgentLimitUsd ?? null,
          cycleAgentSpendUsd: agentState?.cycleAgentSpendUsd ?? 0,
          agentRemainingUsd: agentState?.agentRemainingUsd ?? null,
          agentPercentUsed: agentState?.agentPercentUsed ?? null,
          agentBlocked: agentState?.agentBlocked ?? false,
          groups: teamGroups,
          families,
        });
      }
    }

    // Canonical budgets may exist before any Replit group is assigned. Keep
    // those teams visible with zero spend so dashboard totals reconcile.
    if (isAccountWide) {
      for (const [teamName, budgetUsd] of teamBudgetMap) {
        if (visibleNonlegacyTeamNames.has(teamName)) continue;
        teamSections.push({
          workspaceId: "__budget_only__",
          workspaceName: "Unallocated Budgets",
          teamName,
          memberCount: 0,
          spendUsd: 0,
          spendLoaded: true,
          paceSpendUsd: 0,
          paceSpendLoaded: true,
          budgetUsd,
          budgetIsShared: false,
          budgetAllocationMethod: "full",
          remainingUsd: budgetUsd != null && budgetUsd > 0 ? budgetUsd : null,
          percentUsed: budgetUsd != null && budgetUsd > 0 ? 0 : null,
          monthlyAgentLimitUsd:
            teamAgentStateMap.get(teamName)?.monthlyAgentLimitUsd ?? null,
          cycleAgentSpendUsd:
            teamAgentStateMap.get(teamName)?.cycleAgentSpendUsd ?? 0,
          agentRemainingUsd:
            teamAgentStateMap.get(teamName)?.agentRemainingUsd ?? null,
          agentPercentUsed:
            teamAgentStateMap.get(teamName)?.agentPercentUsed ?? null,
          agentBlocked: teamAgentStateMap.get(teamName)?.agentBlocked ?? false,
          groups: [],
          families: [],
        });
      }
    }

    return teamSections;
  }, [
    groups,
    teamBudgetMap,
    teamAgentStateMap,
    groupsData,
    usageAvailable,
    isAccountWide,
    workspaceTeamSpendMap,
    workspaceTeamBudgetMap,
    visibleNonlegacyTeamNames,
    showLegacyGroups,
  ]);

  const toggleTeam = (teamKey: string) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamKey)) next.delete(teamKey);
      else next.add(teamKey);
      return next;
    });
  };

  const statCards = [
    {
      title: "Total Spend",
      value: summary ? `$${summary.totalSpendUsd.toFixed(2)}` : "—",
      description:
        summary?.billingPeriodLabel ??
        groupsData?.billingPeriodLabel ??
        "Current period",
      icon: DollarSign,
    },
    {
      title: "Total Budget",
      value: summary ? `$${summary.totalBudgetUsd.toFixed(2)}` : "—",
      description: `${summary?.budgetedGroups ?? 0} visible groups budgeted`,
      icon: TrendingUp,
    },
    {
      title: "Remaining",
      value:
        summary?.totalRemainingUsd != null
          ? `$${summary.totalRemainingUsd.toFixed(2)}`
          : "—",
      description: "Across visible budgeted pools",
      icon: Wallet,
      valueClassName:
        (summary?.totalRemainingUsd ?? 0) < 0 ? "text-destructive" : "",
    },
    {
      title: "Over Threshold",
      value: summary ? summary.groupsOver75.toString() : "—",
      description: `${summary?.groupsOver100 ?? 0} over budget`,
      icon: AlertTriangle,
    },
    {
      title: "Alerts Sent",
      value: summary ? summary.alertsSentThisPeriod.toString() : "—",
      description: "This billing period",
      icon: RefreshCw,
    },
  ].filter(
    (card) => !(role === "workspace_admin" && card.title === "Alerts Sent"),
  );

  const renderGroupRow = (group: (typeof groups)[0]) => {
    const hasBudget = group.budgetUsd != null && group.budgetUsd > 0;
    const displaySpend = group.spendUsd ?? 0;
    const displayRemaining = hasBudget
      ? (group.remainingUsd ?? group.budgetUsd! - displaySpend)
      : null;
    const displayPercentUsed = hasBudget
      ? (group.percentUsed ?? (displaySpend / group.budgetUsd!) * 100)
      : null;

    return (
      <tr
        key={group.groupId}
        className={`border-b border-border transition-colors group ${
          group.isSynthetic ? "bg-muted/10" : "hover:bg-muted/50 cursor-pointer"
        }`}
        data-testid={`row-group-${group.groupId}`}
        tabIndex={group.isSynthetic ? undefined : 0}
        onClick={(e) => {
          if (group.isSynthetic) return;
          if ((e.target as HTMLElement).closest("button, input, a")) return;
          setLocation(`/groups/${group.groupId}`);
        }}
        onKeyDown={(e) => {
          if (group.isSynthetic || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          setLocation(`/groups/${group.groupId}`);
        }}
      >
        <td className="py-3 px-4 pl-10">
          <div className="flex flex-col">
            <span
              className="text-sm font-medium"
              data-testid={`text-group-name-${group.groupId}`}
            >
              {group.name}
            </span>
            <span className="flex items-center gap-1">
              <Badge
                variant="outline"
                className={`text-[9px] h-4 px-1 ${roleBadgeClass(group.role)}`}
              >
                {roleLabel(group.role)}
              </Badge>
              {group.isLegacy && (
                <Badge variant="outline" className="text-[9px] h-4 px-1">
                  Legacy
                </Badge>
              )}
            </span>
          </div>
        </td>
        <td className="py-3 px-4">
          <span
            className="text-sm"
            data-testid={`text-workspace-${group.groupId}`}
          >
            {group.workspaceName || "—"}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span
            className="text-sm font-mono tabular-nums"
            data-testid={`text-members-${group.groupId}`}
          >
            {group.memberCount ?? "—"}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span
            className="text-sm font-mono tabular-nums"
            data-testid={`text-spend-${group.groupId}`}
          >
            ${displaySpend.toFixed(2)}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <div className="flex flex-col items-end gap-1">
            {capabilities.canWriteGroupLimits ? (
              <BudgetInput
                groupId={group.groupId}
                currentBudget={group.budgetUsd ?? null}
              />
            ) : (
              <span
                className="text-sm font-mono tabular-nums"
                data-testid={`text-budget-${group.groupId}`}
              >
                {group.budgetUsd !== null && group.budgetUsd !== undefined
                  ? `$${group.budgetUsd.toFixed(2)}`
                  : "—"}
              </span>
            )}
            {group.budgetSource && (
              <Badge
                variant="secondary"
                className="text-[9px] h-4 px-1 py-0 uppercase bg-muted/50"
                title={`Budget source: ${group.budgetSource}`}
              >
                {group.budgetSource}
              </Badge>
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-right">
          {displayRemaining === null ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span
              className={`text-sm font-mono tabular-nums ${displayRemaining < 0 ? "text-destructive font-bold" : ""}`}
            >
              ${displayRemaining.toFixed(2)}
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right">
          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
            {displayPercentUsed === null ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {group.agentBlocked && (
                    <Badge
                      variant="destructive"
                      className="uppercase text-[10px]"
                      data-testid={`badge-blocked-group-${group.groupId}`}
                      title={`Agent spend $${group.cycleAgentSpendUsd.toFixed(2)} of ${group.monthlyAgentLimitUsd == null ? "no limit" : `$${group.monthlyAgentLimitUsd.toFixed(2)}`}`}
                    >
                      Blocked
                    </Badge>
                  )}
                  <ThresholdBadge
                    percentUsed={displayPercentUsed}
                    thresholdsFired={group.thresholdsFired}
                  />
                </div>
                <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                  <div
                    className={`h-full transition-all duration-500 ${displayPercentUsed >= 100 ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${Math.min(displayPercentUsed, 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-right">
          <PaceCell
            spendUsd={group.paceSpendUsd ?? 0}
            budgetUsd={group.budgetUsd ?? null}
            periodStart={summary?.pacePeriodStart ?? ""}
            periodEnd={summary?.pacePeriodEnd ?? ""}
            periodLabel={summary?.pacePeriodLabel ?? ""}
            isFallback={summary?.pacePeriodIsFallback ?? true}
          />
        </td>
      </tr>
    );
  };

  const renderClusterRow = (
    family: GroupFamilyHierarchy,
    workspaceName: string,
  ) => {
    const uniqueRoles = [...new Set(family.groups.map((group) => group.role))];
    const groupIds = family.groups.map((group) => group.groupId);
    const clusterUrl = `/clusters?ids=${encodeURIComponent(groupIds.join(","))}`;
    return (
      <tr
        key={family.familyKey}
        className="border-b border-border hover:bg-muted/50 transition-colors cursor-pointer"
        tabIndex={0}
        onClick={() => setLocation(clusterUrl)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setLocation(clusterUrl);
        }}
      >
        <td className="py-3 px-4 pl-10">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{family.familyName}</span>
            {family.isLegacy && (
              <Badge variant="outline" className="w-fit text-[9px] h-4 px-1">
                Legacy
              </Badge>
            )}
            <div className="flex items-center gap-1">
              <Layers className="h-3 w-3 text-muted-foreground" />
              <div className="flex gap-1">
                {uniqueRoles.map((r) => (
                  <span
                    key={r}
                    className={`inline-flex items-center border rounded px-1.5 py-0 text-[9px] font-medium ${roleBadgeClass(r)}`}
                  >
                    {roleLabel(r)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </td>
        <td className="py-3 px-4">
          <span className="text-sm text-muted-foreground">
            {workspaceName || "—"}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm font-mono tabular-nums">
            {family.memberCount}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span
            className="text-sm font-mono tabular-nums"
          >
            ${family.spendUsd.toFixed(2)}
          </span>
        </td>
        {/* Budget, Remaining, Usage, Pace — not applicable at cluster level */}
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
      </tr>
    );
  };

  const renderTeamGroups = (team: TeamSection) => {
    return team.families.flatMap((family) => [
      renderClusterRow(family, team.workspaceName),
      ...family.groups.map((group) => renderGroupRow(group)),
    ]);
  };

  const renderTeamHeader = (team: TeamSection) => {
    const isBudgetOnlyWorkspace = team.workspaceId === "__budget_only__";
    const teamKey = `${team.workspaceId}::${team.teamName}`;
    const expanded = expandedTeams.has(teamKey);
    const hasBudget = team.budgetUsd !== null && team.budgetUsd > 0;
    const displayRemaining = hasBudget ? team.budgetUsd! - team.spendUsd : null;
    const displayPercentUsed = hasBudget
      ? (team.spendUsd / team.budgetUsd!) * 100
      : null;
    const clusterCount = team.families.length;

    if (isBudgetOnlyWorkspace) {
      return (
        <tr
          key={`team-${teamKey}`}
          className="border-b border-border transition-colors group select-none hover:bg-muted/50"
          data-testid={`row-team-${team.teamName}`}
        >
          <td className="py-3 px-4 text-sm" colSpan={1}>
            <div className="flex items-center gap-2">
              <span className="w-4" aria-hidden="true" />
              <span className="font-medium text-muted-foreground">
                {team.teamName}
              </span>
            </div>
          </td>
          <td className="py-3 px-4">
            <span className="text-sm text-muted-foreground opacity-50">—</span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm font-mono tabular-nums text-muted-foreground opacity-50">
              0
            </span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm font-mono tabular-nums text-muted-foreground opacity-50">
              $0.00
            </span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm font-mono tabular-nums font-semibold">
              {team.budgetUsd !== null && team.budgetUsd !== undefined
                ? `$${team.budgetUsd.toFixed(2)}`
                : "—"}
            </span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm font-mono tabular-nums text-muted-foreground">
              {team.budgetUsd !== null && team.budgetUsd !== undefined
                ? `$${team.budgetUsd.toFixed(2)}`
                : "—"}
            </span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm font-mono tabular-nums text-muted-foreground opacity-50">
              0.0%
            </span>
          </td>
          <td className="py-3 px-4 text-right">
            <span className="text-sm text-muted-foreground opacity-50">—</span>
          </td>
        </tr>
      );
    }

    return (
      <tr
        key={`team-${teamKey}`}
        className={`border-b border-border bg-muted/30 transition-colors group select-none ${
          clusterCount > 0 ? "hover:bg-muted/50 cursor-pointer" : ""
        }`}
        data-testid={`row-team-${team.teamName}`}
        tabIndex={clusterCount > 0 ? 0 : undefined}
        onClick={() => {
          if (clusterCount > 0) toggleTeam(teamKey);
        }}
        onKeyDown={(e) => {
          if (clusterCount === 0 || (e.key !== "Enter" && e.key !== " "))
            return;
          e.preventDefault();
          toggleTeam(teamKey);
        }}
      >
        <td className="py-3 px-4 font-semibold text-sm" colSpan={1}>
          <div className="flex items-center gap-2">
            {clusterCount > 0 ? (
              expanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              )
            ) : (
              <span className="w-4" aria-hidden="true" />
            )}
            <span>{team.teamName}</span>
            {team.agentBlocked && (
              <Badge
                variant="destructive"
                className="uppercase text-[9px] h-4 px-1"
                data-testid={`badge-blocked-team-${team.teamName}`}
                title={`Agent spend $${team.cycleAgentSpendUsd.toFixed(2)} of ${team.monthlyAgentLimitUsd == null ? "no limit" : `$${team.monthlyAgentLimitUsd.toFixed(2)}`}`}
              >
                Blocked
              </Badge>
            )}
            {team.budgetIsShared && (
              <Badge
                variant="outline"
                className="text-[9px] h-4 px-1 ml-1 font-normal"
                title={
                  team.budgetAllocationMethod === "equal"
                    ? "Workspace share of a shared team budget, split equally because current visible spend is zero."
                    : "Workspace share of a shared team budget, allocated by current visible spend."
                }
              >
                Shared budget share
              </Badge>
            )}
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1 ml-1 font-normal"
            >
              {clusterCount > 0
                ? `${clusterCount} famil${clusterCount !== 1 ? "ies" : "y"}`
                : "Budget only"}
            </Badge>
          </div>
        </td>
        <td className="py-3 px-4">
          {/* workspace col — blank for team header */}
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm font-mono tabular-nums font-semibold">
            {team.memberCount}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span
            className="text-sm font-mono tabular-nums font-semibold"
          >
            ${team.spendUsd.toFixed(2)}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span
            className="text-sm font-mono tabular-nums font-semibold"
            data-testid={`text-team-budget-${team.workspaceId}-${team.teamName}`}
            title={
              team.budgetIsShared
                ? team.budgetAllocationMethod === "equal"
                  ? "Workspace share of a shared team budget, split equally because current visible spend is zero."
                  : "Workspace share of a shared team budget, allocated by current visible spend."
                : undefined
            }
          >
            {team.budgetUsd !== null && team.budgetUsd !== undefined
              ? `$${team.budgetUsd.toFixed(2)}`
              : "—"}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          {displayRemaining === null ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span
              className={`text-sm font-mono tabular-nums font-semibold ${displayRemaining < 0 ? "text-destructive" : ""}`}
            >
              ${displayRemaining.toFixed(2)}
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right">
          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
            {displayPercentUsed === null ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              <>
                <span
                  className={`text-xs font-mono tabular-nums font-semibold ${displayPercentUsed >= 100 ? "text-destructive" : displayPercentUsed >= 75 ? "text-yellow-600" : ""}`}
                >
                  {displayPercentUsed.toFixed(1)}%
                </span>
                <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                  <div
                    className={`h-full transition-all duration-500 ${displayPercentUsed >= 100 ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${Math.min(displayPercentUsed, 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-right">
          <PaceCell
            spendUsd={team.paceSpendUsd}
            budgetUsd={team.budgetUsd}
            semibold
            periodStart={summary?.pacePeriodStart ?? ""}
            periodEnd={summary?.pacePeriodEnd ?? ""}
            periodLabel={summary?.pacePeriodLabel ?? ""}
            isFallback={summary?.pacePeriodIsFallback ?? true}
          />
        </td>
      </tr>
    );
  };

  const workspaceSections = useMemo(() => {
    const sections = (groupsData?.hierarchy ?? []).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName ?? workspace.workspaceId,
      teams: teamSections.filter(
        (team) => team.workspaceId === workspace.workspaceId,
      ),
      unassigned: role === "team_admin"
        ? []
        : workspace.teams
            .filter((team) => team.teamName === null)
            .flatMap((team) =>
              team.families
                .filter((family) => showLegacyGroups || !family.isLegacy)
                .flatMap((family) => family.groups),
            ),
    })).filter(
      (workspace) =>
        workspace.teams.length > 0 || workspace.unassigned.length > 0,
    );
    const budgetOnlyTeams = teamSections.filter(
      (team) => team.workspaceId === "__budget_only__",
    );
    if (budgetOnlyTeams.length > 0) {
      sections.push({
        workspaceId: "__budget_only__",
        workspaceName: "Unallocated Budgets",
        teams: budgetOnlyTeams,
        unassigned: [],
      });
    }
    return sections;
  }, [groupsData?.hierarchy, role, showLegacyGroups, teamSections]);

  const renderWorkspaceHeader = (
    workspace: (typeof workspaceSections)[number],
  ) => {
    const unassignedTotals = workspace.unassigned.reduce(
      (total, group) => ({
        memberCount: total.memberCount + group.rollupMemberCount,
        spendUsd: total.spendUsd + group.rollupSpendUsd,
      }),
      { memberCount: 0, spendUsd: 0 },
    );
    const memberCount = workspace.teams.reduce(
      (sum, team) => sum + team.memberCount,
      unassignedTotals.memberCount,
    );
    const spendUsd = workspace.teams.reduce(
      (sum, team) => sum + team.spendUsd,
      unassignedTotals.spendUsd,
    );
    const budgetUsd =
      workspace.teams.reduce((sum, team) => sum + (team.budgetUsd ?? 0), 0) +
      workspace.unassigned.reduce(
        (sum, group) => sum + (group.budgetUsd ?? 0),
        0,
      );
    const isBudgetOnlyWorkspace = workspace.workspaceId === "__budget_only__";

    return (
      <tr
        key={`workspace-${workspace.workspaceId}`}
        className="border-b border-border bg-muted/60"
      >
        <th className="py-3 px-4 text-left text-sm font-bold" colSpan={2}>
          {isBudgetOnlyWorkspace
            ? "Unallocated Budgets"
            : workspace.workspaceName}
          {!isBudgetOnlyWorkspace && (
            <Badge variant="outline" className="ml-2 text-[9px]">
              Workspace
            </Badge>
          )}
        </th>
        <td className="py-3 px-4 text-right text-sm font-mono font-bold">
          {isBudgetOnlyWorkspace ? (
            <span className="text-muted-foreground font-sans font-normal">
              —
            </span>
          ) : (
            memberCount
          )}
        </td>
        <td className="py-3 px-4 text-right text-sm font-mono font-bold">
          {isBudgetOnlyWorkspace ? (
            <span className="text-muted-foreground font-sans font-normal">
              —
            </span>
          ) : (
            `$${spendUsd.toFixed(2)}`
          )}
        </td>
        <td className="py-3 px-4 text-right text-sm font-mono font-bold">
          {budgetUsd > 0 ? `$${budgetUsd.toFixed(2)}` : "—"}
        </td>
        <td className="py-3 px-4 text-right text-sm font-mono font-bold">
          {budgetUsd > 0
            ? `$${(budgetUsd - (isBudgetOnlyWorkspace ? 0 : spendUsd)).toFixed(2)}`
            : "—"}
        </td>
        <td className="py-3 px-4 text-right text-sm font-mono font-bold">
          {budgetUsd > 0 && !isBudgetOnlyWorkspace ? (
            `${((spendUsd / budgetUsd) * 100).toFixed(1)}%`
          ) : (
            <span className="text-muted-foreground font-sans font-normal">
              —
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right text-sm text-muted-foreground">
          —
        </td>
      </tr>
    );
  };

  const hasTeams = workspaceSections.length > 0;
  const scopedWorkspaceNames = [
    ...new Set(
      groups
        .map((group) => group.workspaceName?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const scopedTeamNames = [
    ...new Set(
      (auth?.teamNames.length
        ? auth.teamNames
        : groups.map((group) => group.teamName)
      )
        .map((name) => name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const accountUserName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.email?.split("@")[0] ||
    "";
  const scopedMemberName =
    memberCycleActivity?.users[0]?.username ||
    memberTermActivity?.users[0]?.username ||
    "";
  const memberName = auth?.isPreview
    ? scopedMemberName
    : accountUserName || scopedMemberName;
  const dashboardTitle =
    role === "workspace_admin"
      ? scopedWorkspaceNames.length === 1
        ? `${scopedWorkspaceNames[0]} Workspace Dashboard`
        : scopedWorkspaceNames.length > 1
          ? `${scopedWorkspaceNames.length} Workspaces Dashboard`
          : "Workspace Dashboard"
      : role === "team_admin"
        ? scopedTeamNames.length === 1
          ? `${scopedTeamNames[0]} Group Dashboard`
          : scopedTeamNames.length > 1
            ? `${scopedTeamNames.length} Groups Dashboard`
            : "Group Dashboard"
        : role === "member"
          ? memberName
            ? `${memberName}${memberName.endsWith("s") ? "'" : "'s"} Dashboard`
            : "My Dashboard"
          : "Comcast Account Dashboard";
  const rangePresetLabel = {
    "full-term": "Full term",
    billing: "Billing period",
    mtd: "Month to date",
    ytd: "Year to date",
    custom: "Custom range",
  }[rangeSelection];
  const selectedRangeLabel =
    rangeSelection === "full-term"
      ? "May 20, 2026–present"
      : groupsData?.billingPeriodLabel ??
        summary?.billingPeriodLabel ??
        rangePresetLabel;

  if (role === "member") {
    const cycleUser = memberCycleActivity?.users[0];
    const termUser = memberTermActivity?.users[0];
    const effectiveUserId = cycleUser?.userId ?? termUser?.userId ?? user?.id;
    const limits = memberLimitQueries
      .map((query) => query.data)
      .filter((response) => response)
      .map((response) => ({
        workspaceName: response!.workspaceName,
        budget:
          response!.members.find((member) => member.userId === effectiveUserId)
            ?.budgetUsd ?? null,
      }));

    return (
      <div className="p-4 md:p-8">
        <Card className="mx-auto max-w-3xl" data-testid="card-member-dashboard">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle data-testid="text-dashboard-title">
                {dashboardTitle}
              </CardTitle>
              {(cycleUser?.isInternal || termUser?.isInternal) && <InternalUserBadge />}
            </div>
            <CardDescription>
              Your server-scoped usage, limits, and group memberships.
            </CardDescription>
            {(cycleUser?.isInternal || termUser?.isInternal) && <InternalSpendExplanation />}
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  Current cycle Agent spend
                </p>
                <p
                  className="text-2xl font-bold font-mono tabular-nums"
                  data-testid="text-member-cycle-spend"
                >
                  {cycleUser ? `$${cycleUser.aiSpendUsd.toFixed(2)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Contract-to-date spend
                </p>
                <p
                  className="text-2xl font-bold font-mono tabular-nums"
                  data-testid="text-member-contract-spend"
                >
                  {termUser ? `$${termUser.spendUsd.toFixed(2)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Per-user limit</p>
                <div className="space-y-1" data-testid="text-member-limits">
                  {limits.length ? (
                    limits.map((limit) => (
                      <p key={limit.workspaceName} className="text-sm">
                        <span className="font-mono font-semibold">
                          {limit.budget == null
                            ? "—"
                            : `$${limit.budget.toFixed(2)}`}
                        </span>
                        {limits.length > 1 && (
                          <span className="ml-1 text-muted-foreground">
                            · {limit.workspaceName}
                          </span>
                        )}
                      </p>
                    ))
                  ) : (
                    <p className="text-2xl font-bold">—</p>
                  )}
                </div>
              </div>
            </div>
            <div className="border-t pt-4">
              <h2 className="text-sm font-semibold">My groups</h2>
              <div
                className="mt-2 flex flex-wrap gap-2"
                data-testid="list-member-groups"
              >
                {groups.length ? (
                  groups.map((group) => (
                    <Badge key={group.groupId} variant="secondary">
                      {group.name}
                      {group.workspaceName ? ` · ${group.workspaceName}` : ""}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No groups found.
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold tracking-tight"
            data-testid="text-dashboard-title"
          >
            {dashboardTitle}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RangeFilter selectedLabel={selectedRangeLabel} />
        </div>
      </div>
      {groupsData?.usageHealth.status === "empty" && (
        <p
          className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
          data-testid="empty-usage-data"
        >
          No usage data is available for this period.
        </p>
      )}
      {summary && (
        <p className="text-xs text-muted-foreground">
          Reporting period: {selectedRangeLabel}
        </p>
      )}
      {rangeType === "billing" &&
        summary?.billingPeriodDiffersFromReportingCutoff && (
          <div
            className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm"
            data-testid="billing-window-banner"
          >
            Total Spend uses the verified Enterprise billing window shown above,
            beginning{" "}
            {new Date(summary.reportingRangeStart).toLocaleDateString()}, rather
            than the earlier data-availability cutoff.
          </div>
        )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card
              key={stat.title}
              data-testid={`card-stat-${stat.title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 md:p-6 md:pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
                <div
                  className={`text-xl sm:text-2xl font-bold font-mono tabular-nums ${stat.valueClassName || ""}`}
                  data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {stat.value}
                </div>
                <p className="text-xs text-muted-foreground mt-1 whitespace-nowrap overflow-hidden text-ellipsis">
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="groups" className="space-y-4">
        <TabsContent value="groups">
          <Card>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed" data-testid="table-groups">
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[12%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10%]" />
                    <col className="w-[10%]" />
                    <col className="w-[11%]" />
                    <col className="w-[10%]" />
                    <col className="w-[13%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4"></th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4"></th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                        Members
                      </th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                        Spend
                      </th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                        Budget
                      </th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                        Remaining
                      </th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                        Usage
                      </th>
                      <th
                        className="whitespace-nowrap text-right text-xs font-medium text-muted-foreground py-3 px-4"
                        title="Projected total spend by May 17 2027 vs budget"
                      >
                        Pace <span className="font-normal opacity-60">→ May '27</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {hasTeams ? (
                      <>
                        {workspaceSections.map((workspace) => (
                          <React.Fragment
                            key={`workspace-section-${workspace.workspaceId}`}
                          >
                            {renderWorkspaceHeader(workspace)}
                            {workspace.teams.map((team) => {
                              const teamKey = `${team.workspaceId}::${team.teamName}`;
                              return (
                                <React.Fragment key={`team-section-${teamKey}`}>
                                  {renderTeamHeader(team)}
                                  {expandedTeams.has(teamKey) &&
                                    renderTeamGroups(team)}
                                </React.Fragment>
                              );
                            })}
                            {workspace.unassigned.length > 0 && (
                              <UnassignedSummaryRow
                                key={`team-section-unassigned-${workspace.workspaceId}`}
                                workspaceId={workspace.workspaceId}
                                groups={workspace.unassigned}
                              />
                            )}
                          </React.Fragment>
                        ))}
                      </>
                    ) : (
                      [...groups]
                        .sort((a, b) =>
                          a.name.localeCompare(b.name, undefined, {
                            sensitivity: "base",
                          }),
                        )
                        .map((group) => renderGroupRow(group))
                    )}
                    {summary &&
                      (isAccountWide ||
                        summary.usageHealth.accountWorkspaceUnreconciledUsd >
                          0) && (
                        <tr
                          className="border-b border-border bg-muted/10"
                          data-testid={
                            isAccountWide
                              ? "row-account-reconciliation"
                              : "row-unattributed-projects"
                          }
                        >
                          <td className="py-3 px-4">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium italic">
                                {isAccountWide
                                  ? "True unattributed residual"
                                  : "Unattributed project residual"}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {isAccountWide
                                  ? "No group/project ID, missing creator, or creator no longer a member"
                                  : "No project ID, missing creator, or creator no longer a member"}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-sm text-muted-foreground">
                            —
                          </td>
                          <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                            —
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="text-sm font-mono tabular-nums">
                              $
                              {summary.usageHealth.accountWorkspaceUnreconciledUsd.toFixed(
                                2,
                              )}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                            —
                          </td>
                          <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                            —
                          </td>
                          <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                            —
                          </td>
                          <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                            —
                          </td>
                        </tr>
                      )}
                  </tbody>
                  {groups.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                        <td className="py-3 px-4 text-sm">Total</td>
                        <td className="py-3 px-4" />
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">
                            {groups.reduce(
                              (s, g) => s + g.rollupMemberCount,
                              0,
                            )}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">
                            {summary
                              ? `$${summary.totalSpendUsd.toFixed(2)}`
                              : "—"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">
                            {summary
                              ? `$${summary.totalBudgetUsd.toFixed(2)}`
                              : "—"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span
                            className={`text-sm font-mono tabular-nums ${(summary?.totalRemainingUsd ?? 0) < 0 ? "text-destructive" : ""}`}
                          >
                            {summary?.totalRemainingUsd != null
                              ? `$${summary.totalRemainingUsd.toFixed(2)}`
                              : "—"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {summary && summary.totalBudgetUsd > 0 ? (
                            <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
                              <span
                                className={`text-xs font-mono tabular-nums ${(summary.totalSpendUsd / summary.totalBudgetUsd) * 100 >= 100 ? "text-destructive" : ""}`}
                              >
                                {(
                                  (summary.totalSpendUsd /
                                    summary.totalBudgetUsd) *
                                  100
                                ).toFixed(1)}
                                %
                              </span>
                              <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                                <div
                                  className={`h-full transition-all duration-500 ${(summary.totalSpendUsd / summary.totalBudgetUsd) * 100 >= 100 ? "bg-destructive" : "bg-primary"}`}
                                  style={{
                                    width: `${Math.min((summary.totalSpendUsd / summary.totalBudgetUsd) * 100, 100)}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm text-muted-foreground">
                            —
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
                {groups.length === 0 && (
                  <div
                    className="text-center py-12 text-muted-foreground"
                    data-testid="text-no-groups"
                  >
                    No groups found
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
