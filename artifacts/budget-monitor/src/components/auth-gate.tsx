import React, { type ReactNode, useEffect } from 'react';
import { ShieldAlert, LogIn, Loader2, TriangleAlert } from 'lucide-react';
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
    <div className="signed-out-shell text-foreground" data-testid="auth-signed-out">
      <div className="signed-out-shell__image" aria-label="Comcast Technology Center">
        <img
          src={`${import.meta.env.BASE_URL}comcast-technology-center.png`}
          alt="Comcast Technology Center lobby in Philadelphia"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
        <div className="signed-out-shell__image-caption">Philadelphia · Enterprise technology</div>
      </div>

      <section className="signed-out-shell__panel" aria-labelledby="signed-out-title">
        <header className="signed-out-shell__brand">
          <img src={`${import.meta.env.BASE_URL}replit-logo.svg`} alt="" width="32" height="32" />
          <h2>Replit Budget Monitor</h2>
        </header>

        <div className="signed-out-shell__content">
          <p className="signed-out-shell__eyebrow">Comcast Enterprise · Finance operations</p>
          <h1 id="signed-out-title" className="signed-out-shell__headline font-display font-bold">
            Your Replit spend. In clear view.
          </h1>
          <p className="signed-out-shell__copy">
            Review workspace spending, track team allocations, and manage authorized monthly Agent limits.
          </p>
          <Button className="signed-out-shell__login min-h-12 h-auto px-7 py-3 text-base font-bold transition-colors hover:bg-[hsl(219_100%_46%)] active:bg-[hsl(219_100%_40%)]" asChild>
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
              <LogIn className="mr-2.5 h-5 w-5" aria-hidden="true" />
              Log in
            </a>
          </Button>
          {showDevelopmentView ? (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium text-white/75">
                Or open a read-only development preview
              </p>
              <DevViewSignedOutPicker />
            </div>
          ) : null}
          {isUnavailable && (
            <div className="signed-out-shell__reconnect" data-testid="auth-unavailable" role="status">
              <span>Having trouble checking access.</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="min-h-11 h-auto px-1 font-medium text-primary hover:no-underline"
                onClick={onReconnect}
                data-testid="button-reconnect"
              >
                Reconnect
              </Button>
            </div>
          )}
        </div>

        <footer className="signed-out-shell__footer">
          <span>Internal use · Authorized Comcast employees</span>
          <span className="signed-out-shell__comcast">Comcast Enterprise</span>
        </footer>
      </section>
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
