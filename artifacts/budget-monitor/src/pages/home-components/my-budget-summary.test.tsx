import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MyBudgetDetails, MyBudgetSummary } from './my-budget-summary';

describe('MyBudgetSummary', () => {
  it('labels workspace-scoped current-cycle Agent limits as My Budget', () => {
    const html = renderToStaticMarkup(
      <MyBudgetSummary limits={[
        {
          workspaceId: 'one',
          workspaceName: 'Workspace one',
          amount: 100,
          state: 'explicit',
          currentCycleAgentSpendUsd: 31.76,
          currentCycleRemainingUsd: 68.24,
          currentCyclePercentUsed: 31.76,
        },
      ]} />,
    );

    expect(html).toContain('My Budget');
    expect(html).toContain('$100.00');
    expect(html).toContain('This billing cycle');
    expect(html).not.toContain('My Replit Budget');
    expect(html).not.toContain('$68.24');
  });

  it('does not turn missing finite limits into a zero budget', () => {
    const html = renderToStaticMarkup(
      <MyBudgetSummary limits={[
        {
          workspaceId: 'known',
          amount: null,
          state: 'no_limit',
          currentCycleAgentSpendUsd: 12,
        },
        {
          workspaceId: 'unknown',
          amount: null,
          state: 'unavailable',
          currentCycleAgentSpendUsd: null,
        },
      ]} />,
    );

    expect(html).toContain('Workspace limits · This billing cycle');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('$0.00');
  });

  it('distinguishes known unlimited workspaces from unavailable limits', () => {
    const unlimited = renderToStaticMarkup(
      <MyBudgetSummary limits={[
        { workspaceId: 'one', amount: null, state: 'no_limit' },
        { workspaceId: 'two', amount: null, state: 'no_limit' },
      ]} />,
    );
    const unknown = renderToStaticMarkup(
      <MyBudgetSummary limits={[
        { workspaceId: 'one', amount: null, state: 'unavailable' },
      ]} />,
    );

    expect(unlimited).toContain('No limit');
    expect(unlimited).toContain('2 unlimited workspaces');
    expect(unknown).toContain('Unavailable');
  });

  it('labels mixed finite and unlimited totals as finite-limit subtotals', () => {
    const html = renderToStaticMarkup(
      <MyBudgetSummary limits={[
        { workspaceId: 'finite', amount: 50, state: 'explicit' },
        { workspaceId: 'unlimited', amount: null, state: 'no_limit' },
      ]} />,
    );

    expect(html).toContain('$50.00');
    expect(html).toContain('Finite-limit subtotal');
  });

  it('keeps all workspaces available behind an explicit toggle', () => {
    const html = renderToStaticMarkup(
      <MyBudgetDetails showAll={false} onToggle={() => {}} limits={[
        {
          workspaceId: 'finite',
          amount: 50,
          state: 'explicit',
          currentCycleAgentSpendUsd: 0,
          currentCycleRemainingUsd: 50,
        },
        {
          workspaceId: 'unused',
          amount: null,
          state: 'no_limit',
          currentCycleAgentSpendUsd: 0,
        },
      ]} />,
    );

    expect(html).toContain('Show all 2 workspaces');
    expect(html).not.toContain('min-w-[34rem]');
    expect(html).toContain('Spent');
    expect(html).toContain('Limit');
    expect(html).toContain('Remaining');
  });
});