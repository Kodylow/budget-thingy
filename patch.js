const fs = require('fs');
const file = 'artifacts/budget-monitor/src/pages/org-insights-components.tsx';
const lines = fs.readFileSync(file, 'utf8').split('\n');

const start = lines.findIndex(l => l.startsWith('export function OrgBudgetChart({ data }'));
const end = lines.findIndex((l, i) => i > start && l === '}');

if (start !== -1 && end !== -1) {
  lines.splice(start, end - start + 1, 'export { OrgBudgetChart } from "./org-budget-chart";');
  fs.writeFileSync(file, lines.join('\n'));
  console.log('Patched successfully');
} else {
  console.log('Failed to find start or end', start, end);
}
