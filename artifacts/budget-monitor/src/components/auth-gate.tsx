import React, { type ReactNode, useEffect } from 'react';
import { ShieldAlert, LogIn, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthContext } from '@/components/auth-context';
import { beginExplicitSignIn, getLoginUrl, isEmbeddedPreview } from '@workspace/replit-auth-web';

export function AuthGate({ children }: { children: ReactNode }) {
  const {
    isLoading,
    isAuthenticated,
    isDenied,
    user,
    logout,
    isPreviewing,
    resetPreview,
    availability,
    retryAuthorization,
  } = useAuthContext();

  useEffect(() => {
    if (isAuthenticated && !isDenied) {
      // Preload dashboard and chart chunk after successful authorization
      import('@/pages/dashboard');
      import('@/pages/dashboard-chart');
    }
  }, [isAuthenticated, isDenied]);

  if (isLoading) {
    return <LoadingShell />;
  }

  if (availability === 'invalid-preview') {
    return <InvalidPreviewShell onResetPreview={resetPreview} onLogout={logout} />;
  }

  if (!isAuthenticated) {
    return (
      <SignedOutShell
        isUnavailable={availability === 'unavailable'}
        onReconnect={retryAuthorization}
      />
    );
  }

  if (isDenied) {
    return <DeniedShell
             userId={user?.id ?? null}
             onLogout={logout}
             isPreviewing={isPreviewing}
             onResetPreview={resetPreview}
           />;
  }

  return <>{children}</>;
}

function InvalidPreviewShell({
  onResetPreview,
  onLogout,
}: {
  onResetPreview: () => void;
  onLogout: () => void;
}) {
  return (
    <CenteredShell>
      <Card data-testid="auth-invalid-preview">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <TriangleAlert className="h-6 w-6 text-amber-600" />
          </div>
          <CardTitle>Preview is no longer available</CardTitle>
          <CardDescription>
            That role or scope cannot be previewed. Protected budget data has been cleared.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full" onClick={onResetPreview} data-testid="button-reset-invalid-preview">
            Reset to your real view
          </Button>
          <Button variant="outline" className="w-full" onClick={onLogout}>
            Log out
          </Button>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}

function CenteredShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-6 py-4 md:px-8">
        <span className="font-display text-lg font-bold tracking-tight">Budget Monitor</span>
        <span className="text-sm text-muted-foreground">Comcast Enterprise</span>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
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

function SignedOutShell({
  isUnavailable,
  onReconnect,
}: {
  isUnavailable: boolean;
  onReconnect: () => void;
}) {
  const embedded = isEmbeddedPreview();
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background md:flex-row" data-testid="auth-signed-out">
      <div className="relative h-44 w-full shrink-0 overflow-hidden bg-[#000A73] md:h-auto md:min-h-[100dvh] md:w-[62%]">
        <img
          src={`${import.meta.env.BASE_URL}login-network-architecture.jpg`}
          alt="Architectural network paths converging through modular structures"
          width="1024"
          height="1024"
          className="absolute inset-0 h-full w-full object-cover object-[center_60%] md:object-center"
        />
        <div className="absolute top-6 left-6 md:top-10 md:left-10 z-20">
           <span className="font-display text-xl md:text-2xl font-bold tracking-tight text-white drop-shadow-md">Budget Monitor</span>
        </div>
      </div>

      <div className="z-20 flex flex-1 flex-col justify-start bg-background px-6 py-12 md:w-[38%] md:justify-center md:px-12 lg:px-16">
        <div className="w-full max-w-sm mx-auto">
          <p className="mb-2 text-xs md:text-sm font-semibold uppercase tracking-widest text-primary">Comcast Enterprise</p>
          <h1 className="mb-4 font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">Sign in to Budget Monitor</h1>
          <p className="text-muted-foreground text-sm md:text-base mb-8">
            Monitor spending and manage authorized Agent limits across your workspaces.
          </p>
           <Button className="h-11 w-full text-base" asChild>
            <a
              href={getLoginUrl(returnTo)}
              target={embedded ? '_blank' : '_self'}
              rel="noopener noreferrer"
              data-testid="button-login"
              onClick={beginExplicitSignIn}
            >
              <LogIn className="mr-2 h-4 w-4" />
              {embedded ? 'Log in in a new tab' : 'Log in'}
            </a>
          </Button>
           {isUnavailable && (
             <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
               <span>Having trouble checking access.</span>
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
                 className="h-7 px-2"
                 onClick={onReconnect}
                 data-testid="button-reconnect"
               >
                 Reconnect
               </Button>
             </div>
           )}
          {embedded && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Secure sign-in opens outside the preview. Continue using the app in that tab.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DeniedShell({
  userId,
  onLogout,
  isPreviewing,
  onResetPreview
}: {
  userId: string | null;
  onLogout: () => void;
  isPreviewing?: boolean;
  onResetPreview?: () => void;
}) {
  return (
    <CenteredShell>
      <Card data-testid="auth-denied">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>Access denied</CardTitle>
          <CardDescription>
            Your account isn&apos;t an enabled member for this account or any
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
          {isPreviewing && onResetPreview && (
            <Button
              variant="default"
              className="w-full"
              onClick={onResetPreview}
              data-testid="button-reset-preview-denied"
            >
              Reset to your real view
            </Button>
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
