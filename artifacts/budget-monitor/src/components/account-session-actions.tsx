import React from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthContext } from '@/components/auth-context';
import {
  beginExplicitSignIn,
  getLoginUrl,
  isEmbeddedPreview,
  logAuthDebug,
} from '@workspace/replit-auth-web';

export function AccountSessionActions() {
  const { logout, developmentView } = useAuthContext();

  if (!developmentView.selectedId) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start"
        onClick={logout}
        data-testid="button-logout"
      >
        <LogOut className="mr-2 h-4 w-4 shrink-0" />
        Log out
      </Button>
    );
  }

  const embedded = isEmbeddedPreview();
  const returnTo = `${window.location.pathname}${window.location.search}`;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={developmentView.exit}
        data-testid="button-exit-development-preview"
      >
        Exit preview
      </Button>
      <Button size="sm" className="w-full" asChild>
        <a
          href={getLoginUrl(returnTo)}
          target={embedded ? '_top' : '_self'}
          rel="noopener noreferrer"
          data-testid="button-login-yourself"
          onClick={() => {
            developmentView.exit();
            logAuthDebug('login.click', { target: embedded ? '_top' : '_self' });
            beginExplicitSignIn();
          }}
        >
          Sign in as yourself
        </a>
      </Button>
    </div>
  );
}