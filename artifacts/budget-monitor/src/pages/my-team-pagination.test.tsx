// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaginatedPeopleTable, PaginatedProjectsTable } from './my-team';

vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => vi.unstubAllGlobals());

const mocks = vi.hoisted(() => ({
  people: vi.fn(),
  projects: vi.fn(),
}));

vi.mock('wouter', () => ({
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
  useLocation: () => ['/my-team', vi.fn()],
  useSearch: () => '',
}));

vi.mock('wouter/use-browser-location', () => ({
  useSearch: () => '',
}));

vi.mock('@workspace/api-client-react', () => ({
  getGetDashboardQueryKey: (params: any) => ['dashboard', params],
  getListSpendPeopleQueryKey: (params: any) => ['people', params],
  getListSpendProjectsQueryKey: (params: any) => ['projects', params],
  useGetDashboard: vi.fn(),
  useListSpendPeople: (...args: any[]) => mocks.people(...args),
  useListSpendProjects: (...args: any[]) => mocks.projects(...args),
}));

function peopleRows(page: number) {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `person-${page}-${index}`,
    kind: 'person',
    userId: `user-${page}-${index}`,
    name: `Person ${page}-${index}`,
    workspaceName: 'Workspace',
    workspaces: [],
    spendUsd: 0,
    agentSpendUsd: 0,
    otherServicesUsd: 0,
    usageObserved: true,
    allocationUsd: null,
    currentCycleAgentSpendUsd: null,
    limitState: 'unavailable',
    limitObservationStatus: 'unavailable',
  }));
}

function projectRows(page: number) {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `project-${page}-${index}`,
    projectId: `project-${page}-${index}`,
    kind: 'project',
    name: `Project ${page}-${index}`,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    ownerName: 'Owner',
    spendUsd: 0,
    agentSpendUsd: 0,
    otherServicesUsd: 0,
    usageObserved: true,
  }));
}

function result(rows: unknown[]) {
  return {
    data: { rows, filteredRows: 125 },
    isLoading: false,
    isFetching: false,
  };
}

function button(container: HTMLElement, name: string) {
  const match = [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent === name);
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.people.mockImplementation((params: any) => result(peopleRows(params.page)));
  mocks.projects.mockImplementation((params: any) => result(projectRows(params.page)));
});

describe.each([
  {
    label: 'people',
    render: () => <PaginatedPeopleTable params={{ rangeType: 'full-term', viewScope: 'managed' }} rangeType="full-term" />,
    request: mocks.people,
    next: 'Next people',
    previous: 'Previous people',
  },
  {
    label: 'projects',
    render: () => <PaginatedProjectsTable params={{ rangeType: 'full-term', viewScope: 'managed' }} />,
    request: mocks.projects,
    next: 'Next projects',
    previous: 'Previous projects',
  },
])('My Team $label pagination', ({ render, request, next, previous }) => {
  it('uses bounded ten-row requests and stops at the final page', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(render()));
      await act(async () => button(container, 'View all').click());

      for (let index = 0; index < 10; index += 1) {
        await act(async () => button(container, next).click());
      }

      expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ page: 11, pageSize: 10 });
      expect(request.mock.calls.every(([params]) => params.pageSize <= 100)).toBe(true);

      await act(async () => button(container, next).click());
      await act(async () => button(container, next).click());
      expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ page: 13, pageSize: 10 });
      expect(button(container, next).disabled).toBe(true);

      await act(async () => button(container, previous).click());
      expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ page: 12, pageSize: 10 });
      expect(button(container, next).disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});