import { db, notificationSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const SINGLETON_ID = "singleton";

export async function getNotificationSettings() {
  const [settings] = await db
    .insert(notificationSettingsTable)
    .values({ id: SINGLETON_ID, automatedEmailEnabled: false })
    .onConflictDoNothing({ target: notificationSettingsTable.id })
    .returning();
  if (settings) return settings;

  const [stored] = await db
    .select()
    .from(notificationSettingsTable)
    .where(eq(notificationSettingsTable.id, SINGLETON_ID))
    .limit(1);
  if (!stored) {
    throw new Error("Notification settings could not be initialized");
  }
  return stored;
}

export async function isAutomatedEmailEnabled(): Promise<boolean> {
  return (await getNotificationSettings()).automatedEmailEnabled;
}

export async function updateNotificationSettings(
  automatedEmailEnabled: boolean,
) {
  const [settings] = await db
    .insert(notificationSettingsTable)
    .values({ id: SINGLETON_ID, automatedEmailEnabled })
    .onConflictDoUpdate({
      target: notificationSettingsTable.id,
      set: { automatedEmailEnabled, updatedAt: new Date() },
    })
    .returning();
  if (!settings) {
    throw new Error("Notification settings could not be updated");
  }
  return settings;
}