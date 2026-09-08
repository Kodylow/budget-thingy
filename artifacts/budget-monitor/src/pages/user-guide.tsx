import { useAuthContext } from '@/components/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';

const walkthroughHref = `${import.meta.env.BASE_URL}guides/budget-monitor-walkthrough.pdf`;

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

      <section className="flex flex-col gap-5 rounded-md border border-primary/15 bg-primary/[0.035] px-5 py-6 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex min-w-0 gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <BookOpen className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">Budget Monitor walkthrough</h2>
              <Badge variant="outline" className="text-[10px] font-medium">12 slides</Badge>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Open the approved 12-slide guide for members and team administrators. Learn how to
              monitor, investigate, manage limits, and interpret data freshness without changing data.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button asChild>
            <a
              href={walkthroughHref}
              target="_blank"
              rel="noopener"
              data-testid="help-open-walkthrough"
            >
              Open walkthrough (PDF) <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={walkthroughHref} download data-testid="help-download-walkthrough">
              Download <Download className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </div>
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

      <section className="space-y-4 border-t border-border pt-6" aria-labelledby="help-contacts">
        <div>
          <h2 id="help-contacts" className="text-xl font-semibold">Who to contact</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Start with the person responsible for the workspace or budget team involved.
            If you do not know who that is, ask your workspace administrator to direct you.
          </p>
        </div>
        <dl className="grid gap-x-10 gap-y-5 text-sm md:grid-cols-2">
          <div>
            <dt className="font-semibold">Access or missing workspaces</dt>
            <dd className="mt-1 leading-6 text-muted-foreground">
              Contact your workspace or account administrator. Include which workspace or team you
              need to see and what you need to do. Access is based on your role; a missing page does
              not mean its data is missing.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Funding or allocation changes</dt>
            <dd className="mt-1 leading-6 text-muted-foreground">
              Contact your budget team administrator or funding owner. Include the team, requested
              amount, and budget period. A funding allocation is a planning baseline, not an Agent limit.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Agent limits or blocked usage</dt>
            <dd className="mt-1 leading-6 text-muted-foreground">
              Contact an administrator who manages limits for your workspace. Include the workspace,
              affected person or group, and the limit or error shown. Increasing funding alone does
              not raise a platform limit.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Incorrect totals, stale data, or app errors</dt>
            <dd className="mt-1 leading-6 text-muted-foreground">
              Contact the Budget Monitor app administrator through your workspace administrator.
              Include the page, reporting dates, selected scope, data-as-of time, and what you expected.
              Share only details the recipient is authorized to see; never send credentials.
            </dd>
          </div>
        </dl>
      </section>

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