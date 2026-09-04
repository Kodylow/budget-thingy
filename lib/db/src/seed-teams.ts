/**
 * Seeds group→team mapping and team budgets into the database.
 * Run with: pnpm --filter @workspace/db seed
 */
import { db } from "./index.js";
import {
  familyTeamMappingsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
  workspaceDefaultLimitTargetsTable,
} from "./schema/index.js";
import { eq } from "drizzle-orm";

export const LEGACY_WORKSPACE_ID = "1awqan";

export const FAMILY_TEAM_OVERRIDES = new Map<string, string>([
  ["finance", "Finance"],
  ["growth strategy & operations", "DXP"],
  ["strategic development mosaic", "Strategic Development Mosaic"],
  ["preprod", "PREPROD"],
]);

export interface SeededTeamLimitTarget {
  teamName: string;
  workspaceId: string;
  groupId: string;
  groupName: string;
}

/**
 * Stable upstream identities from the approved allocation workbook. New
 * directory families are discovered by the API, while these known targets are
 * installed explicitly so a clean database has the approved starting point.
 */
export const SEEDED_TEAM_LIMIT_TARGETS: SeededTeamLimitTarget[] = [
  { teamName: "Comcast Advertising", workspaceId: "h7b8kqg88e", groupId: "8BGWR2yj", groupName: "AZ-Replit - Comcast Advertising - Member" },
  { teamName: "Comcast Business Consumer Solutions", workspaceId: "66ox9cntlf", groupId: "biqK255d", groupName: "AZ-Replit - Comcast Business Customer Solutions - Member" },
  { teamName: "Comcast Business Marketing", workspaceId: "66ox9cntlf", groupId: "Wbmoq9om", groupName: "AZ-Replit - Comcast Business Marketing - Member" },
  { teamName: "Content Acquisition", workspaceId: "5hkg15xcxd", groupId: "bVhKuOQM", groupName: "AZ-Replit - Content Acquisition - Member" },
  { teamName: "Corporate Communications", workspaceId: "stk0jl35jw", groupId: "qDIUFV0h", groupName: "AZ-Replit - Corporate Communications - Member" },
  { teamName: "DXP", workspaceId: "ntcqubwqvl", groupId: "gzeQpyya", groupName: "AZ-Replit - Growth Strategy & Operations - Member" },
  { teamName: "EBI AI ML", workspaceId: "nu6ymuuhox", groupId: "vvH4cngU", groupName: "AZ-Replit - EBI AI ML - Member" },
  { teamName: "EBI Enterprise Analytics", workspaceId: "nu6ymuuhox", groupId: "OmRC2GN1", groupName: "AZ-Replit - EBI Enterprise Analytics - Member" },
  { teamName: "Finance", workspaceId: "8h7pfz", groupId: "59T5lQxS", groupName: "AZ-Replit - Finance - Member" },
  { teamName: "Finance", workspaceId: "ha7tj2", groupId: "tT7F9xlt", groupName: "AZ-Replit - Finance - Member" },
  { teamName: "Freewheel", workspaceId: "ysf55yjzku", groupId: "9X1LGLv2", groupName: "AZ-Replit - Freewheel - Member" },
  { teamName: "GPO Connected Living", workspaceId: "zigw1yqwrb", groupId: "NSZwFPKE", groupName: "AZ-Replit - GPO Connected Living - Member" },
  { teamName: "GPO Creative Services", workspaceId: "zigw1yqwrb", groupId: "V0wOlcBL", groupName: "AZ-Replit - GPO Creative Services - Member" },
  { teamName: "GPO CTS", workspaceId: "zigw1yqwrb", groupId: "q68m2wbl", groupName: "AZ-Replit - GPO CTS - Member" },
  { teamName: "Growth CXSO Account Mgmt", workspaceId: "ntcqubwqvl", groupId: "32m70Gl8", groupName: "AZ-Replit - Growth CXSO Account Mgmt - Member" },
  { teamName: "Growth MDU", workspaceId: "ntcqubwqvl", groupId: "ePu7SSUX", groupName: "AZ-Replit - Growth MDU - Member" },
  { teamName: "Growth Xfinity Consumer Product Marketing", workspaceId: "ntcqubwqvl", groupId: "KBE16XLQ", groupName: "AZ-Replit - Growth Xfinity Consumer Product Marketing - Member" },
  { teamName: "HR Compensation", workspaceId: "znvqc2gqxf", groupId: "RQ7HKxG4", groupName: "AZ-Replit - HR Compensation - Member" },
  { teamName: "NBCU", workspaceId: "hewdniynr3", groupId: "pPymZapr", groupName: "AZ-Replit - NBCU - Member" },
  { teamName: "Strategic Development LIFT Labs", workspaceId: "6g8nnwm9cc", groupId: "BHEytHnP", groupName: "AZ-Replit - Strategic Development LIFT Labs - Member" },
  { teamName: "Strategic Development Mosaic", workspaceId: "6g8nnwm9cc", groupId: "C4ZqSTcM", groupName: "AZ-Replit - Strategic Development Mosaic - Member" },
  { teamName: "Talent and Learning", workspaceId: "5b0iso4ru5", groupId: "n9GetIm5", groupName: "AZ-Replit - Talent and Learning - Member" },
  { teamName: "TPX IT", workspaceId: "rpyg1v7i9q", groupId: "ac7UK3Ql", groupName: "AZ-Replit - TPX IT - Member" },
  { teamName: "Wireless", workspaceId: "hyjfq2n04a", groupId: "mEEk0Sgn", groupName: "AZ-Replit - Wireless - Member" },
];

