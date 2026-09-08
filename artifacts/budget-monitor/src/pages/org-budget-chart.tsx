import React, { useState, useMemo, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine
} from 'recharts';
import { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import { formatUsd } from '@/pages/home-components/format';
import { hasCompatibleOrgChartInput } from './org-chart-input';
import { OrgChartUnavailable } from './org-chart-recovery';
import { reportRenderFailure } from '@/lib/render-diagnostics';

import {
  getFundedTeams,
  buildOrgBudgetChartData,
  allocationPercent,
  hasUsableAllocation,
  orgChartDay,
  orgChartDateLabel,
  TOTAL_SERIES_ID,
  type OrgChartSeries,
  type OrgBudgetChartRow,
} from './org-budget-chart-data';

const CHART_COLORS = [
  "#2563eb", "#db2777", "#059669", "#ea580c", "#9333ea",
  "#0891b2", "#dc2626", "#65a30d", "#4f46e5", "#e11d48",
  "#c026d3", "#0284c7", "#16a34a", "#ea580c", "#4338ca"
];

const formatPercent = (value: number | null) => value == null
  ? 'Unavailable'
  : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export function OrgBudgetChart({ data, onRetry }: {
  data: OrgBudgetOverviewResponse;
  onRetry: () => Promise<void>;
}) {
  const compatible = hasCompatibleOrgChartInput(data);
  const fundedTeams = useMemo(() => compatible ? getFundedTeams(data.teams) : [], [compatible, data?.teams]);
  useEffect(() => {
    if (!compatible) reportRenderFailure(new Error('ORG_CHART_INPUT_INCOMPATIBLE'), { componentStack: '' }, 'org-budget-chart');
  }, [compatible]);
  
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(() => new Set());
  const [showTotal, setShowTotal] = useState(true);
  const [normalized, setNormalized] = useState(false);
  const availableSelection = new Set([...selectedTeamIds].filter(id => fundedTeams.some(team => team.id === id)));
  if (compatible && availableSelection.size !== selectedTeamIds.size) {
    setSelectedTeamIds(availableSelection);
  }
  const teamColors = useMemo(() => {
    const map = new Map<string, string>([[TOTAL_SERIES_ID, '#0D62FF']]);
    fundedTeams.forEach(t => {
      const hash = Array.from(t.id).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
      map.set(t.id, CHART_COLORS[hash % CHART_COLORS.length]);
    });
    return map;
  }, [fundedTeams]);

  const selectedTeams = useMemo(() => fundedTeams.filter(t => selectedTeamIds.has(t.id)), [fundedTeams, selectedTeamIds]);
  if (!compatible) return <OrgChartUnavailable incompatible onRetry={onRetry} />;
  const total: OrgChartSeries = {
    id: TOTAL_SERIES_ID,
    name: 'Total',
    allocationUsd: data.summary.teamAllocationUsd,
    spendUsd: data.summary.accountSpendUsd,
    complete: data.complete,
    points: data.accountPoints,
  };
  const selectedSeries = [...(showTotal ? [total] : []), ...selectedTeams];
  const chartData = buildOrgBudgetChartData(data, selectedSeries);
  const plottedSeries = normalized ? selectedSeries.filter(team => hasUsableAllocation(team.allocationUsd)) : selectedSeries;
  const normalizationUnavailable = normalized && selectedSeries.length > 0 && plottedSeries.length === 0;
  const hasChartValues = chartData.some(row => Object.values(row.values).some(value => value.actual !== null || value.benchmark !== null));
  
  const toggleTeam = (id: string) => {
    const next = new Set(selectedTeamIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedTeamIds(next);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-0 border rounded bg-card overflow-hidden lg:h-[520px]" data-testid="org-budget-chart">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold">Budget Trajectory</h2>
          <p className="text-xs text-muted-foreground mt-1">Total eligible account spend against allocated team funding, or individual teams. Dashed lines show an even pace, not a forecast.</p>
        </div>
        
        <div className="flex gap-6 items-center text-xs text-muted-foreground mb-4">
          <div className="flex items-center gap-2"><i className="w-4 border-t-[3px] border-slate-500" /> Recorded spend</div>
          <div className="flex items-center gap-2"><i className="w-4 border-t-2 border-dashed border-slate-400" /> Even-paced budget</div>
        </div>

        <div className="w-full h-[320px] lg:h-auto lg:flex-1 min-h-[280px]">
          {selectedSeries.length === 0 || normalizationUnavailable || !hasChartValues ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-sm text-muted-foreground border-2 border-dashed rounded bg-muted/20 p-6 text-center">
              <p>{selectedSeries.length === 0 ? 'No series selected.' : normalizationUnavailable ? 'Normalization unavailable.' : 'Spend and budget data unavailable.'}</p>
              <p className="mt-1 text-xs opacity-75">{selectedSeries.length === 0 ? 'Turn on Total or a team to view its trajectory.' : normalizationUnavailable ? 'Switch to Dollars to view recorded spend without a usable allocation.' : 'Selected series have no recorded spend or allocated budget yet.'}</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }} accessibilityLayer>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
                <XAxis 
                  dataKey="day" 
                  type="number" 
                  domain={['dataMin', 'dataMax']} 
                  allowDecimals={false} 
                  axisLine={false} 
                  tickLine={false} 
                  minTickGap={50} 
                  tickFormatter={orgChartDateLabel} 
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} 
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  width={55} 
                  domain={[0, 'auto']} 
                  tickFormatter={(v) => normalized ? formatPercent(v) : v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`}
                  label={normalized ? { value: '% of allocation', angle: -90, position: 'insideLeft', fontSize: 10 } : undefined}
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} 
                />
                {data.asOf && (
                  <ReferenceLine 
                    x={orgChartDay(data.asOf.slice(0, 10))}
                    stroke="#0D62FF" 
                    strokeDasharray="4 4" 
                    label={{ value: 'As of', position: 'insideTopLeft', fontSize: 10, fill: '#0D62FF' }} 
                  />
                )}
                
                <RechartsTooltip
                  cursor={{ stroke: '#CBD5E1', strokeDasharray: '4 4' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload;
                    if (!row || !row.values) return null;
                    
                    return (
                      <div className="bg-popover border text-popover-foreground p-3 rounded-md shadow-md text-xs z-50 min-w-64 max-h-[350px] overflow-y-auto">
                        <div className="font-bold mb-3 pb-2 border-b">{orgChartDateLabel(Number(label))}</div>
                        <div className="flex flex-col gap-3">
                          {selectedSeries.map(team => {
                            const id = team.id;
                            const vals = row.values[id];
                            if (!vals || (vals.actual == null && vals.benchmark == null)) return null;
                            
                            return (
                              <div key={id} className="flex gap-4 justify-between items-start">
                                <div className="flex flex-col gap-0.5 max-w-[160px]">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: teamColors.get(id) }} />
                                   <span className="font-semibold break-words">{team.name}</span>
                                  </div>
                                  {!team.complete && <span className="text-[10px] text-amber-600 dark:text-amber-500 pl-3.5">Partial data</span>}
                                </div>
                                <div className="flex flex-col items-end text-right shrink-0">
                                  {vals.actual != null && <span className="font-mono font-medium">{normalized ? `Recorded: ${formatPercent(allocationPercent(vals.actual, team.allocationUsd))} (${formatUsd(vals.actual)})` : formatUsd(vals.actual)}</span>}
                                  {vals.benchmark != null && <span className="text-[10px] font-mono text-muted-foreground">Pace: {normalized ? `${formatPercent(allocationPercent(vals.benchmark, team.allocationUsd))} (${formatUsd(vals.benchmark)})` : formatUsd(vals.benchmark)}</span>}
                                  <span className="text-[10px] font-mono text-muted-foreground opacity-80">Allocated: {team.allocationUsd == null ? 'Unavailable' : formatUsd(team.allocationUsd)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />

                {plottedSeries.flatMap(team => {
                  const id = team.id;
                  const color = teamColors.get(id);
                  return [
                      <Line
                        key={`${id}:actual`}
                        type="monotone"
                        dataKey={(row: OrgBudgetChartRow) => normalized ? allocationPercent(row.values[id]?.actual, team.allocationUsd) : row.values[id]?.actual}
                        name={`${team.name} Actual`}
                        stroke={color}
                        strokeWidth={3}
                        dot={false}
                        activeDot={{ r: 4 }}
                         connectNulls={false}
                        isAnimationActive={false}
                      />,
                      <Line
                        key={`${id}:benchmark`}
                        type="linear"
                        dataKey={(row: OrgBudgetChartRow) => normalized ? allocationPercent(row.values[id]?.benchmark, team.allocationUsd) : row.values[id]?.benchmark}
                        name={`${team.name} Budget`}
                        stroke={color}
                        strokeWidth={2}
                        strokeDasharray="6 4"
                        strokeOpacity={0.6}
                        dot={false}
                        activeDot={false}
                         connectNulls={false}
                        isAnimationActive={false}
                      />,
                  ];
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
      
      <div className="w-full lg:w-[320px] shrink-0 min-h-0 flex flex-col border-t lg:border-t-0 lg:border-l bg-muted/10 lg:h-full h-[400px]">
        <div role="group" aria-label="Trajectory units" className="flex shrink-0 gap-1 border-b p-3">
          {[{ label: 'Dollars', value: false }, { label: '% of allocation', value: true }].map(mode => (
            <button
              key={mode.label}
              type="button"
              aria-pressed={normalized === mode.value}
              onClick={() => setNormalized(mode.value)}
              className={`flex-1 rounded border px-2 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${normalized === mode.value ? 'bg-background border-primary/50' : 'border-transparent text-muted-foreground hover:bg-muted/50'}`}
            >{mode.label}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <div className="flex justify-between px-3 pl-9 pb-2 text-[10px] text-muted-foreground"><span>{normalized ? 'Recorded spend (%)' : 'Recorded spend'}</span><span>Allocation</span></div>
          <div className="flex flex-col gap-2 pb-4">
             {[total, ...fundedTeams].map(team => {
               const isSelected = team.id === TOTAL_SERIES_ID ? showTotal : selectedTeamIds.has(team.id);
               const color = teamColors.get(team.id);
               return (
                 <button
                   key={team.id}
                   type="button"
                   aria-pressed={isSelected}
                   onClick={() => team.id === TOTAL_SERIES_ID ? setShowTotal(value => !value) : toggleTeam(team.id)}
                    className={`text-left px-3 py-2.5 rounded-2xl border transition-colors flex flex-col gap-1.5 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      ${isSelected ? 'bg-background border-primary/50' : 'bg-transparent border-border/50 hover:bg-muted/50'}`}
                 >
                   <div className="flex gap-2 items-start justify-between w-full">
                     <div className="flex items-start gap-2.5 min-w-0">
                       <div 
                         className="w-3.5 h-3.5 rounded-full shrink-0 mt-0.5 transition-colors" 
                         style={{ 
                           backgroundColor: isSelected ? color : 'transparent', 
                           borderWidth: '2px', 
                           borderColor: isSelected ? color : 'var(--muted-foreground)' 
                         }} 
                       />
                       <span className="text-sm font-medium leading-snug break-words">{team.name}</span>
                     </div>
                   </div>
                   <div className="pl-6 text-xs text-muted-foreground flex justify-between w-full font-mono">
                     <span>
                       {normalized && !hasUsableAllocation(team.allocationUsd) ? 'Unavailable' : team.spendUsd != null
                         ? normalized ? formatPercent(allocationPercent(team.spendUsd, team.allocationUsd)) : formatUsd(team.spendUsd)
                         : 'No spend data'}
                     </span>
                     <span className="opacity-70">{team.allocationUsd == null ? 'Unavailable' : formatUsd(team.allocationUsd)}</span>
                   </div>
                 </button>
               );
             })}
          </div>
        </div>
      </div>
    </div>
  );
}
