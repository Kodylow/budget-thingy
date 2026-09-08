import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./funding-groups-hierarchy.tsx', import.meta.url), 'utf8');

describe('funding group mapping interaction safety', () => {
  it('shows exact identities and allocation context', () => {
    expect(source).toContain('{group.workspaceId} / {group.groupId}');
    expect(source).toContain('Workspace ID');
    expect(source).toContain('Group ID');
    expect(source).toContain('total through {allocationYear}');
  });

  it('captures a revision for review rather than reading a changing prop at save time', () => {
    expect(source).toContain('setRevisionAtOpen(revision)');
    expect(source).toContain('setReviewedRevision(revisionAtOpen)');
    expect(source).toContain('expectedRevision: reviewedRevision');
    expect(source).not.toContain('expectedRevision: revision,');
  });

  it('preserves the destination but requires renewed review after refresh', () => {
    expect(source).toContain('data-testid="button-refresh-funding-group-conflict"');
    expect(source).toContain('setReviewedRevision(null)');
    expect(source).toContain("setStep('select')");
    expect(source).toContain('Review the preserved destination again before saving.');
  });

  it('surfaces stale inventory even without a provider error', () => {
    expect(source).toContain("inventory.freshness.status === 'stale'");
    expect(source).toContain('Directory inventory may be out of date');
    expect(source).toContain('<Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>');
  });
});