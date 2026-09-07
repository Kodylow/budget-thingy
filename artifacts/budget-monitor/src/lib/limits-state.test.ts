import { describe, expect, it } from 'vitest';
import { resolveLimitsStateWorkspaceId } from './limits-state';

describe('resolveLimitsStateWorkspaceId', () => {
  it('auto-selects only a sole authorized workspace', () => {
    expect(resolveLimitsStateWorkspaceId(null, [])).toBeNull();
    expect(resolveLimitsStateWorkspaceId(null, ['ws-1'])).toBe('ws-1');
    expect(resolveLimitsStateWorkspaceId(null, ['ws-1', 'ws-2'])).toBeNull();
  });

  it('preserves an explicit authorized selection and clears an invalid one', () => {
    expect(resolveLimitsStateWorkspaceId('ws-2', ['ws-1', 'ws-2'])).toBe('ws-2');
    expect(resolveLimitsStateWorkspaceId('outside-scope', ['ws-1', 'ws-2'])).toBeNull();
    expect(resolveLimitsStateWorkspaceId('outside-scope', ['ws-1'])).toBe('ws-1');
  });
});