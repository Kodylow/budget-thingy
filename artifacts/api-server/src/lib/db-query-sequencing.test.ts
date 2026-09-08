import { afterEach, describe, expect, it } from "vitest";
import {
  db,
  familyTeamMappingsTable,
  fundingGroupOverridesTable,
  groupBudgetsTable,
  pool,
  teamBudgetAdjustmentsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";
import { applyFamilyMappingBackfill } from "@workspace/db/seed-teams";
import {
  getConfigurationSnapshot,
  resetConfigurationSnapshotForTests,
} from "./configuration-snapshot";

type InstrumentedClient = {
  query: (...args: never[]) => Promise<unknown>;
  release: (...args: never[]) => unknown;
};

type ConnectCallback = (
  error: Error | undefined,
  client: InstrumentedClient,
  done: (...args: never[]) => unknown,
) => void;

function installSafeOverlapDiagnostic(): {
  checkedOutClients: Set<InstrumentedClient>;
  overlaps: string[];
  restore: () => void;
} {
  const mutablePool = pool as unknown as {
    connect: (
      callback?: ConnectCallback,
    ) => Promise<InstrumentedClient> | undefined;
  };
  const originalConnect = mutablePool.connect.bind(pool);
  const checkedOutClients = new Set<InstrumentedClient>();
  const overlaps: string[] = [];

  const instrument = (client: InstrumentedClient): InstrumentedClient => {
    checkedOutClients.add(client);
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    let queued = 0;
    let tail: Promise<unknown> = Promise.resolve();

    client.query = async (...args: never[]) => {
      if (queued > 0) {
        overlaps.push(
          new Error("same-client query overlap").stack
            ?.split("\n")
            .slice(0, 8)
            .join("\n") ?? "same-client query overlap",
        );
      }
      queued += 1;

      // Chain every waiter onto the tail. This is intentionally stricter than
      // awaiting the currently active promise: multiple waiters can never
      // wake together and reach pg concurrently.
      const current = tail
        .catch(() => undefined)
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
        .then(() => originalQuery(...args));
      tail = current;
      try {
        return await current;
      } finally {
        queued -= 1;
      }
    };
    client.release = (...args: never[]) => {
      client.query = originalQuery;
      client.release = originalRelease;
      return originalRelease(...args);
    };
    return client;
  };
  mutablePool.connect = (callback?: ConnectCallback) => {
    if (callback) {
      originalConnect((error, client, done) => {
        callback(error, error ? client : instrument(client), done);
      });
      return undefined;
    }
    return originalConnect()!.then(instrument);
  };

  return {
    checkedOutClients,
    overlaps,
    restore: () => {
      mutablePool.connect = originalConnect;
    },
  };
}

describe("single-client query sequencing", () => {
  afterEach(() => {
    resetConfigurationSnapshotForTests();
  });

  it("reproduces the former six-read overlap without sending concurrent pg queries", async () => {
    const diagnostic = installSafeOverlapDiagnostic();
    try {
      await db.transaction(async (tx) => {
        // Disposable reproduction of the pre-fix configuration loader. This
        // is deliberately test-local; the diagnostic serializes the actual pg
        // calls while retaining evidence that five arrived while one was due.
        await Promise.all([
          tx.select().from(groupBudgetsTable),
          tx.select().from(teamLimitTargetsTable),
          tx.select().from(teamBudgetsTable),
          tx.select().from(teamBudgetAdjustmentsTable),
          tx.select().from(familyTeamMappingsTable),
          tx.select().from(fundingGroupOverridesTable),
        ]);
      }, { isolationLevel: "repeatable read" });

      expect(diagnostic.overlaps).toHaveLength(5);
      expect(diagnostic.overlaps.every((stack) =>
        stack.includes("db-query-sequencing.test.ts")
      )).toBe(true);
    } finally {
      diagnostic.restore();
    }
  });

  it("does not overlap transaction statements while retaining pool concurrency", async () => {
    const diagnostic = installSafeOverlapDiagnostic();

    try {
      resetConfigurationSnapshotForTests();
      const [snapshot] = await Promise.all([
        getConfigurationSnapshot(),
        applyFamilyMappingBackfill([]),
        applyFamilyMappingBackfill([]),
        applyFamilyMappingBackfill([]),
      ]);

      expect(snapshot.revision).toMatch(/^\d+$/);
      expect(
        diagnostic.overlaps,
        diagnostic.overlaps.join("\n\n"),
      ).toEqual([]);
      expect(diagnostic.checkedOutClients.size).toBeGreaterThan(1);
    } finally {
      diagnostic.restore();
    }
  });
});