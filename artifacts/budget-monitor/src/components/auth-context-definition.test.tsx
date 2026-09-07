import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AuthContext,
  type AuthContextValue,
  useAuthContext,
} from './auth-context-definition';

function IdentityProbe() {
  return <span>{useAuthContext().user?.id}</span>;
}

describe('stable AuthContext definition', () => {
  it('shares the provider value with an independently imported consumer', () => {
    const value = { user: { id: 'real-user' } } as AuthContextValue;
    expect(renderToString(
      <AuthContext.Provider value={value}>
        <IdentityProbe />
      </AuthContext.Provider>,
    )).toContain('real-user');
  });

  it('fails explicitly rather than fabricating signed-out authorization', () => {
    expect(() => renderToString(<IdentityProbe />)).toThrow(
      'useAuthContext must be used within an <AuthProvider>',
    );
  });
});