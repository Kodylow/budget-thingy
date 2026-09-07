# Budget pace and projections

Overview projections are read-only arithmetic scenarios, not promised charges,
predictions of hard-limit behavior, or changes to an allocation.

## Five separate contexts

- **Actual reporting period** is the range used by the existing spend cards and
  reporting chart.
- **Project through** is a calendar month-end, a verified current billing-cycle
  end, or an explicitly user-selected planning date.
- **Rate based on** names the complete UTC observation days used by the estimate.
- **Data through** identifies the last complete daily observation in the estimate.
  This is different from the timestamp when a snapshot was refreshed.
- **Scope** is the same authorized scope as the dashboard. A projection must not
  broaden it to obtain more history.

The full-term reporting range ends today. It does not supply a future contract
boundary. A planning date stored in the URL is a personal view setting, not an
organizational budget edit. Historical selections do not silently forecast the
current period. User-selected future planning dates are supported through the
next five years; this is a forecast-view limit, not a contract boundary.

## Method and limitations

The rate is the arithmetic mean of up to 28 consecutive complete UTC days, with
at least seven complete days required. Today is excluded. Confirmed zero-spend
days count; absent observations do not. Credits and adjustments keep their sign.
The projected total starts with complete actual spend in the target accounting
period, then adds the daily rate for the remaining days. Missing baseline facts
prevent a total estimate, even when a recent rate can be calculated.

When both samples exist, seven-day and 28-day pace scenarios illustrate how the
choice of source window affects the result. Their span is not a confidence
interval or a probability. Stale observations are qualified explicitly.

## Budget comparisons

Dollar estimates do not require a budget. A reference line, projected percentage,
or remaining/overage comparison requires a denominator that matches the scope,
spend metric, and accounting period. In particular:

- Undated opening planning allocations are not monthly quotas.
- Workspace member Agent limits are not transferable or pooled. Only matching
  current-cycle Agent usage may be compared with a member's workspace limit.
- Incomplete or unavailable observations cannot establish healthy budget status.

## Visual language

Solid blue represents actual usage. Dashed chart lines and patterned meter
extensions represent estimates. Neutral capacity is unused budget, not a forecast.
Values above 100% remain explicit in text even when the meter track is full.

For an applicable, assessable projected budget, the visual thresholds are:

| Projected use | Meaning |
| --- | --- |
| Below 90% | Within the applicable projected budget; deep green |
| 90–100%, inclusive | Near the boundary; amber |
| Above 100%, or actual already exceeded | Overage; restrained red |
| Unknown, incomplete, or stale assessment | Qualified/neutral, never healthy green |

These are visual-only thresholds. They do not alter configured email alerts,
upstream limits, allocations, or budget-write permissions. Higher absolute spend
is not inherently bad. Text, line styles, and patterns preserve the meaning
without requiring red/green color perception.