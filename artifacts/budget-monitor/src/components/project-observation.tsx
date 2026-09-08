import React from "react";
import { AdminDataQualityNote } from "@/components/admin-data-quality";

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ProjectDate({ value, unknown = "Unknown" }: { value: string | null | undefined; unknown?: string }) {
  if (!value) return <>{unknown}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{unknown}</>;
  return <time dateTime={value}>{date.toLocaleDateString()}</time>;
}

export function ProjectDataFreshness({
  metadata,
}: {
  metadata: {
    status: string;
    stale: boolean;
    dataAsOf?: string | null;
  };
}) {
  return (
    <>
    {(metadata.status === "empty" || metadata.status === "partial") && (
      <AdminDataQualityNote title="Project usage">
        {metadata.status === "empty" ? "Selected-period usage unavailable." : "Selected-period usage partial."}
      </AdminDataQualityNote>
    )}
    <p className="text-xs text-muted-foreground">
      Project data
      {metadata.dataAsOf
        ? <> as of <ProjectDate value={metadata.dataAsOf} />{metadata.stale ? " · Stale" : ""}</>
        : <> freshness unknown{metadata.stale ? " · Stale" : ""}</>}
    </p>
    </>
  );
}

export function DeploymentChip({
  value,
  availability,
}: {
  value: boolean | null | undefined;
  availability?: "complete" | "stale" | "unavailable";
}) {
  const unavailable = availability === "unavailable" || value == null;
  const label = unavailable ? "Deployment unknown" : value ? "Deployed" : "Not deployed";
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider ${
      value === true && !unavailable ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
    }`}>
      {label}
    </span>
  );
}

export function StaleSpendingChip({ visible }: { visible: boolean | null | undefined }) {
  if (!visible) return null;
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20 uppercase tracking-wider">
      Stale/spending
    </span>
  );
}

export function DeploymentLink({ url }: { url: string | null | undefined }) {
  const safeUrl = safeExternalUrl(url);
  if (!url) return <>Unknown</>;
  if (!safeUrl) return <span className="text-muted-foreground">{url}</span>;
  return <a href={safeUrl} target="_blank" rel="noreferrer" className="hover:underline">{url}</a>;
}