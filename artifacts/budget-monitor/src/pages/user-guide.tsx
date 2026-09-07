import { useAuthContext } from '@/components/auth-context';
import { Button } from '@/components/ui/button';
import { BookOpen, Download, ExternalLink } from 'lucide-react';

const walkthroughHref = `${import.meta.env.BASE_URL}guides/budget-monitor-walkthrough.pdf`;

export default function Help() {
  const { capabilities } = useAuthContext();

  return (
    <main className="mx-auto max-w-5xl space-y-10 p-4 md:p-8">
      <header className="max-w-2xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Support</p>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Use Budget Monitor</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground md:text-base">
          Read authorized Comcast Enterprise spend, investigate where it went, and understand the
          difference between planning allocations and Agent limits.
        </p>
      </header>

      <section className="flex flex-col gap-5 border-y border-border bg-primary/[0.03] px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <BookOpen className="h-5 w-5" aria-hidden />
            <h2 className="text-lg font-semibold">Budget Monitor walkthrough</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Open the approved 12-slide guide for members and team administrators. It explains
            monitoring, investigation, limits, and data freshness without changing any data.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
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

      <div className="grid gap-x-12 gap-y-10 md:grid-cols-2">
        <section className="border-t border-border pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">01 · Monitor</p>
          <h2 className="mt-2 text-xl font-semibold">Read current spend</h2>
          <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              <strong className="text-foreground">Overview</strong> summarizes actual spend for the selected
              period and scope. Use scope to switch among your spend, groups and workspaces you manage,
              and all spend you are authorized to see.
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
          </div>
        </section>

        <section className="border-t border-border pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">02 · Investigate</p>
          <h2 className="mt-2 text-xl font-semibold">Find where it went</h2>
          <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              Open <strong className="text-foreground">Spend</strong> for searchable, sortable detail.
              Choose Groups, Members, Projects, or an available planning-pool view, then narrow the
              authorized scope with filters.
            </p>
            <p>
              Project rows show the current catalog, while their spend columns use the selected reporting
              period. They explain attribution and are not a separate accounting total; canonical member
              and group totals remain the source for monitoring.
            </p>
          </div>
        </section>

        {capabilities.canWriteUserLimitsIn.length > 0 && <section className="border-t border-border pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">03 · Control</p>
          <h2 className="mt-2 text-xl font-semibold">Set Agent limits</h2>
          <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              <strong className="text-foreground">Limits</strong> shows current monthly Agent limits for
              eligible members. A platform limit may hard-block paid Agent usage when reached and resets
              with the billing cycle. Editing depends on your workspace permissions.
            </p>
            {capabilities.canEditAllocations && (
              <p>
                Budget allocations are planning baselines used for monitoring and alerts. They are distinct
                from monthly Agent limits and do not themselves block usage.
              </p>
            )}
          </div>
        </section>}

        <section className="border-t border-border pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">04 · Verify</p>
          <h2 className="mt-2 text-xl font-semibold">Check freshness and coverage</h2>
          <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              “Data as of” is the last observed usage time, not the time you opened the page. A refreshing
              or stale message means the last successful values remain visible while newer data is sought.
            </p>
            <p>
              Partial coverage and unknown values are never zero. Administrators can open Data quality
              from the account menu for detailed coverage and attribution notes. Reporting dates and
              current billing-cycle limits remain separate.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}