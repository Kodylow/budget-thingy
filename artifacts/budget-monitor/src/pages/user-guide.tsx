import { useAuthContext } from '@/components/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CheckCircle2,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';

export default function Help() {
  const { capabilities } = useAuthContext();

  return (
    <main className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header className="max-w-3xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Use Budget Monitor</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          How to monitor usage, manage budgets and limits, and find the right person to help.
        </p>
      </header>

      <section className="space-y-2 rounded-md border border-primary/15 bg-primary/[0.035] px-5 py-6 md:px-6" aria-labelledby="help-contacts">
        <h2 id="help-contacts" className="text-lg font-semibold">Contact</h2>
        <ul className="space-y-2 text-sm leading-6">
          {['chris.cattie@repl.it', 'support@repl.it'].map((email) => (
            <li key={email}>
              <a
                href={`mailto:${email}`}
                className="break-all rounded-sm text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {email}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        <GuideSection index="01 · Monitor" title="Read current spend" icon={<Search className="h-4 w-4" />}>
            <p>
              Start with <strong className="text-foreground">Home</strong> for your usage, or
              <strong className="text-foreground"> Org Insights</strong> for the account-wide view if you have access.
              Select the reporting period and scope before comparing amounts.
            </p>
            <p>
              The period and data-as-of text explain what the amount covers. Ordinary members see their
              own spend; account-wide labels appear only when you have that permission.
            </p>
            <p>
              <strong className="text-foreground">My Projects</strong> is the current self-owned project
              catalog. Published is the current count across that catalog, including projects without spend;
              it is separate from selected-period spend and current billing-cycle Agent limits.
            </p>
        </GuideSection>

        <GuideSection index="02 · Investigate" title="Find where it went" icon={<Search className="h-4 w-4" />}>
            <p>
              Use <strong className="text-foreground">My Team</strong> to investigate your team's usage,
              or open a team or group from <strong className="text-foreground">Org Insights</strong>.
              Use <strong className="text-foreground">My Projects</strong> to find your own projects and their usage.
            </p>
            <p>
              Project rows show the current catalog, while their spend columns use the selected reporting
              period. They explain attribution, not a separate accounting total.
            </p>
            <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              Canonical member and group totals remain the source for monitoring.
            </div>
        </GuideSection>

        {capabilities.canWriteUserLimitsIn.length > 0 && (
          <GuideSection index="03 · Control" title="Set Agent limits" icon={<ShieldCheck className="h-4 w-4" />}>
            <p>
              <strong className="text-foreground">Limits</strong> organizes budget teams, workspace-qualified
              groups, and people. Edit a workspace default, group limit, or individual override.
              Select people, groups, or teams to stage bulk individual updates, then review the exact
              targets and amounts before confirming.
            </p>
            <p>
              Editing depends on workspace permissions. You can review and change limits only in
              workspaces where your current role grants that capability. Check each target's result
              after saving; retry unresolved targets if needed. Monthly Agent limits can block paid
              Agent usage and reset with the billing cycle.
            </p>
            <p>
              <strong className="text-foreground">Clear Limits</strong> is a separate admin action.
              Review its complete inventory and type <code>CLEAR LIMITS</code> to confirm. It removes
              limits and disables automatic policies that could recreate them; funding allocations
              and account spending controls are unchanged. Clearing an individual override alone
              can expose an inherited limit rather than make usage unlimited.
            </p>
            {capabilities.canEditAllocations && (
              <p>
                Budget allocations are planning baselines used for monitoring and alerts. They are distinct
                from monthly Agent limits and do not themselves block usage.
              </p>
            )}
          </GuideSection>
        )}

        <GuideSection index="04 · Verify" title="Check freshness and coverage" icon={<RefreshCw className="h-4 w-4" />}>
            <p>
              <strong className="text-foreground">Data as of</strong> is the last observed usage time,
              not the time you opened the page. A refreshing
              or stale message means the last successful values remain visible while newer data is sought.
            </p>
            <p>
              Partial coverage and unknown values are never zero. Administrators can open Data quality
              from the account menu for detailed coverage and attribution notes. Reporting dates and
              current billing-cycle limits remain separate.
            </p>
            <div className="mt-4 flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Guidance distinguishes reporting periods from billing-cycle controls
            </div>
        </GuideSection>
      </div>

      <Card className="rounded-md border-dashed shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Keep these concepts separate</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          <Concept label="Spend" detail="Observed usage in the selected reporting period." />
          <Concept label="Allocation" detail="Planning baseline used for monitoring and alerts." />
          <Concept label="Agent limit" detail="Monthly platform control that can block paid usage." />
        </CardContent>
      </Card>
    </main>
  );
}

function GuideSection({
  index,
  title,
  icon,
  children,
}: {
  index: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-5">
      <div className="flex items-center gap-2 text-primary">
        {icon}
        <p className="text-[11px] font-bold uppercase tracking-[0.16em]">{index}</p>
      </div>
      <h2 className="mt-2 text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}

function Concept({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-md border bg-muted/25 px-4 py-3">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}