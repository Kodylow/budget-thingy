export function compareTeamNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

export function formatTeamName(teamName: string): string {
  return teamName;
}