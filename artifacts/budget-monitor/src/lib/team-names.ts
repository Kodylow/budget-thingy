export function formatTeamName(teamName: string): string {
  if (teamName === 'DXP') return 'Growth Strategy & Operations DXP';
  if (teamName === 'Non-DXP') return 'Growth Strategy & Operations Non-DXP';
  return teamName;
}