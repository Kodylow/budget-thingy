import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./limits.tsx', import.meta.url), 'utf8');

describe('Limits safety regressions', () => {
  it('blocks every selection path in effective read-only mode', () => {
    expect(source).toMatch(/const handleGroupToggle[\s\S]*?if \(isReadOnly\) return;/);
    expect(source).toMatch(/const toggleMember[\s\S]*?if \(isReadOnly \|\| !isMemberSelectable\(m\)\) return;/);
    expect(source).toMatch(/const handlePageToggle[\s\S]*?if \(isReadOnly\) return;/);
    expect(source).toMatch(/const handleSelectAllMatching[\s\S]*?if \(isReadOnly\) return;/);
    expect(source).toContain('disabled={isReadOnly || pageSelectable.length === 0}');
    expect(source).toMatch(/onClick=\{handleSelectAllMatching\} disabled=\{isReadOnly\}/);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(isReadOnly\)[\s\S]*?return;[\s\S]*?getContextSelectionUpdate/);
    expect(source).toContain('{!isReadOnly && selectedUserIds.size > 0 && (');
    expect(source).toContain('onClick={onClear} disabled={isReadOnly}');
    expect(source).toContain('new Set(pagedMembers.filter(isMemberSelectable)');
    expect(source).toContain("e.target.closest('button, input, a, [role=\"checkbox\"]')");
  });

  it('gates writable policy controls with effective workspace write access', () => {
    expect(source).toContain('canManagePolicies={canManagePolicies && ws.canWrite && !ws.unavailableReason}');
    expect(source).toContain('enabled: canManagePolicies');
  });
});