/**
 * Seeds group→team mapping and team budgets into the database.
 * Run with: npx tsx src/seed-teams.ts
 */
import { db } from "./index.js";
import { teamBudgetsTable } from "./schema/index.js";
import { eq } from "drizzle-orm";

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

async function seed() {
  console.log("Seeding team budgets...");
  await applyAnnualTeamBudgetBackfill();
  console.log(`Inserted ${ORIGINAL_TEAM_BUDGETS.length} team budget rows`);
}

if (process.argv[1] && /(?:^|[/\\])seed-teams\.(?:ts|js)$/.test(process.argv[1])) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
