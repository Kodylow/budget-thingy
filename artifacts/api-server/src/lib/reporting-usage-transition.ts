import {
  getUsageSnapshotGeneration,
  isUsageGenerationUpdateActive,
} from "./usage-store";

export const REPORTING_USAGE_RETRY_AFTER_SECONDS = 2;

export class ReportingUsageTransitionError extends Error {
  readonly code = "REPORTING_USAGE_REFRESHING";

  constructor() {
    super("Reporting usage is refreshing; retry the request");
    this.name = "ReportingUsageTransitionError";
  }
}

export function assertStableReportingUsageGeneration(expectedGeneration?: number): void {
  if (
    isUsageGenerationUpdateActive() ||
    (expectedGeneration !== undefined &&
      getUsageSnapshotGeneration() !== expectedGeneration)
  ) {
    throw new ReportingUsageTransitionError();
  }
}