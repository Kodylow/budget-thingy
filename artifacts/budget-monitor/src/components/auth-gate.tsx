import { type ReactNode } from 'react';
import { ShieldAlert, LogIn, Loader2, RefreshCw, Wallet, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthContext } from '@/components/auth-context';

/**
 * Gates the application behind authentication and authorization. Renders:
 * - a loading shell while the session is being resolved,
 * - a signed-out login shell for anonymous visitors,
 * - an access-denied shell for signed-in users who are not enabled admins,
 * - the authenticated app (children) for account or workspace admins.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const {
    isLoading,
    isUnavailable,
    isAuthenticated,
    isDenied,
    user,
    login,
    logout,
    retryAuthorization,
  } = useAuthContext();

  if (isLoading) {
    return <LoadingShell />;
  }

  if (isUnavailable) {
    return (
      <UnavailableShell
        onRetry={retryAuthorization}
        onLogout={logout}
      />
    );
  }

  if (!isAuthenticated) {
    return <SignedOutShell onLogin={login} />;
  }

  if (isDenied) {
    return <DeniedShell userId={user?.id ?? null} onLogout={logout} />;
  }

  return <>{children}</>;
}

function UnavailableShell({
  onRetry,
  onLogout,
}: {
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <CenteredShell>
      <Card data-testid="auth-unavailable">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <WifiOff className="h-6 w-6 text-amber-600" />
          </div>
          <CardTitle>Access check unavailable</CardTitle>
          <CardDescription>
            We couldn&apos;t verify your authorization right now. No budget data has
            been loaded. Try again in a moment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full" onClick={onRetry} data-testid="button-retry-auth">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={onLogout}
            data-testid="button-logout-unavailable"
          >
            Log out
          </Button>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}

function CenteredShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function LoadingShell() {
  return (
    <CenteredShell>
      <div
        className="flex flex-col items-center gap-4 text-center"
        data-testid="auth-loading"
      >
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Checking your access…</p>
      </div>
    </CenteredShell>
  );
}

function SignedOutShell({ onLogin }: { onLogin: () => void }) {
  return (
    <CenteredShell>
      <Card data-testid="auth-signed-out">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Wallet className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Budget Monitor</CardTitle>
          <CardDescription>
            Sign in to view group spending across your Comcast Enterprise account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={onLogin} data-testid="button-login">
            <LogIn className="mr-2 h-4 w-4" />
            Log in
          </Button>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}

function DeniedShell({ userId, onLogout }: { userId: string | null; onLogout: () => void }) {
  return (
    <CenteredShell>
      <Card data-testid="auth-denied">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>Access denied</CardTitle>
          <CardDescription>
            Your account isn&apos;t an enabled administrator for this account or any
            workspace, so there&apos;s no budget data to show. Contact your account
            administrator if you believe this is a mistake.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {userId && (
            <div className="rounded-md bg-muted px-3 py-2 text-center">
              <p className="mb-1 text-xs text-muted-foreground">
                Share this ID with your account administrator:
              </p>
              <code
                className="select-all break-all font-mono text-xs text-foreground"
                data-testid="denied-user-id"
              >
                {userId}
              </code>
            </div>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={onLogout}
            data-testid="button-logout-denied"
          >
            Log out
          </Button>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}
