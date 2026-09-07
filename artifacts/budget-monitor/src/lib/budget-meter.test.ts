import { describe, expect, it } from 'vitest';
import {
  formatBudgetDate,
  formatBudgetPercent,
  getBudgetMeterModel,
  getProjectionThresholdExplanation,
  getTimeElapsedPercent,
  projectionTone,
} from './budget-meter';

describe('budget meter model', () => {
  it('keeps textual percentages above 100 while clipping visual fill', () => {
    const model = getBudgetMeterModel({ actualUsd: 125, budgetUsd: 100 });
    expect(model.actualPercent).toBe(125);
    expect(model.actualWidth).toBe(100);
    expect(formatBudgetPercent(model.actualPercent!)).toContain('125.0%');
  });

  it('uses blue actual separately from the projected extension', () => {
    const model = getBudgetMeterModel({ actualUsd: 40, budgetUsd: 100, projectedUsd: 75 });
    expect(model.actualWidth).toBe(40);
    expect(model.projectedWidth).toBe(35);
    expect(model.capacityWidth).toBe(25);
    expect(model.projectionTone).toBe('green');
  });

  it('applies projection visual thresholds without treating unknown as green', () => {
    expect(projectionTone(null)).toBe('neutral');
    expect(projectionTone(89.9)).toBe('green');
    expect(projectionTone(90)).toBe('amber');
    expect(projectionTone(100)).toBe('amber');
    expect(projectionTone(100.01)).toBe('red');
  });

  it('distinguishes loading, missing, invalid, zero, and unknown usage', () => {
    expect(getBudgetMeterModel({ actualUsd: null, budgetUsd: null, loading: true }).state).toBe('loading');
    expect(getBudgetMeterModel({ actualUsd: 1, budgetUsd: null }).state).toBe('no-budget');
    expect(getBudgetMeterModel({ actualUsd: 1, budgetUsd: Number.NaN }).state).toBe('invalid-budget');
    expect(getBudgetMeterModel({ actualUsd: 1, budgetUsd: Number.POSITIVE_INFINITY }).state).toBe('invalid-budget');
    expect(getBudgetMeterModel({ actualUsd: 1, budgetUsd: -1 }).state).toBe('invalid-budget');
    expect(getBudgetMeterModel({ actualUsd: 1, budgetUsd: 0 }).state).toBe('zero-budget');
    expect(getBudgetMeterModel({ actualUsd: null, budgetUsd: 100 }).state).toBe('unknown');
  });

  it('explains the same projection thresholds used for tone', () => {
    expect(getProjectionThresholdExplanation(null)).toContain('Projection threshold unavailable');
    expect(getProjectionThresholdExplanation(null)).toContain('near limit is 90%–100%');
    expect(getProjectionThresholdExplanation(89.9)).toContain('below 90%');
    expect(getProjectionThresholdExplanation(90)).toContain('90%–100%');
    expect(getProjectionThresholdExplanation(100.01)).toContain('exceeds 100%');
  });

  it('keeps downward and signed projections truthful without drawing backwards', () => {
    const model = getBudgetMeterModel({ actualUsd: 70, budgetUsd: 100, projectedUsd: 50 });
    expect(model.projectedWidth).toBe(0);
    expect(model.projectedPercent).toBe(50);
    const adjusted = getBudgetMeterModel({ actualUsd: -10, budgetUsd: 100, projectedUsd: -20 });
    expect(adjusted.state).toBe('ready');
    expect(adjusted.actualPercent).toBe(-10);
    expect(adjusted.projectedPercent).toBe(-20);
    expect(adjusted.actualWidth).toBe(0);
  });

  it('positions elapsed time against the end-exclusive period in UTC', () => {
    expect(getTimeElapsedPercent('2026-09-01', '2026-10-01', '2026-09-03')).toBe(10);
    expect(getTimeElapsedPercent(
      '2026-09-01T00:00:00-07:00',
      '2026-09-11T00:00:00-07:00',
      '2026-09-06T00:00:00-07:00',
    )).toBe(50);
    expect(formatBudgetDate('2026-09-01T23:30:00-07:00')).toBe('Sep 2, 2026');
  });
});