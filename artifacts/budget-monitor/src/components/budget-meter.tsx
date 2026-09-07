import React, { useEffect, useId, useRef, useState } from 'react';
import {
  formatBudgetPercent,
  formatBudgetDate,
  getBudgetMeterModel,
  getProjectionThresholdExplanation,
  getTimeElapsedPercent,
  type BudgetMeterTone,
} from '@/lib/budget-meter';
import { formatFinancialUsd } from '@/lib/financial-format';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import './budget-meter.css';

export interface BudgetMeterProps {
  actualUsd: number | null;
  budgetUsd: number | null;
  projectedUsd?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  dataThrough?: string | null;
  stale?: boolean;
  incomplete?: boolean;
  label?: string;
  compact?: boolean;
  loading?: boolean;
  animateKey?: string;
}

const toneClass: Record<BudgetMeterTone, string> = {
  neutral: 'budget-meter__projection--neutral',
  green: 'budget-meter__projection--green',
  amber: 'budget-meter__projection--amber',
  red: 'budget-meter__projection--red',
};

export function BudgetMeter(props: BudgetMeterProps) {
  const {
    actualUsd, budgetUsd, projectedUsd, periodStart, periodEnd, dataThrough,
    stale = false, incomplete = false, label = 'Budget utilization',
    compact = false, loading = false, animateKey,
  } = props;
  const model = getBudgetMeterModel({ actualUsd, budgetUsd, projectedUsd, loading });
  const projectionRequested = Object.prototype.hasOwnProperty.call(props, 'projectedUsd');
  const timeElapsedPercent = getTimeElapsedPercent(periodStart, periodEnd, dataThrough);
  const descriptionId = useId();
  const previousAnimateKey = useRef(animateKey);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (animateKey !== undefined && previousAnimateKey.current !== animateKey) {
      setAnimate(true);
      const timer = window.setTimeout(() => setAnimate(false), 450);
      previousAnimateKey.current = animateKey;
      return () => window.clearTimeout(timer);
    }
    previousAnimateKey.current = animateKey;
    return undefined;
  }, [animateKey]);

  const qualifiers = [
    stale ? 'Stale' : null,
    incomplete ? 'Incomplete' : null,
  ].filter(Boolean);
  const dateRange = periodStart && periodEnd
    ? `${formatBudgetDate(periodStart)}–${formatBudgetDate(periodEnd)} (end exclusive)`
    : null;
  const detail = [
    dateRange ? `Period ${dateRange}` : null,
    dataThrough ? `Data through ${formatBudgetDate(dataThrough)}` : null,
    ...qualifiers,
  ].filter(Boolean).join(' · ');

  let status: string;
  if (model.state === 'loading') status = 'Loading budget usage';
  else if (model.state === 'no-budget') status = incomplete ? 'Budget unknown' : 'No budget';
  else if (model.state === 'invalid-budget') status = 'Budget value invalid';
  else if (model.state === 'zero-budget') {
    status = actualUsd != null && Number.isFinite(actualUsd)
      ? `${formatFinancialUsd(actualUsd)} used · Zero budget`
      : 'Zero budget · Usage unknown';
  }
  else if (model.state === 'unknown') status = 'Usage unknown';
  else {
    status = `${formatBudgetPercent(model.actualPercent!)} used`;
    if (model.projectedPercent != null) {
      status += ` · ${formatBudgetPercent(model.projectedPercent)} projected`;
    } else if (projectionRequested) {
      status += ' · Projection unknown';
    }
  }

  const ariaLabel = `${label}: ${status}${detail ? `. ${detail}` : ''}`;
  const actualOverBudget = actualUsd != null && Number.isFinite(actualUsd) && (
    (budgetUsd === 0 && actualUsd > 0) ||
    (model.actualPercent != null && model.actualPercent > 100)
  );
  const actualDetail = model.state === 'loading'
    ? 'Loading'
    : actualUsd != null && Number.isFinite(actualUsd)
    ? `${formatFinancialUsd(actualUsd)}${model.actualPercent == null ? ' · percent unavailable' : ` · ${formatBudgetPercent(model.actualPercent)} of budget`}`
    : 'Unavailable';
  const projectionDetail = model.state === 'loading'
    ? 'Loading'
    : projectedUsd != null && Number.isFinite(projectedUsd)
    ? `${formatFinancialUsd(projectedUsd)}${model.projectedPercent == null ? ' · percent unavailable' : ` · ${formatBudgetPercent(model.projectedPercent)} of budget`}`
    : 'Unavailable';
  const capacityDetail = model.state === 'loading'
    ? 'Loading'
    : model.state === 'no-budget'
    ? (incomplete ? 'Unavailable' : 'No configured budget')
    : model.state === 'invalid-budget'
      ? 'Invalid budget value'
      : formatFinancialUsd(budgetUsd);
  const timeDetail = timeElapsedPercent == null
    ? 'Unavailable'
    : `${formatBudgetPercent(timeElapsedPercent)}${dataThrough ? ` through ${formatBudgetDate(dataThrough)}` : ''}`;
  const projectionApplicable = projectionRequested && model.projectedPercent != null;
  const thresholdDetail = model.state === 'loading'
    ? 'Projection assessment loading'
    : !projectionApplicable
    ? 'Projection threshold not applicable'
    : stale || incomplete
    ? `Assessment withheld: ${[stale ? 'stale data' : null, incomplete ? 'incomplete data' : null].filter(Boolean).join(' and ')}. Thresholds: within below 90%, near limit 90%–100%, over budget above 100%`
    : getProjectionThresholdExplanation(model.projectedPercent);
  const accessibleDetail = [
    `Actual spend ${actualDetail}`,
    projectionRequested ? `Projected spend ${projectionDetail}` : 'Projected spend not supplied',
    `Budget capacity ${capacityDetail}`,
    `Time elapsed ${timeDetail}`,
  ].filter(Boolean).join('. ');

  const inspector = (
    <>
      <div className="budget-meter__inspector-row">
        <i className="budget-meter__key" />
        <strong>Actual spend</strong>
        <span>{actualDetail}</span>
      </div>
      {projectionRequested && (
        <div className="budget-meter__inspector-row">
          <i className="budget-meter__key budget-meter__key--projection" />
          <strong>Projected spend</strong>
          <span>{projectionDetail}</span>
        </div>
      )}
      <div className="budget-meter__inspector-row">
        <i className="budget-meter__key budget-meter__key--capacity" />
        <strong>Budget capacity</strong>
        <span>{capacityDetail}</span>
      </div>
      <div className="budget-meter__inspector-row">
        <i className="budget-meter__key budget-meter__key--time" />
        <strong>Time elapsed</strong>
        <span>{timeDetail}</span>
      </div>
    </>
  );

  return (
    <>
      <AdminDataQualityNote title={label}>
        Legend: blue solid bar is actual spend; hatched bar is projected spend; outlined remainder is unused budget capacity; vertical marker is elapsed time. {thresholdDetail}.
        {projectionRequested && ' Projection is a scenario, not a guarantee.'}
      </AdminDataQualityNote>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`budget-meter ${compact ? 'budget-meter--compact' : ''}`}
            role="group"
            aria-label={ariaLabel}
            aria-description={accessibleDetail}
            aria-describedby={descriptionId}
            data-state={model.state}
            tabIndex={0}
          >
            <div className="budget-meter__labels">
              {!compact && <span className="budget-meter__label">{label}</span>}
              <span className={`budget-meter__status ${actualOverBudget ? 'budget-meter__status--over' : ''}`}>
                {status}
                {qualifiers.length > 0 && <span className="budget-meter__qualifier"> · {qualifiers.join(' · ')}</span>}
              </span>
            </div>
            <div
              className={`budget-meter__track ${animate ? 'budget-meter__track--animate' : ''} ${loading ? 'animate-pulse-glow' : ''}`}
              aria-hidden="true"
            >
              <span
                className={`budget-meter__actual ${model.actualPercent != null && model.actualPercent > 100 ? 'budget-meter__actual--over' : ''}`}
                style={{ width: `${model.actualWidth}%` }}
              />
              {model.projectedWidth > 0 && (
                <span
                  className={`budget-meter__projection ${toneClass[stale || incomplete ? 'neutral' : model.projectionTone]}`}
                  style={{ width: `${model.projectedWidth}%` }}
                />
              )}
              <span className="budget-meter__capacity" style={{ width: `${model.capacityWidth}%` }} />
              {timeElapsedPercent != null && (
                <span
                  className={`budget-meter__time-marker ${
                    timeElapsedPercent === 0
                      ? 'budget-meter__time-marker--start'
                      : timeElapsedPercent === 100
                        ? 'budget-meter__time-marker--end'
                        : ''
                  }`}
                  style={{ left: `${timeElapsedPercent}%` }}
                  title={`Time elapsed through ${formatBudgetDate(dataThrough!)}`}
                />
              )}
            </div>
            {!compact && detail && <div className="budget-meter__detail">{detail}</div>}
            <span id={descriptionId} className="budget-meter__a11y-description">{accessibleDetail}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent
          className="budget-meter__inspector"
          side="bottom"
          align="end"
          collisionPadding={8}
        >
          {inspector}
        </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  );
}