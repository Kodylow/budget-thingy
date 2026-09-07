# Threat Model

## Project Overview

Group Budget Monitor is a private Replit autoscale application for Comcast Enterprise administrators. An Express 5/TypeScript API uses Replit OIDC, PostgreSQL through Drizzle ORM, the Replit Enterprise API, and an email provider. A React/Vite frontend exposes dashboards, scoped usage detail, budget controls, alerts, and administrative settings.

## Assets

- **Enterprise identities and sessions** — Replit user IDs, OIDC claims, and bearer/cookie session IDs authorize sensitive account and workspace data.
- **Enterprise directory and usage data** — workspace membership, roles, groups, users, projects, spend, limits, and historical usage are confidential business data.
- **Privileged configuration** — budget pools, alert recipients, editor allowlists, team definitions, and threshold state affect account-wide operations.
- **Service credentials** — database, Replit Enterprise API, OIDC, and email-provider credentials grant backend authority and must remain server-side.

## Trust Boundaries

- **Browser/mobile client to API** — all request values, cookies, bearer tokens, object IDs, filters, and redirect values are untrusted. Authentication and authorization must be enforced by the API.
- **Role boundaries** — unauthenticated users, workspace admins, account editors, the designated delegate, and true account admins have different read/write scopes. Workspace authorization must be tied to each returned or mutated object.
- **API to PostgreSQL** — stored identity, authorization, usage, and settings data cross into a privileged datastore. Queries must remain parameterized and tenant/workspace scoped.
- **API to Replit Enterprise and email services** — outbound requests carry privileged credentials and may expose enterprise data. Destinations and message recipients must not be attacker-controlled beyond intended policy.
- **Private deployment boundary** — the deployed application is private, so Replit infrastructure is assumed to prevent public internet access; authenticated users remain potentially untrusted within their assigned role.

## Scan Anchors

- Entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/auth.ts`, `artifacts/api-server/src/routes/monitor.ts`.
- Authorization/session core: `artifacts/api-server/src/middlewares/requireAuth.ts`, `artifacts/api-server/src/lib/auth.ts`, `artifacts/api-server/src/lib/authz.ts`.
- High-risk integrations: `artifacts/api-server/src/lib/enterprise.ts`, `checker.ts`, `email.ts`, and Drizzle schemas under `lib/db/src/schema/`.
- The API router applies `requireAuth` globally after explicitly public auth/health routes; individual privileged operations require stronger role middleware and object-level scope checks.
- Tests and generated API clients are non-production analysis aids unless their behavior is reachable through the production server/client.

## Threat Categories

### Spoofing
OIDC state, nonce, PKCE, issuer/audience validation, and unpredictable session IDs must bind a login to the initiating client. Sessions must expire and privileged authorization must be re-resolved server-side rather than trusted from browser state.

### Tampering
Budget, team, recipient, editor, and alert operations must validate inputs and enforce the required role. Client-provided workspace/group/team/user IDs must never determine authorization scope by themselves.

### Information Disclosure
Every list, detail, export, history, trend, and directory response must be filtered to the caller's workspace scope. Service credentials, bearer sessions, cross-workspace usage, email addresses, and provider errors must not reach unauthorized clients or logs.

### Elevation of Privilege
Administrative and account-wide mutations must require the intended server-side role. Persisted editor and bootstrap grants must be bound to stable verified identities and revocation state. Database operations must be parameterized, and outbound URL/file/template sinks must not accept unsafe user input.

### Denial of Service
Expensive usage refreshes, exports, checks, and external API calls should only be available to authorized roles and must use bounded ranges, pagination, caching, coordination, and rate limiting appropriate to the private deployment.
