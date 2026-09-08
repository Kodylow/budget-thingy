import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLimitsUrlContext } from '@/lib/limits-utils';

const pageSource = readFileSync(new URL('./limits-live.tsx', import.meta.url), 'utf8');
const legacySource = readFileSync(new URL('./limits.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const tableSource = readFileSync(new URL('../components/live-limits-table.tsx', import.meta.url), 'utf8');

describe('Usage Limits navigation and capability boundaries', () => {
  it('uses the graduated live table as the default without removing the legacy dialog export', () => {
    expect(pageSource).toContain('return <LiveLimitsTable />');
    expect(appSource).toContain("lazy(() => import('@/pages/limits-live'))");
    expect(legacySource).toContain('export function OperationManagerDialog');
  });

  it.each([
    ['workspaceId=ws-sample', 'ws-sample', []],
    ['workspaceId=ws-sample&groupId=members-id', 'ws-sample', ['members-id']],
    ['workspaceId=ws-sample&groupIds=one,two', 'ws-sample', ['one', 'two']],
    ['view=individual', null, []],
    ['view=groups', null, []],
  ] as const)('preserves existing deep-link context: %s', (search, workspaceId, groupIds) => {
    expect(parseLimitsUrlContext(search)).toEqual({ workspaceId, groupIds });
  });

  it('keeps preview controls read-only and account-only clear behind server capability', () => {
    expect(tableSource).toContain("const previewReadOnly = isPreviewing || auth?.previewReadOnly === true");
    expect(tableSource).toContain('limits.data?.canClearAll');
    expect(tableSource).toContain('realIsAccountAdmin && !previewReadOnly');
    expect(tableSource).toContain('disabled={!canClear || tableUnavailable');
  });
});