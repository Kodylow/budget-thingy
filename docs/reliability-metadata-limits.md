# Enterprise metadata and Limits reliability

## Guardrails

The Enterprise directory, billing-period and project-metadata read paths plus
the Limits workspace read model do not change accounting, perform upstream
writes, or add project AI to canonical member Agent attribution.

## Read contract

- Every directory, project, and budget page must include
  `pagination.hasMore`; continuation cursors cannot repeat. Required identity,
  membership, and amount fields are validated before publication. Failed
  validation leaves the prior durable directory in place.
- Project rows and completion state load in one bounded repeatable-read
  transaction. Last-success rows remain available, caches are replaced as a
  unit, and completeness expires after the project metadata TTL. Optional
  project titles do not block other totals.
- Current billing intervals must contain the observation time. Adoption requires
  two matching observations. Limits does not qualify current-cycle usage when
  only the fallback interval is available, and page reads make no provider call.
- Limits readiness uses only the requested workspace-day coverage. Missing or
  failed requested days produce unknown usage.
- A member row is usable only when its stored Agent decomposition is explicitly
  complete. An absent member row is authoritative zero only with complete
  workspace coverage.
- Explicit and effective limit values are null unless a successful limit
  generation exists. `no_limit` remains distinct from unavailable, and explicit
  zero remains zero.
- Team current-cycle Agent spend is qualified for the team's contributing
  workspaces and member Agent decompositions. Usage-derived fields are null
  when incomplete; known spend remains independent of an absent limit.
- Route accounting and alert checks share the same repeatable-read project
  metadata snapshot. Fresh complete metadata is required only where non-Agent
  project attribution contributes.

## Provider limitations

- Optional project titles and creator IDs can remain null because the provider does
  not guarantee enrichment. This does not qualify financial totals as incomplete.
- Failed or deferred project refreshes preserve the last successful rows, but those
  rows cease to advertise metadata completeness after the TTL.