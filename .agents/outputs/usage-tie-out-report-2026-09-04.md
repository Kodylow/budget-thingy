UTC report timestamp: 2026-09-04T08:00:14.338Z

# Usage Tie-Out Report

## 1. Closed-days per-workspace totals from the store

Development database; inclusive range 2026-08-19 through 2026-09-03.

| workspace_id | usd | days | not_complete |
|---|---:|---:|---:|
| ntcqubwqvl | 4248.87 | 16 | 0 |
| 6g8nnwm9cc | 1997.00 | 16 | 0 |
| zigw1yqwrb | 1879.98 | 16 | 0 |
| stk0jl35jw | 1623.02 | 16 | 0 |
| 66ox9cntlf | 1178.33 | 16 | 0 |
| 8h7pfz | 1066.84 | 16 | 0 |
| rpyg1v7i9q | 489.85 | 16 | 0 |
| ha7tj2 | 391.94 | 16 | 0 |
| ysf55yjzku | 367.59 | 16 | 0 |
| hyjfq2n04a | 194.72 | 16 | 0 |
| 5b0iso4ru5 | 189.94 | 16 | 0 |
| nu6ymuuhox | 139.83 | 16 | 0 |
| 1awqan | 124.75 | 16 | 0 |
| h7b8kqg88e | 41.49 | 16 | 0 |
| znvqc2gqxf | 13.46 | 16 | 0 |
| hewdniynr3 | 0.53 | 16 | 0 |
| 5hkg15xcxd | 0.00 | 16 | 0 |
| z0lgt1mzb3 | 0.00 | 16 | 0 |
| jm28gedjf5 | 0.00 | 16 | 0 |
| ksuqvf7j5b | 0.00 | 16 | 0 |

Account-day total: **$13948.11**.

## 2. Same range through the application's authenticated read path

Authenticated account-wide application-admin role: `account_delegate`. No true `account_admin` session was unexpired during collection; the existing `account_delegate` role has the same account-wide application read scope.

| field | raw value |
|---|---|
| status | partial |
| dataAsOf | 2026-09-04T07:54:04.864Z |
| accountWorkspaceUnreconciledUsd | -790.27 |

Full coverage object (unaltered from the summary response):

```json
{
  "requestedDays": 16,
  "requestedWorkspaceDays": 320,
  "presentWorkspaceDays": 214,
  "failedWorkspaceDays": [],
  "missingWorkspaceDays": [
    {
      "workspaceId": "1awqan",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "1awqan",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "1awqan",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "1awqan",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "1awqan",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "5b0iso4ru5",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "5b0iso4ru5",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "5b0iso4ru5",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "5b0iso4ru5",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "5b0iso4ru5",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "5hkg15xcxd",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "5hkg15xcxd",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "5hkg15xcxd",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "5hkg15xcxd",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "5hkg15xcxd",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "66ox9cntlf",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "66ox9cntlf",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "66ox9cntlf",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "66ox9cntlf",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "66ox9cntlf",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "6g8nnwm9cc",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "6g8nnwm9cc",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "6g8nnwm9cc",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "6g8nnwm9cc",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "6g8nnwm9cc",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "8h7pfz",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "8h7pfz",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "8h7pfz",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "8h7pfz",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "8h7pfz",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "h7b8kqg88e",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "h7b8kqg88e",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "h7b8kqg88e",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "h7b8kqg88e",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "h7b8kqg88e",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "ha7tj2",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "ha7tj2",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "ha7tj2",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "ha7tj2",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "ha7tj2",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "hewdniynr3",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "hewdniynr3",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "hewdniynr3",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "hewdniynr3",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "hewdniynr3",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "hyjfq2n04a",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "hyjfq2n04a",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "hyjfq2n04a",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "hyjfq2n04a",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "hyjfq2n04a",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "jm28gedjf5",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "jm28gedjf5",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "jm28gedjf5",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "jm28gedjf5",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "jm28gedjf5",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "ksuqvf7j5b",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "ksuqvf7j5b",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "ksuqvf7j5b",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "ksuqvf7j5b",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "ksuqvf7j5b",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "ntcqubwqvl",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "ntcqubwqvl",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "ntcqubwqvl",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "ntcqubwqvl",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "ntcqubwqvl",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "nu6ymuuhox",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "nu6ymuuhox",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "nu6ymuuhox",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "nu6ymuuhox",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "nu6ymuuhox",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "rpyg1v7i9q",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "stk0jl35jw",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "ysf55yjzku",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "z0lgt1mzb3",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "zigw1yqwrb",
      "usageDate": "2026-09-01T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-08-27T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-08-28T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-08-29T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-08-30T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-08-31T00:00:00.000Z"
    },
    {
      "workspaceId": "znvqc2gqxf",
      "usageDate": "2026-09-01T00:00:00.000Z"
    }
  ],
  "presentAccountDays": 10,
  "missingAccountDays": [
    "2026-08-27T00:00:00.000Z",
    "2026-08-28T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-30T00:00:00.000Z",
    "2026-08-31T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z"
  ],
  "ratio": 0.6666666666666666
}
```

The API response contains no native per-workspace rollup. The totals below are derived by summing `spendUsd` across every returned group row, including every synthetic `No group` row, grouped by `workspaceId`.

