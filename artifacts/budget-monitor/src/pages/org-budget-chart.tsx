import React, { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine
} from 'recharts';
import { Search } from 'lucide-react';
import { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import { formatUsd } from '@/pages/home-components/format';
import { Input } from '@/components/ui/input';

import {
  getFundedTeams,
  buildOrgBudgetChartData,
  orgChartDay,
  orgChartDateLabel
} from './org-budget-chart-data';

const CHART_COLORS = [
  "#2563eb", "#db2777", "#059669", "#ea580c", "#9333ea",
  "#0891b2", "#dc2626", "#65a30d", "#4f46e5", "#e11d48",
  "#c026d3", "#0284c7", "#16a34a", "#ea580c", "#4338ca"
];

export function OrgBudgetChart({ data }: { data: OrgBudgetOverviewResponse }) {
  const fundedTeams = useMemo(() => getFundedTeams(data.teams), [data.teams]);
  
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(() => {
    const initialTeams = getFundedTeams(data.teams);
    const sorted = [...initialTeams].sort((a, b) => (b.spendUsd || 0) - (a.spendUsd || 0));
    return new Set(sorted.slice(0, 3).map(t => t.id));
  });

  const [searchQuery, setSearchQuery] = useState("");

  const teamColors = useMemo(() => {
    const map = new Map<string, string>();
    fundedTeams.forEach(t => {
      const hash = Array.from(t.id).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
      map.set(t.id, CHART_COLORS[hash % CHART_COLORS.length]);
    });
    return map;
  }, [fundedTeams]);

  const filteredTeams = useMemo(() => {
    if (!searchQuery.trim()) return fundedTeams;
    const q = searchQuery.trim().toLowerCase();
    return fundedTeams.filter(t => t.name.toLowerCase().includes(q));
  }, [fundedTeams, searchQuery]);

  const selectedTeams = useMemo(() => fundedTeams.filter(t => selectedTeamIds.has(t.id)), [fundedTeams, selectedTeamIds]);
  const chartData = useMemo(() => buildOrgBudgetChartData(data, selectedTeams), [data, selectedTeams]);

  const handleSelectAll = () => setSelectedTeamIds(new Set(fundedTeams.map(t => t.id)));
  const handleClear = () => setSelectedTeamIds(new Set());
  
  const toggleTeam = (id: string) => {
    const next = new Set(selectedTeamIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedTeamIds(next);
  };

  if (fundedTeams.length === 0) {
    return (
      <div className="h-[400px] flex items-center justify-center text-muted-foreground border rounded bg-card" data-testid="org-budget-chart-empty">
        No teams with funded budgets found.
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-0 border rounded bg-card overflow-hidden lg:h-[520px]" data-testid="org-budget-chart">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold">Teams Budget Trajectory</h2>
          <p className="text-xs text-muted-foreground mt-1">Spend to date against each team’s allocated budget. Dashed lines show an even pace, not a forecast.</p>
        </div>
        
        <div className="flex gap-6 items-center text-xs text-muted-foreground mb-4">
          <div className="flex items-center gap-2"><i className="w-4 border-t-[3px] border-slate-500" /> Recorded spend</div>
          <div className="flex items-center gap-2"><i className="w-4 border-t-2 border-dashed border-slate-400" /> Even-paced budget</div>
        </div>

        <div className="w-full h-[320px] lg:h-auto lg:flex-1 min-h-[280px]">
          {selectedTeams.length === 0 ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-sm text-muted-foreground border-2 border-dashed rounded bg-muted/20 p-6 text-center">
              <p>No teams selected.</p>
              <p className="mt-1 text-xs opacity-75">Select teams from the panel to view their trajectories.</p>
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
                  tickFormatter={(v) => v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`} 
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
                          {Array.from(selectedTeamIds).map(id => {
                            const vals = row.values[id];
                            if (!vals || (vals.actual == null && vals.benchmark == null)) return null;
                            const team = fundedTeams.find(t => t.id === id);
                            if (!team) return null;
                            
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
                                  {vals.actual != null && <span className="font-mono font-medium">{formatUsd(vals.actual)}</span>}
                                  {vals.benchmark != null && <span className="text-[10px] font-mono text-muted-foreground">Pace: {formatUsd(vals.benchmark)}</span>}
                                  <span className="text-[10px] font-mono text-muted-foreground opacity-80">Funded: {formatUsd(team.allocationUsd!)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />

                {selectedTeams.flatMap(team => {
                  const id = team.id;
                  const color = teamColors.get(id);
                  return [
                      <Line
                        key={`${id}:actual`}
                        type="monotone"
                        dataKey={(row: any) => row.values[id]?.actual}
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
                        dataKey={(row: any) => row.values[id]?.benchmark}
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
        <div className="p-4 border-b flex flex-col gap-3 bg-card">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Budgeted teams <span className="text-xs text-muted-foreground">({selectedTeams.length}/{fundedTeams.length})</span></h3>
            <div className="flex gap-2 text-xs">
              <button onClick={handleSelectAll} className="text-primary hover:underline">All</button>
              <span className="text-muted-foreground">|</span>
              <button onClick={handleClear} className="text-primary hover:underline">Clear</button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search teams..." 
              aria-label="Search budgeted teams"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs bg-background"
            />
          </div>
          {selectedTeams.length > 5 && <p className="text-xs text-muted-foreground">Select fewer teams for a clearer comparison.</p>}
          <div className="flex justify-between pl-6 text-[10px] text-muted-foreground"><span>Recorded spend</span><span>Allocation</span></div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <div className="flex flex-col gap-2 pb-4">
             {filteredTeams.map(team => {
               const isSelected = selectedTeamIds.has(team.id);
               const color = teamColors.get(team.id);
               return (
                 <button
                   key={team.id}
                   type="button"
                   aria-pressed={isSelected}
                   onClick={() => toggleTeam(team.id)}
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
                       {team.spendUsd != null ? (
                         <>
                           {formatUsd(team.spendUsd)}
                           {!team.complete && <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-500 font-sans tracking-tight">(Partial)</span>}
                         </>
                        ) : 'No spend data'}
                     </span>
                     <span className="opacity-70">{formatUsd(team.allocationUsd!)}</span>
                   </div>
                 </button>
               );
             })}
             {filteredTeams.length === 0 && (
               <p className="text-center text-xs text-muted-foreground py-6">No matching teams.</p>
             )}
          </div>
        </div>
      </div>
    </div>
  );
}