export interface DiscoveredFamilyMapping {
  workspaceId: string;
  familyKey: string;
  familyName: string;
  isLegacy: boolean;
  groupIds?: readonly string[];
}

function normalizeSeedFamilyKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function familyNameFromGroupName(groupName: string): string {
  return groupName
    .replace(/^az-replit\s*-\s*/i, "")
    .replace(/\s*-\s*(?:admins?|members?|viewers?|guests?)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function collisionSafeFamilyTeamName(
  familyName: string,
  workspaceId: string,
  hasNonlegacyCollision: boolean,
): string {
  return hasNonlegacyCollision ? `${familyName} [${workspaceId}]` : familyName;
}

/**
 * Persists every discovered family without changing an existing explicit team
 * assignment. Legacy siblings inherit the resolved nonlegacy assignment.
 */
export async function applyFamilyMappingBackfill(
  discovered: readonly DiscoveredFamilyMapping[],
): Promise<(typeof familyTeamMappingsTable.$inferSelect)[]> {
  return db.transaction(async (tx) => {
    const [existing, exactTargets] = await Promise.all([
      tx.select().from(familyTeamMappingsTable),
      tx.select({
        workspaceId: teamLimitTargetsTable.workspaceId,
        groupId: teamLimitTargetsTable.groupId,
        teamName: teamLimitTargetsTable.teamName,
        assignmentSource: teamLimitTargetsTable.assignmentSource,
      }).from(teamLimitTargetsTable),
    ]);
    const existingByIdentity = new Map(
      existing.map((row) => [`${row.workspaceId}\0${row.familyKey}`, row]),
    );
    const discoveredNonlegacyIdentitiesByKey = new Map<string, Set<string>>();
    for (const family of discovered) {
      if (family.isLegacy) continue;
      const identities = discoveredNonlegacyIdentitiesByKey.get(family.familyKey) ??
        new Set<string>();
      identities.add(`${family.workspaceId}\0${family.familyKey}`);
      discoveredNonlegacyIdentitiesByKey.set(family.familyKey, identities);
    }
    const exactTeamsByIdentity = new Map<string, Set<string>>();
    for (const target of exactTargets) {
      const discoveredFamily = discovered.find((family) =>
        !family.isLegacy &&
        family.workspaceId === target.workspaceId &&
        family.groupIds?.includes(target.groupId)
      );
      if (!discoveredFamily) continue;
      if (target.assignmentSource === "automatic") continue;
      const hasCollision =
        (discoveredNonlegacyIdentitiesByKey.get(discoveredFamily.familyKey)?.size ?? 0) > 1;
      if (
        target.assignmentSource === "unconfirmed" &&
        hasCollision &&
        !FAMILY_TEAM_OVERRIDES.has(discoveredFamily.familyKey) &&
        normalizeSeedFamilyKey(target.teamName) ===
          normalizeSeedFamilyKey(discoveredFamily.familyName)
      ) {
        continue;
      }
      const identity = `${discoveredFamily.workspaceId}\0${discoveredFamily.familyKey}`;
      const teams = exactTeamsByIdentity.get(identity) ?? new Set<string>();
      teams.add(target.teamName);
      exactTeamsByIdentity.set(identity, teams);
    }
    const resolvedNonlegacyByIdentity = new Map<string, {
      familyKey: string;
      teamName: string;
    }>();
    for (const row of existing) {
      if (!row.isLegacy && row.teamName) {
        resolvedNonlegacyByIdentity.set(`${row.workspaceId}\0${row.familyKey}`, {
          familyKey: row.familyKey,
          teamName: row.teamName,
        });
      }
    }
    for (const family of discovered) {
      if (family.isLegacy) continue;
      const identity = `${family.workspaceId}\0${family.familyKey}`;
      const current = existingByIdentity.get(identity);
      const exactTeams = exactTeamsByIdentity.get(identity);
      const hasCollision =
        (discoveredNonlegacyIdentitiesByKey.get(family.familyKey)?.size ?? 0) > 1;
      const automaticDefault = collisionSafeFamilyTeamName(
        family.familyName,
        family.workspaceId,
        hasCollision,
      );
      const currentIsPlainAutomatic =
        current?.teamName == null ||
        normalizeSeedFamilyKey(current.teamName) === normalizeSeedFamilyKey(family.familyName);
      resolvedNonlegacyByIdentity.set(identity, {
        familyKey: family.familyKey,
        teamName: FAMILY_TEAM_OVERRIDES.get(family.familyKey) ??
          (exactTeams?.size === 1 ? [...exactTeams][0]! : undefined) ??
          (!currentIsPlainAutomatic ? current!.teamName! : automaticDefault),
      });
    }
    const nonlegacyTeamsByKey = new Map<string, Set<string>>();
    for (const resolved of resolvedNonlegacyByIdentity.values()) {
      const teams = nonlegacyTeamsByKey.get(resolved.familyKey) ?? new Set<string>();
      teams.add(resolved.teamName);
      nonlegacyTeamsByKey.set(resolved.familyKey, teams);
    }

    for (const family of discovered) {
      const current = existingByIdentity.get(`${family.workspaceId}\0${family.familyKey}`);
      const override = FAMILY_TEAM_OVERRIDES.get(family.familyKey);
      const nonlegacyTeams = nonlegacyTeamsByKey.get(family.familyKey);
      const teamName = override ??
        (family.isLegacy
          ? nonlegacyTeams?.size === 1 ? [...nonlegacyTeams][0]! : null
          : resolvedNonlegacyByIdentity
              .get(`${family.workspaceId}\0${family.familyKey}`)!.teamName);
      await tx.insert(familyTeamMappingsTable).values({ ...family, teamName })
        .onConflictDoUpdate({
          target: [
            familyTeamMappingsTable.workspaceId,
            familyTeamMappingsTable.familyKey,
          ],
          set: {
            familyName: family.familyName,
            teamName,
            isLegacy: family.isLegacy,
          },
        });
    }
    return tx.select().from(familyTeamMappingsTable);
  });
}

export const BASELINE_GROUP_TEAMS: { groupName: string; teamName: string }[] = [
  { groupName: "AZ-Replit - PREPROD-Admins", teamName: "PREPROD" },
  { groupName: "AZ-Replit - PREPROD-Members", teamName: "PREPROD" },
  { groupName: "AZ-Replit - PREPROD-Viewer", teamName: "PREPROD" },
  { groupName: "AZ-Replit - PREPROD-Guests", teamName: "PREPROD" },
  { groupName: "AZ-Replit - Finance - Admin", teamName: "Finance" },
  { groupName: "AZ-Replit - Finance - Member", teamName: "Finance" },
  { groupName: "AZ-Replit - Finance - Viewer", teamName: "Finance" },
  { groupName: "AZ-Replit - GPO Connected Living - Admin", teamName: "GPO Connected Living" },
  { groupName: "AZ-Replit - GPO Connected Living - Member", teamName: "GPO Connected Living" },
  { groupName: "AZ-Replit - GPO Connected Living - Viewer", teamName: "GPO Connected Living" },
  { groupName: "AZ-Replit - GPO CTS - Admin", teamName: "GPO CTS" },
  { groupName: "AZ-Replit - GPO CTS - Member", teamName: "GPO CTS" },
  { groupName: "AZ-Replit - GPO CTS - Viewer", teamName: "GPO CTS" },
  { groupName: "AZ-Replit - GPO Creative Services - Admin", teamName: "GPO Creative Services" },
  { groupName: "AZ-Replit - GPO Creative Services - Member", teamName: "GPO Creative Services" },
  { groupName: "AZ-Replit - GPO Creative Services - Viewer", teamName: "GPO Creative Services" },
  { groupName: "AZ-Replit - Corporate Communications - Admin", teamName: "Corporate Communications" },
  { groupName: "AZ-Replit - Corporate Communications - Member", teamName: "Corporate Communications" },
  { groupName: "AZ-Replit - Corporate Communications - Viewer", teamName: "Corporate Communications" },
  { groupName: "AZ-Replit - Freewheel - Admin", teamName: "Freewheel" },
  { groupName: "AZ-Replit - Freewheel - Member", teamName: "Freewheel" },
  { groupName: "AZ-Replit - Freewheel - Viewer", teamName: "Freewheel" },
  { groupName: "AZ-Replit - Growth Strategy & Operations - Admin", teamName: "DXP" },
  { groupName: "AZ-Replit - Growth Strategy & Operations - Member", teamName: "DXP" },
  { groupName: "AZ-Replit - Growth Strategy & Operations - Viewer", teamName: "DXP" },
  { groupName: "AZ-Replit - Growth Xfinity Consumer Product Marketing - Admin", teamName: "Growth Xfinity Consumer Product Marketing" },
  { groupName: "AZ-Replit - Growth Xfinity Consumer Product Marketing - Member", teamName: "Growth Xfinity Consumer Product Marketing" },
  { groupName: "AZ-Replit - Growth Xfinity Consumer Product Marketing - Viewer", teamName: "Growth Xfinity Consumer Product Marketing" },
  { groupName: "AZ-Replit - Growth CXSO Account Mgmt - Admin", teamName: "Growth CXSO Account Mgmt" },
  { groupName: "AZ-Replit - Growth CXSO Account Mgmt - Member", teamName: "Growth CXSO Account Mgmt" },
  { groupName: "AZ-Replit - Growth CXSO Account Mgmt - Viewer", teamName: "Growth CXSO Account Mgmt" },
  { groupName: "AZ-Replit - Growth MDU - Admin", teamName: "Growth MDU" },
  { groupName: "AZ-Replit - Growth MDU - Member", teamName: "Growth MDU" },
  { groupName: "AZ-Replit - Growth MDU - Viewer", teamName: "Growth MDU" },
  { groupName: "AZ-Replit - Strategic Development Mosaic - Admin", teamName: "Strategic Development Mosaic" },
  { groupName: "AZ-Replit - Strategic Development Mosaic - Member", teamName: "Strategic Development Mosaic" },
  { groupName: "AZ-Replit - Strategic Development Mosaic - Viewer", teamName: "Strategic Development Mosaic" },
  { groupName: "AZ-Replit - Strategic Development LIFT Labs - Admin", teamName: "Strategic Development LIFT Labs" },
  { groupName: "AZ-Replit - Strategic Development LIFT Labs - Member", teamName: "Strategic Development LIFT Labs" },
  { groupName: "AZ-Replit - Strategic Development LIFT Labs - Viewer", teamName: "Strategic Development LIFT Labs" },
  { groupName: "AZ-Replit - Comcast Business Marketing - Admin", teamName: "Comcast Business Marketing" },
  { groupName: "AZ-Replit - Comcast Business Marketing - Member", teamName: "Comcast Business Marketing" },
  { groupName: "AZ-Replit - Comcast Business Marketing - Viewer", teamName: "Comcast Business Marketing" },
  { groupName: "AZ-Replit - Comcast Business Consumer Solutions - Admin", teamName: "Comcast Business Consumer Solutions" },
  { groupName: "AZ-Replit - Comcast Business Consumer Solutions - Member", teamName: "Comcast Business Consumer Solutions" },
  { groupName: "AZ-Replit - Comcast Business Consumer Solutions - Viewer", teamName: "Comcast Business Consumer Solutions" },
  { groupName: "AZ-Replit - Wireless - Admin", teamName: "Wireless" },
  { groupName: "AZ-Replit - Wireless - Member", teamName: "Wireless" },
  { groupName: "AZ-Replit - Wireless - Viewer", teamName: "Wireless" },
  { groupName: "AZ-Replit - EBI Enterprise Analytics - Admin", teamName: "EBI Enterprise Analytics" },
  { groupName: "AZ-Replit - EBI Enterprise Analytics - Member", teamName: "EBI Enterprise Analytics" },
  { groupName: "AZ-Replit - EBI Enterprise Analytics - Viewer", teamName: "EBI Enterprise Analytics" },
  { groupName: "AZ-Replit - EBI AI ML - Admin", teamName: "EBI AI ML" },
  { groupName: "AZ-Replit - EBI AI ML - Member", teamName: "EBI AI ML" },
  { groupName: "AZ-Replit - EBI AI ML - Viewer", teamName: "EBI AI ML" },
  { groupName: "AZ-Replit - HR Compensation - Admin", teamName: "HR Compensation" },
  { groupName: "AZ-Replit - HR Compensation - Member", teamName: "HR Compensation" },
  { groupName: "AZ-Replit - HR Compensation - Viewer", teamName: "HR Compensation" },
  { groupName: "AZ-Replit - Content Acquisition - Admin", teamName: "Content Acquisition" },
  { groupName: "AZ-Replit - Content Acquisition - Member", teamName: "Content Acquisition" },
  { groupName: "AZ-Replit - Content Acquisition - Viewer", teamName: "Content Acquisition" },
  { groupName: "AZ-Replit - TPX IT - Admin", teamName: "TPX IT" },
  { groupName: "AZ-Replit - TPX IT - Member", teamName: "TPX IT" },
  { groupName: "AZ-Replit - TPX IT - Viewer", teamName: "TPX IT" },
  { groupName: "AZ-Replit - Talent and Learning - Admin", teamName: "Talent and Learning" },
  { groupName: "AZ-Replit - Talent and Learning - Member", teamName: "Talent and Learning" },
  { groupName: "AZ-Replit - Talent and Learning - Viewer", teamName: "Talent and Learning" },
  { groupName: "AZ-Replit - Comcast Advertising - Admin", teamName: "Comcast Advertising" },
  { groupName: "AZ-Replit - Comcast Advertising - Member", teamName: "Comcast Advertising" },
  { groupName: "AZ-Replit - Comcast Advertising - Viewer", teamName: "Comcast Advertising" },
  { groupName: "AZ-Replit - NBCU - Admin", teamName: "NBCU" },
  { groupName: "AZ-Replit - NBCU - Member", teamName: "NBCU" },
  { groupName: "AZ-Replit - NBCU - Viewer", teamName: "NBCU" },
];

export const ORIGINAL_TEAM_BUDGETS: { teamName: string; amountUsd: number; isHidden?: boolean }[] = [
  { teamName: "PREPROD", amountUsd: 0.0, isHidden: true },
  { teamName: "Finance", amountUsd: 140525.76 },
  { teamName: "GPO Connected Living", amountUsd: 9368.38 },
  { teamName: "GPO CTS", amountUsd: 3747.35 },
  { teamName: "GPO Creative Services", amountUsd: 47422.76 },
  { teamName: "Corporate Communications", amountUsd: 234209.6 },
  { teamName: "Freewheel", amountUsd: 46841.92 },
  { teamName: "DXP", amountUsd: 18736.77 },
  { teamName: "Non-DXP", amountUsd: 0 },
  { teamName: "Growth Xfinity Consumer Product Marketing", amountUsd: 28105.15 },
  { teamName: "Growth CXSO Account Mgmt", amountUsd: 37473.54 },
  { teamName: "Growth MDU", amountUsd: 0.0 },
  { teamName: "Strategic Development Mosaic", amountUsd: 37473.54 },
  { teamName: "Strategic Development LIFT Labs", amountUsd: 30000.0 },
  { teamName: "Comcast Business Marketing", amountUsd: 14052.58 },
  { teamName: "Comcast Business Consumer Solutions", amountUsd: 37473.54 },
  { teamName: "Wireless", amountUsd: 14052.58 },
  { teamName: "EBI Enterprise Analytics", amountUsd: 9368.38 },
  { teamName: "EBI AI ML", amountUsd: 3747.35 },
  { teamName: "HR Compensation", amountUsd: 5621.03 },
  { teamName: "Content Acquisition", amountUsd: 4684.19 },
  { teamName: "TPX IT", amountUsd: 1873.68 },
  { teamName: "Talent and Learning", amountUsd: 33726.18 },
  { teamName: "Comcast Advertising", amountUsd: 13115.74 },
  { teamName: "NBCU", amountUsd: 0.0 },
];

export async function applyAnnualTeamBudgetBackfill(): Promise<void> {
  await db.transaction(async (tx) => {
    for (const budget of ORIGINAL_TEAM_BUDGETS) {
      await tx
        .insert(teamBudgetsTable)
        .values({
          ...budget,
          originalAmountUsd: budget.amountUsd,
        })
        .onConflictDoNothing();
    }

    // The approved split replaces this budget identity after its groups move.
    const [legacy] = await tx
      .select({ teamName: teamBudgetsTable.teamName })
      .from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, "Growth Strategy & Operations"));
    if (legacy) {
      await tx
        .delete(teamBudgetsTable)
        .where(eq(teamBudgetsTable.teamName, legacy.teamName));
    }
  });
}

