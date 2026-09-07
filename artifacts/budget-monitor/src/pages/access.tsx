import { Key } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';

export default function Access() {
  const { isAccountAdmin, capabilities } = useAuthContext();
  
  if (!isAccountAdmin && !capabilities.canManageAccess) {
    return (
      <div className="p-4 md:p-8 space-y-4">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Access</h1>
        <p className="text-muted-foreground">You do not have permission to view or manage access.</p>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-10 p-4 md:p-8">
      <header className="max-w-3xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Management</p>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Access</h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">
          Account admins manage application grants; organizational workspace/team membership remains sourced from Replit.
        </p>
      </header>

      <section className="border-t border-border pt-6">
        <div className="flex max-w-3xl items-start gap-3 sm:gap-4">
          <Key className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
           <div className="min-w-0">
            <h2 className="text-lg font-semibold">Application grants</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Individual grants cannot currently be changed from this page. Application administrator
              assignments are managed in Settings. Workspace and team membership continues to come from
              Replit and is not overridden here.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}