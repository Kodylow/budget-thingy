const fs = require('fs');
const file = 'artifacts/budget-monitor/src/pages/org-budget-chart.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /return buildOrgBudgetChartData\(data, selectedTeamIds\);/g,
  'const selectedTeams = fundedTeams.filter(t => selectedTeamIds.has(t.id));\n    return buildOrgBudgetChartData(data, selectedTeams);'
);

fs.writeFileSync(file, content);
