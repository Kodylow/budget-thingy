import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./team-budgets.tsx', import.meta.url), 'utf8');

describe('Allocation page safety regressions', () => {
  it('keeps allocation edits capability-based but visibility true-admin-only', () => {
    expect(source).toContain('getAllocationPermissions(capabilities, isPreviewing || auth?.previewReadOnly === true)');
    expect(source).toContain('canEdit={canEdit}');
    expect(source).toContain('{canManageVisibility && (');
    expect(source).toContain('filterVisibleTeams([...(historyQuery.data?.teams ?? [])], canManageVisibility)');
    expect(source).toContain('filterVisibleAudits(');
  });

  it('uses review and explicit save instead of blur autosave', () => {
    expect(source).not.toContain('onBlur=');
    expect(source).toContain('Review change');
    expect(source).toContain('Save opening funding');
    expect(source).toContain('Save outcome not confirmed');
    expect(source).toContain('This screen will not retry automatically.');
  });

  it('retains and reuses the normalized monthly request after an uncertain result', () => {
    expect(source).toContain('mutation: { retry: false }');
    expect(source).toContain('requestRef.current?.payload !== payload');
    expect(source).toContain("requestRef.current = { payload, key: crypto.randomUUID(), draft: normalized.draft };");
    expect(source).toContain('Retry same addition');
    expect(source).toContain('Its request ID is retained to prevent a duplicate entry.');
    expect(source).toContain('disabled={addMutation.isPending || addMutation.isError}');
  });

  it('clears dialog drafts on authorization changes and supports small screens', () => {
    expect(source).toContain('<AddAllocationDialog key={authorizationKey}');
    expect(source).toContain('key={`${authorizationKey}:${row.team.teamName}`}');
    expect(source.match(/<DialogContent className="max-h-\[90dvh\] overflow-y-auto">/g)).toHaveLength(2);
  });
});