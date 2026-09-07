import {
  ExternalLink,
  Info,
  KeyRound,
  Settings2,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Link } from 'wouter';
import { useAuthContext } from '@/components/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Access() {
  const { isAccountAdmin, capabilities } = useAuthContext();

  if (!isAccountAdmin && !capabilities.canManageAccess) {
    return (
      <div className="mx-auto max-w-[1280px] space-y-4 px-4 py-6 md:px-8 md:py-8">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Access</h1>
        <p className="text-sm text-muted-foreground">
          You do not have permission to view or manage access.
        </p>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Access</h1>
          <p className="text-sm text-muted-foreground">
            Govern application access while keeping workspace and team membership aligned with Replit.
          </p>
        </div>
        <Button variant="outline" asChild className="w-full gap-2 sm:w-auto">
          <Link href="/settings">
            <Settings2 className="h-4 w-4" />
            Open Settings
          </Link>
        </Button>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]">
        <section aria-labelledby="application-grants-heading">
          <Card className="rounded-md shadow-none">
            <CardHeader className="border-b bg-muted/25 pb-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyRound className="h-[18px] w-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <CardTitle id="application-grants-heading" className="text-lg">
                    Application grants
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Control who can administer Budget Monitor at the account level.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex items-start gap-3 px-5 py-4">
                <Info
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm leading-6 text-muted-foreground">
                  Individual grants cannot currently be changed from this page. Application
                  administrator assignments are managed in{' '}
                  <span className="font-medium text-foreground">Settings</span>.
                </p>
              </div>
              <div className="flex flex-col gap-3 border-t bg-muted/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Assignments are read-only in Access.
                </p>
                <Button variant="outline" size="sm" asChild className="w-full gap-2 sm:w-auto">
                  <Link href="/settings">
                    Manage in Settings
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4" aria-label="Access sources">
          <Card className="rounded-md shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">Access model</CardTitle>
                <Badge
                  variant="outline"
                  className="gap-1.5 font-medium text-emerald-700 dark:text-emerald-400"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Synced
                </Badge>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                Two systems work together to keep access predictable.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Budget Monitor grants</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Application administrator assignments are managed in Settings.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <UsersRound className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Replit membership</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Workspace and team membership comes from Replit and is not overridden here.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-md border-dashed bg-muted/15 shadow-none">
            <CardContent className="flex gap-3 px-5 py-4">
              <Info
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">Need to change a person’s scope?</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Update their workspace or team membership in Replit, then return here to confirm
                  the account view.
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>
  );
}
