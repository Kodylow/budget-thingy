const fs = require('fs');
const file = 'artifacts/budget-monitor/src/pages/org-insights-components.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /import \{\n  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LineChart, Line, ReferenceLine\n\} from "recharts";\n/,
  ''
);

fs.writeFileSync(file, content);