export async function applyTeamMappingAndLimitTargetSeed(): Promise<void> {
  await db.transaction(async (tx) => {
    const legacyFamilies = new Map<string, { familyName: string; teamName: string }>();
    for (const mapping of BASELINE_GROUP_TEAMS) {
      const familyName = familyNameFromGroupName(mapping.groupName);
      const familyKey = normalizeSeedFamilyKey(familyName);
      legacyFamilies.set(familyKey, {
        familyName,
        teamName: FAMILY_TEAM_OVERRIDES.get(familyKey) ?? mapping.teamName,
      });
    }
    for (const [familyKey, teamName] of FAMILY_TEAM_OVERRIDES) {
      if (!legacyFamilies.has(familyKey)) {
        legacyFamilies.set(familyKey, { familyName: teamName, teamName });
      }
    }
    for (const [familyKey, family] of legacyFamilies) {
      await tx.insert(familyTeamMappingsTable).values({
        workspaceId: LEGACY_WORKSPACE_ID,
        familyKey,
        familyName: family.familyName,
        teamName: family.teamName,
        isLegacy: true,
      }).onConflictDoNothing();
    }

    for (const target of SEEDED_TEAM_LIMIT_TARGETS) {
      const familyName = familyNameFromGroupName(target.groupName);
      const familyKey = normalizeSeedFamilyKey(familyName);
      const teamName = FAMILY_TEAM_OVERRIDES.get(familyKey) ?? target.teamName;
      await tx.insert(familyTeamMappingsTable).values({
        workspaceId: target.workspaceId,
        familyKey,
        familyName,
        teamName,
        isLegacy: false,
      }).onConflictDoNothing();
      await tx.insert(teamLimitTargetsTable).values({
        ...target,
        teamName,
        assignmentSource: "unconfirmed",
      }).onConflictDoNothing();
    }

    await tx.insert(workspaceDefaultLimitTargetsTable).values({
      workspaceId: LEGACY_WORKSPACE_ID,
      displayName: "Legacy workspace per-user cap",
      monthlyLimitUsd: 1,
    }).onConflictDoNothing();
  });
}

export async function seedDatabase(): Promise<void> {
  console.log("Seeding team mappings, allocations, overrides, and limit targets...");
  await applyAnnualTeamBudgetBackfill();
  await applyTeamMappingAndLimitTargetSeed();
  console.log("Database seed complete");
}

if (process.argv[1] && /(?:^|[/\\])seed-teams\.(?:ts|js)$/.test(process.argv[1])) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
