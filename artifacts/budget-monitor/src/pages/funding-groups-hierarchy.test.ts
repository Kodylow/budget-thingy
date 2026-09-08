import { describe, expect, it } from 'vitest';
import {
  buildFundingHierarchy,
  fundingGroupKey,
  matchesFundingGroupSearch,
  type FundingGroup,
} from './funding-groups-hierarchy';

const groups: FundingGroup[] = [
  { workspaceId: 'ws-1', workspaceName: 'Comcast', groupId: 'g-1', groupName: 'BnD', teamName: null, origin: 'unmapped', isHidden: false },
  { workspaceId: 'ws-2', workspaceName: 'DXP Lab', groupId: 'g-1', groupName: 'Members', teamName: 'Experience', origin: 'inferred', isHidden: false },
  { workspaceId: 'ws-3', workspaceName: 'PREPROD', groupId: 'g-3', groupName: 'Viewer', teamName: 'Hidden', origin: 'explicit', isHidden: true },
];

describe('funding groups hierarchy', () => {
  it('keys the exact workspace/group pair', () => {
    expect(fundingGroupKey(groups[0])).toBe('ws-1:g-1');
    expect(fundingGroupKey(groups[1])).toBe('ws-2:g-1');
  });

  it('searches team, workspace, and group labels', () => {
    expect(matchesFundingGroupSearch(groups[1], 'experience')).toBe(true);
    expect(matchesFundingGroupSearch(groups[1], 'dxp')).toBe(true);
    expect(matchesFundingGroupSearch(groups[1], 'members')).toBe(true);
    expect(matchesFundingGroupSearch(groups[1], 'other')).toBe(false);
  });

  it('finds nested groups without requiring their team to be expanded', () => {
    const result = buildFundingHierarchy(groups, ['Experience'], 'DXP');
    expect(result.teams).toEqual(['Experience']);
    expect(result.byTeam.get('Experience')?.map(group => group.groupId)).toEqual(['g-1']);
  });

  it('keeps unmapped separate and excludes hidden inventory', () => {
    const result = buildFundingHierarchy(groups, ['Experience', 'Hidden'], '');
    expect(result.unmapped.map(group => group.groupName)).toEqual(['BnD']);
    expect(result.byTeam.get('Hidden')).toEqual([]);
    expect(buildFundingHierarchy(groups, ['Hidden'], '', true).byTeam.get('Hidden')).toHaveLength(1);
  });
});