| workspaceId | workspaceName | spendUsd | returned group rows | synthetic No group rows |
|---|---|---:|---:|---:|
| ntcqubwqvl | Growth | 3040.03 | 13 | 1 |
| 1awqan | Comcast | 2220.11 | 25 | 1 |
| stk0jl35jw | Corporate Communications | 1410.10 | 6 | 0 |
| 6g8nnwm9cc | Strategic Development | 1087.51 | 7 | 1 |
| 66ox9cntlf | Comcast Business | 1061.17 | 7 | 1 |
| 8h7pfz | Finance-Community | 1021.24 | 3 | 0 |
| rpyg1v7i9q | TPX IT | 461.31 | 4 | 1 |
| 5b0iso4ru5 | Talent & Learning | 179.32 | 4 | 1 |
| hyjfq2n04a | Wireless | 153.05 | 4 | 1 |
| nu6ymuuhox | EBI | 112.40 | 7 | 1 |
| ysf55yjzku | Freewheel | 103.86 | 4 | 1 |
| h7b8kqg88e | Comcast Advertising | 40.19 | 3 | 0 |
| ha7tj2 | FTA | 27.45 | 2 | 1 |
| znvqc2gqxf | HR | 9.65 | 4 | 1 |
| zigw1yqwrb | Global Product | 0.63 | 1 | 1 |
| hewdniynr3 | NBCU | 0.36 | 3 | 0 |
| 5hkg15xcxd | Content Acquisition | 0.00 | 3 | 0 |

Derived workspace total: **$10928.37**. Application summary `totalSpendUsd`: **$10928.37**.

## 3. Live billing period, three sources

UTC comparison capture: 2026-09-04T07:59:25.171Z to 2026-09-04T07:59:25.206Z (application summary and stored query completed within 35 ms). Exactly one ungrouped Enterprise request was made; it returned HTTP 429 and was not retried.

| source | total USD | source status / metadata |
|---|---:|---|
| Application GET /api/summary?rangeType=billing | 12244.63 | usageHealth.status=partial; usageHealth.dataAsOf=2026-09-04T07:54:04.864Z; top-level usageDataAsOf=null |
| Enterprise GET /v1/usage?billingPeriod=current (no groupBy) | unavailable | HTTP 429; totalCostUsd unavailable; interval unavailable |
| Stored usage_workspace_day aggregate, usage_date >= 2026-08-19 | 12244.63 | MAX(fetched_at)=2026-09-04T07:59:06.261Z |

Observed discrepancy: the sole direct Enterprise response was rate-limited, so no upstream total or interval was available to compare. No retry, refresh, reconciliation, or corrective action was performed.

## 4. Growth workspace member spot check

Selected visible Growth group: `32m70Gl8` — AZ-Replit - Growth CXSO Account Mgmt - Member; workspace `ntcqubwqvl`. Members sorted descending by total spend from the custom-range group detail response.

| rank | userId | total spend USD | AI spend USD |
|---:|---|---:|---:|
| 1 | 60010472 | 180.75 | 180.22 |
| 2 | 61845037 | 4.03 | 4.03 |
| 3 | 61843046 | 3.35 | 3.35 |
| 4 | 52688095 | 0.79 | 0.00 |
| 5 | 58275869 | 0.69 | 0.00 |

Stored daily rows for top user `60010472` in workspace `ntcqubwqvl` over the same inclusive range:

| usage_date | total_cost_usd | ai_cost_usd |
|---|---:|---:|
| 2026-08-19T00:00:00.000Z | 45.53 | 45.53 |
| 2026-08-20T00:00:00.000Z | 21.22 | 21.22 |
| 2026-08-25T00:00:00.000Z | 17.41 | 17.41 |
| 2026-08-26T00:00:00.000Z | 21.06 | 21.06 |
| 2026-08-27T00:00:00.000Z | 49.67 | 49.67 |
| 2026-08-28T00:00:00.000Z | 49.76 | 49.76 |
| 2026-08-31T00:00:00.000Z | 244.08 | 244.08 |
| 2026-09-01T00:00:00.000Z | 44.29 | 44.29 |
| 2026-09-02T00:00:00.000Z | 12.17 | 12.17 |
| 2026-09-03T00:00:00.000Z | 13.15 | 13.15 |
| **Sum** | **518.34** | **518.34** |

Observed difference: group-detail total for the top member is $180.75 versus $518.34 across that member's stored workspace-day rows; AI spend is $180.22 versus $518.34. This was recorded without investigation or repair.

## 5. Ingest health

Ten latest runs at report collection time:

| id | kind | started_at | finished_at | units | calls | failures | error |
|---:|---|---|---|---:|---:|---:|---|
| 13 | reconcile | 2026-09-04T08:00:06.354Z | null | 0 | 0 | 0 | null |
| 12 | backfill | 2026-09-04T07:57:09.199Z | 2026-09-04T08:00:06.349Z | 168 | 351 | 0 | null |
| 11 | live | 2026-09-04T07:56:20.776Z | 2026-09-04T07:57:09.196Z | 63 | 129 | 0 | null |
| 10 | backfill | 2026-09-04T07:46:08.377Z | null | 0 | 0 | 0 | null |
| 9 | live | 2026-09-04T07:45:58.561Z | 2026-09-04T07:46:08.374Z | 63 | 128 | 0 | null |
| 8 | backfill | 2026-09-04T07:37:10.511Z | null | 0 | 0 | 0 | null |
| 7 | live | 2026-09-04T07:37:01.536Z | 2026-09-04T07:37:10.508Z | 63 | 128 | 0 | null |
| 6 | backfill | 2026-09-04T07:35:09.320Z | null | 0 | 0 | 0 | null |
| 5 | live | 2026-09-04T07:34:22.176Z | 2026-09-04T07:35:09.317Z | 63 | 130 | 0 | null |
| 4 | backfill | 2026-09-04T07:26:09.999Z | null | 0 | 0 | 0 | null |

Reconciliation deltas where `ABS(delta_usd) > 0.01`:

**Zero rows.**
