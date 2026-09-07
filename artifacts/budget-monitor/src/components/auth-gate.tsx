import React, { type ReactNode, useEffect } from 'react';
import { ShieldAlert, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthContext } from '@/components/auth-context';
import { DevViewSignedOutPicker } from '@/components/dev-view-chip';
import { beginExplicitSignIn, getLoginUrl, isEmbeddedPreview, logAuthDebug } from '@workspace/replit-auth-web';

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
    developmentView,
  } = useAuthContext();

  useEffect(() => {
    if (isAuthenticated && !isDenied) {
      // Preload dashboard and chart chunk after successful authorization
      import('@/pages/dashboard');
      import('@/pages/dashboard-chart');
    }
  }, [isAuthenticated, isDenied]);

  if (developmentView.enabled && developmentView.selectedId && (
    !isLoading && availability !== 'authorized'
  )) {
    return (
      <CenteredShell>
        <Card data-testid="auth-development-recovery">
          <CardHeader>
            <CardTitle>Development view · read-only</CardTitle>
            <CardDescription>
              {developmentView.loading ? 'Loading the Comcast directory…'
                : developmentView.error
                  ?? (availability === 'invalid-preview'
                    ? 'The selected user is no longer available. Choose another person using the development chip.'
                    : availability === 'denied'
                      ? 'This person has no enabled budget access. Choose another person using the development chip.'
                      : 'Access could not be resolved. Retry or choose another person.')}
            </CardDescription>
          </CardHeader>
          {!developmentView.loading && (
            <CardContent>
              <Button onClick={() => { developmentView.retry(); retryAuthorization(); }}>Retry development view</Button>
            </CardContent>
          )}
        </Card>
      </CenteredShell>
    );
  }

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
        showDevelopmentView={developmentView.enabled}
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
  showDevelopmentView,
}: {
  isUnavailable: boolean;
  onReconnect: () => void;
  showDevelopmentView: boolean;
}) {
  const embedded = isEmbeddedPreview();
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return (
    <main
      className="signed-out-shell flex min-h-[100dvh] items-center justify-center bg-background px-6 py-12 text-foreground"
      data-testid="auth-signed-out"
    >
      <div className="w-full max-w-80 text-center">
        <img
          className="mx-auto size-8"
          src={`${import.meta.env.BASE_URL}replit-logo.svg`}
          alt=""
          width="32"
          height="32"
        />
        <h1 id="signed-out-title" className="mt-4 text-2xl font-bold">
          Replit Budget Monitor
        </h1>
        <Button className="mt-8 h-11 w-full" asChild>
          <a
            href={getLoginUrl(returnTo)}
            target={embedded ? '_top' : '_self'}
            rel="noopener noreferrer"
            data-testid="button-login"
            onClick={() => {
              logAuthDebug('login.click', { target: embedded ? '_top' : '_self' });
              beginExplicitSignIn();
            }}
          >
            Log in
          </a>
        </Button>
        {showDevelopmentView ? (
          <div className="mt-3">
            <DevViewSignedOutPicker />
          </div>
        ) : null}
        {isUnavailable && (
          <div
            className="mt-4 flex flex-wrap items-center justify-center gap-x-2 text-sm text-muted-foreground"
            data-testid="auth-unavailable"
            role="status"
          >
            <span>Having trouble checking access.</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-h-11 px-1 font-medium"
              onClick={onReconnect}
              data-testid="button-reconnect"
            >
              Reconnect
            </Button>
          </div>
        )}
      </div>
    </main>
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
