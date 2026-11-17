# Money Tracker

Money Tracker is a production-oriented Next.js App Router application for team-scoped financial ledgers. It uses Auth.js with Google sign-in, Prisma ORM with PostgreSQL, and server-side authorization at every protected page and mutation boundary.

See the [functionality guide](docs/functionality-guide.md) for screens, roles, workflows, and product rules, and the [17 November usability results](docs/usability/2026-11-17-usability-results.md) for this iteration's implementation and verification. The [16 November remediation results](docs/remediation/2026-11-16-remediation-results.md) preserve the earlier audit-fix record.

## Major features

- Invitation-backed Google authentication with explicit identity states, session revocation, and recent-authentication checks for sensitive operations
- Team-scoped addition/removal ledgers with exact integer-cent arithmetic, database constraints, serializable writes, and replay-safe idempotency keys
- Independent global and team roles, atomic membership approval, cross-team isolation, and a bounded administration console
- Server-backed literal note search, direction/Dhaka date filters, matching aggregates, scoped cursor pagination, repeatable-read snapshots, and durable PostgreSQL rate limits
- Task-focused Teams and Administration views, an approved-team switcher, a retained transaction-entry panel, and copyable invitation access instructions
- Recoverable team quarantine with a 30-day retention window, append-only audit snapshots, and an offline, backup-gated permanent-purge command
- Security headers, health/readiness probes, redacted structured logs, correlation IDs, and fault-recovery boundaries

## Technology stack

| Layer | Technology |
| --- | --- |
| Web application | Next.js 16 App Router, React 19, TypeScript 5, Server Components, Server Actions |
| Authentication | Auth.js 5 with Google OAuth and hardened Prisma database sessions |
| Data | PostgreSQL 17, Prisma ORM 7, `@prisma/adapter-pg` |
| Validation/UI | Zod 4, React Hook Form, Tailwind CSS 4, Radix primitives |
| Verification | Vitest 4, disposable PostgreSQL integration suites, production route smoke tests, Knip, npm audit, and Gitleaks in CI |

## Architecture overview

`src/app` contains route segments, layouts, loading/error boundaries, and minimal Route Handlers. Client Components collect input and render explicit DTOs; they are never an authorization boundary. Server Actions in `src/actions` parse untrusted form data, enforce request limits, resolve the authenticated identity, and map expected domain failures to stable responses. Domain services and bounded queries in `src/lib` re-read authorization and lifecycle state beside the mutation/query they protect. Business persistence uses Prisma; readiness uses a separate bounded, read-only PostgreSQL connection. PostgreSQL constraints, indexes, transactions, and committed migrations provide the final integrity boundary.

The immutable `Transaction` table is the financial system of record. Audit rows intentionally retain snapshot identifiers and labels without cascading foreign keys. Proxy performs an early authentication redirect, but every protected page, action, and database service independently checks the exact actor and team resource.

## Requirements

- Node.js 22.22.2 (pinned in `engines` and CI)
- npm 11.11.0 (pinned in `engines`, `packageManager`, and CI)
- PostgreSQL 17 for supported development/CI parity (the enum compatibility migration requires PostgreSQL 10 or newer)
- A Google OAuth application

## Configuration

Copy `.env.example` to an ignored local `.env` file and provide the values through a managed secret store in production. Never commit or print those values.

| Name | Scope | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Development, migration jobs, runtime | PostgreSQL connection used by the application and release jobs |
| `TEST_DATABASE_URL` | Tests and CI only | Dedicated disposable PostgreSQL database; it must never identify the application database |
| `TEST_DATABASE_ALLOW_REMOTE` | Remote tests only | Set to `true` only for an independently disposable remote database or Neon branch |
| `TEST_DATABASE_CONFIRMATION` | Remote or specially named test databases only | Exact destructive-test acknowledgement required for every remote target and for a database name without a `test` segment |
| `E2E_BASE_URL` | E2E tests only | Loopback HTTP origin of the separately started production server; non-loopback origins are rejected |
| `AUTH_SECRET` | Development, tests, CI, production | Auth.js session and token secret |
| `AUTH_GOOGLE_ID` | Interactive development and production | Google OAuth client identifier |
| `AUTH_GOOGLE_SECRET` | Interactive development and production | Google OAuth client secret |
| `AUTH_URL` | Self-hosted production; optional locally; omit on Vercel | Exact canonical application origin; HTTPS is mandatory except for local loopback previews |
| `BOOTSTRAP_ADMIN_EMAIL` | Bootstrap job only | Normalized identity promoted by the explicit administrator bootstrap command |
| `RATE_LIMIT_HASH_SECRET` | Production; recommended locally | Dedicated secret, at least 16 characters, used to HMAC rate-limit subjects; falls back to `AUTH_SECRET` when absent |
| `TRUSTED_PROXY_MODE` | Production behind a recognized trusted proxy | `cloudflare`, `forwarded`, or `vercel`; use only when the immediate proxy overwrites forwarded headers |
| `OTEL_SERVICE_NAME` | Optional in every environment | Safe service label included in structured logs; defaults to `money-tracker` |
| `PURGE_*` | One permanent-purge job | Exact administrator/team/backup confirmations documented below |
| `INCIDENT_*` | One incident-response job | Exact administrator and global-session-revocation confirmation |

`prisma generate` does not require a live database URL. Migration, bootstrap, integration-test, and application runtime commands do.

Admission has no static environment allowlist. An active global administrator provisions normalized, expiring invitations in PostgreSQL through `/admin`; committing a list of authorized email addresses or domains would bypass that lifecycle and is unsupported. CI supplies only synthetic values inside its disposable runner. Production values belong in the deployment platform's managed secret store, not a build artifact, deployment environment definition, workflow file, cache, or repository setting visible to untrusted pull requests.

## Local setup

```bash
npm install
npm run db:generate
npm run db:migrate:dev
npm run db:bootstrap-admin
npm run dev
```

These commands connect directly to PostgreSQL through `DATABASE_URL`. `npm ci` remains the reproducible choice for CI and release builds.

The bootstrap is explicit and idempotent. It uses only `BOOTSTRAP_ADMIN_EMAIL`; it never promotes whichever account signs in first. Re-running it keeps the same configured identity as an administrator without creating duplicates. Change or remove that configuration after bootstrap according to your secret-management policy.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run db:generate` | Regenerate Prisma Client after schema or generator changes |
| `npm run db:migrate:dev` | Create/apply development migrations; never use in production (`db:migrate` is a compatibility alias) |
| `npm run db:migrate:deploy` | Apply committed migrations in a production release job |
| `npm run db:validate` | Validate the Prisma schema and generator configuration |
| `npm run db:test:migrate` | Safely apply committed migrations to the validated `TEST_DATABASE_URL` target |
| `npm run db:test:status` | Safely inspect migration status on the validated test target |
| `npm run db:test:prepare` | Generate Prisma Client and deploy migrations to the validated test target |
| `npm run db:bootstrap-admin` | Idempotently bootstrap the configured administrator |
| `npm run db:cleanup-rate-limits` | Delete only expired durable limiter buckets |
| `npm run db:purge-team` | Permanently purge one eligible quarantined team after retention and backup confirmation |
| `npm run db:revoke-all-sessions` | Deliberately revoke every application session during incident response |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run strict TypeScript checking |
| `npm run test:unit` | Run isolated unit tests |
| `npm run test:integration` | Run PostgreSQL integration/concurrency tests against a disposable database |
| `npm run test:authorization` | Run permission/state helpers and every Server Action guard suite |
| `npm run test:e2e` | Run HTTP role/lifecycle smoke plus the real Chromium UI workflow against a separately started local server |
| `npm run start:test` | Start the built application on `E2E_BASE_URL` using the validated test database |
| `npm run knip` | Report unused files, exports, and dependency declarations |
| `npm run audit` | Run both production-only and full dependency audits |
| `npm run ci` | Run the local schema, quality, test, build, runtime-verification, and audit chain; clean install, disposable service provisioning, history scan, and required E2E orchestration remain explicit workflow steps |
| `npm run build` | Build with Next.js 16's default Turbopack bundler |
| `npm run build:webpack` | Run the additional Webpack compatibility build |
| `npm run verify:proxy-manifest` | Assert the built Proxy covers dashboard, groups, and administration routes |
| `npm run runtime:prune` | Prepare static assets and remove Prisma CLI/tooling from the already-built standalone runtime artifact |
| `npm run runtime:verify` | Fail unless the final standalone artifact excludes Prisma CLI/tooling and retains required Prisma/database runtime packages |

The install lifecycle generates Prisma Client when development dependencies are installed. A production-only runtime install safely skips generation, so the deployable artifact must come from a completed build stage and include its generated client. Startup never regenerates Prisma Client.

## Prisma generation and migration workflow

Run `npm run db:generate` after every Prisma schema or generator change. `postinstall` and `prebuild` also run the guarded generation path, so a clean developer/CI install and every release build cannot silently use a stale client. Generation is not a substitute for a migration.

For a development schema change, point `DATABASE_URL` at a local disposable/development database, run `npm run db:migrate:dev -- --name descriptive_change`, inspect the generated SQL, regenerate the client, and run the unit plus PostgreSQL suites. Commit the schema and migration directory together. Never resolve a failed shared migration by resetting a database that contains data, editing an already-deployed migration, or using `db:push` as deployment automation.

For production, build and test first, prove the restore procedure with a recent backup, stop old writers for incompatible changes, capture a final quiesced restore point, and run `npm run db:migrate:deploy` once with the separately controlled release identity. Check `npx prisma migrate status` before starting the new application artifact. The runtime identity must not have migration privileges. Detailed deployment and recovery order appears below.

Migration `20260715150000_rename_moderator_enum_values` uses PostgreSQL 10+'s in-place `ALTER TYPE ... RENAME VALUE` for both role enums. It preserves enum/type OIDs, rows, and existing moderator permissions without a table rewrite. Quiesce old instances, back up, deploy the migration, then start only the corrected Prisma Client/application and verify global plus team moderator access before resuming traffic. Prefer forward recovery; if deployment is interrupted after the migration commits, starting the corrected release is safe once both enums are verified as `MODERATOR`. An application rollback requires stopped traffic and inverse enum renames before old code starts. Never retain both spellings or cast the columns through text.

## Direct test database setup

PostgreSQL tests connect directly through `TEST_DATABASE_URL`; they do not start a database service. Supported targets are a separate local database, a dedicated remote PostgreSQL test database, a disposable Neon database or branch, and the PostgreSQL service managed by GitHub Actions. Use a direct, non-pooling endpoint for migrations and the suite-level advisory lock. The test role must own the disposable test tables because controlled cleanup temporarily disables the append-only audit trigger inside a transaction.

The safety validator requires an explicit PostgreSQL database name, rejects administrative and production-, staging-, live-, main-, or primary-looking identities, and compares the canonical host, port, and database with `DATABASE_URL`. A matching application and test database is rejected even when credentials or schemas differ. A local database name must contain a distinct `test` or `testing` segment unless `TEST_DATABASE_CONFIRMATION` is set to the exact acknowledgement shown in `.env.example`.

Put the host, port, database, schema, and TLS mode directly in `TEST_DATABASE_URL`. Target-affecting libpq variables such as `PGHOST`, `PGPORT`, `PGDATABASE`, `PGOPTIONS`, `PGSERVICE`, and `PGSSLMODE` must be unset; the guard rejects them and the test launchers scrub them from child processes so inherited workstation state cannot retarget cleanup.

Remote targets are disabled by default. An independently disposable remote target additionally requires all of the following:

- `TEST_DATABASE_ALLOW_REMOTE=true`
- `TEST_DATABASE_CONFIRMATION=I_ACKNOWLEDGE_THIS_TEST_DATABASE_WILL_BE_CLEARED`
- `sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full` in `TEST_DATABASE_URL`
- A direct database endpoint and credentials used only for tests

No confirmation can allow a production-looking target. Destructive cleanup separately requires `NODE_ENV=test`, verifies `current_database()` after connecting, and holds a PostgreSQL advisory lease so two test processes cannot clean the same database concurrently. Vitest files and Playwright workers remain serialized. The harness deletes only application rows from the approved disposable database; it never drops a database, resets migration history, or runs `prisma migrate reset`.

Prepare and test the database through the guarded commands, which map only the validated test URL to Prisma's child process:

```bash
npm run db:test:prepare
npm run db:test:status
npm run test:integration
```

For production-server E2E verification, build first and use two terminals with the same ignored environment configuration:

```bash
# Terminal 1
E2E_BASE_URL=http://127.0.0.1:3000 npm run start:test

# Terminal 2
E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e
```

On PowerShell, set `$env:E2E_BASE_URL = 'http://127.0.0.1:3000'` before each command instead of using the inline assignment syntax. `start:test` validates the test target before launching the production server with that database as its application connection.

## Authorization boundary

The single Proxy entry point is `src/proxy.ts`, beside `src/app`, and optimistically redirects unauthenticated requests for `/dashboard`, `/groups`, and `/admin`. Proxy is not the authoritative security boundary. Protected pages, Server Actions, and data-access operations must continue to authenticate and authorize the exact resource independently.

After every framework or matcher change, inspect `.next/server/functions-config-manifest.json` and smoke-test all protected route families without a session.

## Authentication and reverse-proxy topology

Admission is database-backed: an administrator creates an expiring invitation, which preprovisions a normalized `PENDING` user. A successful Google sign-in activates that exact identity and consumes the invitation. Existing authorized users are migrated as active, so deployment does not lock them out. A Google hosted-domain hint is not an authorization boundary.

Supported host topologies are deliberately narrow:

- On Vercel, the platform-provided `VERCEL=1` signal enables managed dynamic-host behavior. Do not set that value manually on a self-hosted service.
- A production self-hosted deployment must set `AUTH_URL` to one canonical HTTPS origin. An HTTP origin is accepted only when its host is exactly `localhost`, `127.0.0.1`, or `[::1]` for a local production preview. The URL must contain no credentials, path, query string, or fragment. The reverse proxy must reject unrecognized hosts and overwrite, rather than append to or pass through, `Host`, `Forwarded`, and `X-Forwarded-Host` values.
- Local development and tests may omit `AUTH_URL` only for loopback hosts. If it is set locally, it becomes the exact allowed origin.

Keep Google OAuth callback URLs limited to the canonical application origin. Test sign-in, denial, callback, and sign-out flows through the same proxy/CDN configuration used in production; an off-domain `Host` or forwarded-host value must never influence a callback or redirect.

Database sessions have an absolute eight-hour deadline measured from immutable `Session.createdAt`. Adapter lookup and update reject and remove a session at that deadline, and rolling renewal cannot extend its stored or returned expiry. A still-valid legacy rolling expiry is normalized to that deadline before Auth.js consumes it, so stored and returned values agree even on its first renewal; an already expired rolling session is rejected and never revived. The catch-all authentication handler and Node.js Proxy also cap Auth.js renewal cookies at the same deadline (HTTP cookie dates have second precision). The fifteen-minute Auth.js update interval remains configured; unchanged capped expiries avoid redundant writes. Destructive operations require authentication within the previous fifteen minutes. A successful new Google sign-in deletes every older application session before Auth.js creates the replacement session, so a fresh sign-in on one device cannot grant recent-authentication status to an older or stolen session elsewhere. Disabling users, changing sensitive global roles, revoking memberships, or transferring ownership also revokes affected sessions. Provider access, refresh, and ID tokens are not retained because this application does not call Google APIs. Database session lookup values are one-way SHA-256 digests; the raw opaque token exists only in the secure, HttpOnly browser cookie.

## Global roles, team roles, and account states

Global and team roles are separate persisted decisions. An active global `ADMIN` may enter `/admin`, create or quarantine teams, provision invitations, and perform supported identity/team lifecycle operations. Global `MODERATOR` is not a substitute for global-administrator authority, and global `MEMBER` has no platform-wide management privilege. Demoting a global role does not silently rewrite team memberships or ownership.

On an approved team membership, team `ADMIN` and `MODERATOR` may add/remove ledger entries and approve pending membership requests. A team `MEMBER` has read-only access to that team's dashboard and history. Team ownership is an additional invariant: an owner cannot be disabled, deleted, or have the owning membership revoked until ownership is transferred to an eligible approved member. Every query and mutation combines the global account state, membership status, team lifecycle state, and exact resource identifier; a role label alone never grants cross-team access.

Identity status is independent of role. `PENDING` identities may complete only the invited admission path, `ACTIVE` identities may be authorized according to their roles/memberships, and `DISABLED` or `DELETED` identities are denied and have application sessions revoked. Memberships similarly distinguish `PENDING`, `APPROVED`, and `REVOKED`; a revoked membership cannot silently become a fresh request.

## Administrative access and offboarding

The global-admin-only `/admin` route is the supported control plane. Its Server Actions re-read the actor, target, team, membership, lifecycle status, and recent-authentication timestamp in the database; hiding a button or passing Proxy is never authoritative. The console uses bounded, explicit DTOs. Administrator email addresses appear only where they are operationally required, and internal user, OAuth, account, and session identifiers are not sent to Client Components.

Accounts, Invitations, Team access & ownership, and Team recovery have independent search/page state. Only the selected task's main collection is fetched. Sensitive controls require contextual confirmation; recent-authentication recovery accepts only a validated internal return location and never replays the original mutation. Invitation results expose the normalized identity, persisted expiry, and trusted canonical sign-in URL. Copyable instructions and their selectable fallback explicitly state that no email has been sent.

Administrators can provision or revoke a normalized email invitation, disable or re-enable an eligible user, promote or demote a global role, revoke a membership, transfer team ownership, and restore a quarantined team. Invitations expire, are single-use, and activate only the exact preprovisioned `PENDING` user after Google supplies a verified matching email. Reissuing an expired or revoked invitation updates that same record; the UI and Auth.js denial flow never reveal whether an arbitrary email is registered.

Disabling a user, changing a sensitive global role, revoking membership, or changing ownership deletes affected application sessions in the same database transaction as the authorization change. A team owner must transfer ownership before offboarding; global-role demotion alone does not alter team ownership or the separate team role. Revoked memberships remain `REVOKED` and cannot silently re-request access. All privileged transitions append a self-contained snapshot-based audit event with a correlation ID; audit rows have no user/team cascade and an unconditional database trigger rejects updates, deletes, and truncation.

## Financial integrity and idempotency

Money enters the application as a bounded string and must use digits with optional, correctly grouped thousands separators and no more than two fractional digits. It is converted exactly once to integer BDT cents. Floating-point values are never used for ledger arithmetic. The accepted per-transaction range is one cent through 2,147,483,647 cents (21,474,836.47 BDT), matching the signed PostgreSQL integer constraint; database checks independently reject zero, negative, and out-of-range values.

Normal application operations append ledger entries rather than editing/deleting financial history. Adds and removals run in serializable transactions after authorization is re-read. A removal locks/re-evaluates the team ledger and cannot commit when the resulting balance would be negative. Actor identifiers may become null during identity deletion, but immutable actor ID/name snapshots preserve required attribution and user deletion never cascades into transactions.

Each submission carries a normalized operation key with a unique `(teamId, idempotencyKey)` constraint. The server stores the normalized amount, type, date, and note represented by that key. A retry with the same key and identical payload returns the original committed transaction; reuse with a changed payload is a controlled conflict. The browser retains a key only while retrying the same payload, and a post-commit rendering/cache failure never invites a second financial insert. Idempotency complements serializable/database constraints; it does not replace them.

Add money and Remove money open one accessible entry panel. The existing root React provider keeps drafts and retry information in memory under an opaque actor/team scope across panel closure and SPA navigation, including team switching and Back/Forward. Unknown outcomes freeze the original details and offer unchanged-key retry, including after an unsuccessful retry. Explicit session-leave confirmation can discard this information; hard reload and document exit cannot restore it. No draft or operation key is stored in a URL, history state, persistent browser storage, or analytics. The dialog follows the visible viewport to keep its scroll area usable as a mobile viewport shrinks.

## Asia/Dhaka date policy

Transaction dates are business calendar dates, not browser instants. Input must be an exact, real `YYYY-MM-DD` Gregorian date, and future-date checks compare it with "today" in `Asia/Dhaka` regardless of the browser or server machine time zone. The date is stored as UTC midnight solely as a stable date-only representation and is formatted from UTC date parts, preventing a client-zone conversion from shifting it to the previous/next day. Operational timestamps such as creation and audit times remain true instants and are formatted in `Asia/Dhaka` when shown as business time.

## Team quarantine, restore, and permanent purge

A browser delete request never deletes a ledger. A recently authenticated global administrator must type the exact team name; the server then sets `deletedAt`, a 30-day `purgeAfter`, and an audit event atomically. Normal group, dashboard, history, approval, and transaction queries exclude quarantined teams. Transactions and memberships remain unchanged, and restoration inside the retention window restores the same ownership, membership roles, approvals, and ledger.

Permanent purge is deliberately unavailable through the browser. After the retention deadline, take and verify a restorable backup, then supply these one-operation values through the privileged job environment:

- `PURGE_ADMIN_EMAIL`
- `PURGE_TEAM_ID`
- `PURGE_TEAM_NAME`
- `PURGE_BACKUP_REFERENCE`
- `PURGE_CONFIRMATION=PERMANENTLY PURGE TEAM`

Run `npm run db:purge-team` from the fully installed release. It rechecks active global-admin authority, exact team name, quarantine state, retention deadline, and backup reference in one serializable transaction. The team cascade occurs only after an independent `TEAM_PERMANENTLY_PURGED` audit row is inserted; that audit survives the purge. Never schedule this command broadly or use it as routine deployment cleanup.

## Bounded queries and ledger reconciliation

The initial dashboard returns at most 25 matching transaction DTOs. History uses an authorized cursor ordered by transaction date, creation time, and unique transaction ID; incremental requests have a hard server maximum of 50. Signed history cursors bind the actor, team, normalized filters and snapshot revision using the existing `AUTH_SECRET` with a separate versioned purpose. Teams tasks and switcher options use independent 20-row pages. Administration uses 25-row user/invitation pages, 20-row team pages, and 25-row per-team membership pages. Every page uses a stable unique final ordering key, authorizes its cursor inside the current viewer/filter scope, reads one sentinel row, and shows a next-page or final-page state in the UI.

One validated filter contract supplies literal, case-insensitive note search (up to 120 trimmed characters), direction, and Asia/Dhaka month/custom date ranges. The same parameterized predicate supplies matching history and added/removed/net/count aggregates across all matching entries. `%`, `_`, and backslash are literal search characters. Matching totals are labeled separately from the whole team's all-time balance. Only direction, period and custom bounds enter safe navigation URLs; note search remains POST data and React memory. Searches require explicit submission. Existing indexes were reviewed against synthetic PostgreSQL plans; no index migration was added.

Dashboard history follows an explicit snapshot policy. Opaque viewer/team scope isolates financial drafts; normalized filters and coherent aggregates identify the history generation. Successful reads replace a complete server snapshot containing all-time figures, matching totals and the first page. Confirmed writes refresh the applied search/filter view, reset loaded history when its revision changes, and explain saved entries outside the filter or first page. Incremental reads validate the revision in their repeatable-read transaction; an external write triggers a controlled refresh. Late responses cannot enter a retired generation. No database transaction is held across browser requests and no optimistic balance is computed from displayed rows.

There is intentionally no mutable cached balance to drift. The immutable `Transaction` ledger remains the only financial source of truth. Dashboard totals are database aggregates read in the same repeatable-read snapshot as the first history page, and a write computes the prospective balance from that ledger inside its serializable transaction before inserting. The `(teamId,type)` and stable-history indexes support those aggregates and pages. Operational reconciliation therefore recomputes additions, removals, and balance from the ledger and compares them only with rendered/reported values; it never edits transaction rows. If a future release introduces a stored balance, update it in the same transaction as the immutable row and add a repair/report job plus drift-injection tests before deployment.

## Durable rate limiting

Rate limits use atomic PostgreSQL fixed-window buckets. Subject values are stored only as HMAC-SHA256 hashes of their kind and value; raw user IDs and client IP addresses are not retained in limiter rows. Use a dedicated random `RATE_LIMIT_HASH_SECRET` in production so limiter-key rotation is independent from session-secret rotation.

The current limits cover transaction creation (60 per minute per user), transaction history (90 per minute per user, including initial and incremental reads), team enumeration (45 per minute per user), and administration collection reads (30 per minute per user). Membership, authentication, destructive, and privileged administration entry points use their own narrower scopes. Exceeded requests return a controlled retry interval without revealing resource existence.

Google sign-in initiation shares one 20-starts-per-five-minute IP quota between the UI Server Action and direct `POST /api/auth/signin/google` requests. The installed Auth.js server action calls its core directly, so the UI path consumes this quota once; callbacks and CSRF-token reads do not count as starts. Direct requests retain Auth.js CSRF validation and host checks, return `429` with `Retry-After` over quota, and return `503` when trusted client-IP resolution or the limiter is unavailable.

The limiter fails closed when its configuration or durable store is unavailable. Financial writes check the limiter before beginning the ledger transaction, so a limiter failure cannot occur after or partially corrupt a committed money write. Reads also fail closed with a stable response. Alert on limiter-unavailable errors and restore the dependency; do not silently switch to per-process memory in a multi-instance deployment.

Forwarded client-IP headers are ignored by default. Vercel's platform signal selects its normalized forwarded address automatically. For other deployments, configure `TRUSTED_PROXY_MODE` only when the named immediate proxy is controlled and strips/replaces inbound forwarding headers. `cloudflare` trusts its canonical connecting-IP header, while `forwarded` and `vercel` use the first normalized `X-Forwarded-For` hop supplied by that trusted proxy. A production preview with an exact loopback `AUTH_URL` uses one shared loopback limiter bucket. Every other production topology without a trusted peer address remains unavailable rather than attributing an attacker-selected header.

Schedule `npm run db:cleanup-rate-limits` as a privileged daily maintenance job and alert on a nonzero exit. It deletes only limiter buckets whose indexed `expiresAt` is in the past and never prints subject hashes or secret configuration.

## Browser security policy

`next.config.ts` applies the following headers to public, authenticated, HTML, and API routes and disables `X-Powered-By`:

- `Content-Security-Policy-Report-Only` with explicit `frame-ancestors`, `object-src`, `base-uri`, and `form-action` restrictions
- `X-Frame-Options: DENY` so clickjacking protection is enforced while CSP is report-only
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- a minimal `Permissions-Policy`

The policy accounts for self-hosted Next.js fonts and assets, the Google account-image origin, same-origin Auth.js endpoints, and the Google OAuth form origin. Development alone permits `unsafe-eval` and WebSocket connections for React diagnostics and hot reload. The nonce-free Next.js compatibility policy currently permits inline scripts and styles; those allowances are transitional and are documented in `src/lib/security-headers.ts` rather than being copied among routes.

CSP is intentionally report-only for this release. Before changing the header to enforcing mode:

1. Collect and review violation reports in staging and production through the edge/CDN or an approved CSP reporting service; do not build a public unauthenticated report sink without abuse controls.
2. Exercise public pages, authenticated navigation, Server Actions, sign-in, OAuth callbacks, sign-out, optimized fonts/assets, and both production bundlers.
3. Move to per-request nonces with dynamic rendering, or a separately validated hash/SRI strategy, before removing the required inline compatibility allowances.
4. Confirm zero required-resource violations, then enforce gradually with rollback monitoring.

HSTS is emitted only when `NODE_ENV=production` and the deployment is known to be HTTPS: Vercel, or a self-hosted service with an HTTPS `AUTH_URL`. Local development and HTTP self-hosting never receive HSTS. The initial policy uses a one-year max age without `includeSubDomains` or `preload`; add those only after every affected subdomain is permanently HTTPS-capable.

## Observability and health probes

Server events are newline-delimited JSON with a timestamp, level, stable category, event name, service name, runtime, and correlation ID. The centralized serializer redacts authorization/cookie/token fields, database URLs, email addresses, application identifiers, financial values, and personal transaction notes. Unexpected exceptions record only a safe error name/code/digest, never the message, stack, SQL, request headers, or raw path parameters.

Server Actions can call `reportUnexpectedError` and return its stable generic message and correlation reference. Next.js server-render, Route Handler, Server Action, and Proxy exceptions flow through `src/instrumentation.ts`'s `onRequestError` hook. Production should ship stdout/stderr JSON to a restricted log platform and extend that hook with an approved error/trace provider. Keep provider credentials in the managed secret store, restrict log access, define retention, and alert on `unexpected`, `dependency_unavailable`, authentication-denial spikes, and limiter-unavailable categories. Never attach broad request objects or Prisma records to monitoring events.

The deployment exposes two deliberately minimal, uncached probes:

- `GET /api/health` is liveness only. It returns `{ "status": "ok" }` and does not contact PostgreSQL.
- `GET /api/ready` performs a bounded database connectivity check. It returns only `{ "status": "ready" }` or a generic `503 { "status": "unavailable" }`. Concurrent callers share one isolated connection per process: connection acquisition is bounded to 500 ms, the probe statement to 1,000 ms through a transaction-local timeout, and stalled I/O/cleanup to a 2,000 ms owned-socket deadline. The slot is held until cleanup completes. Business-query settings and the Prisma pool are unchanged.

Both responses include an `X-Correlation-ID` and expose no database host, schema, migration, table, or credential details. Configure the orchestrator to use readiness to remove an instance from traffic and liveness only to detect a stuck process; a temporary database outage must not trigger a restart storm. Restrict readiness at the ingress when practical, even though its public body is intentionally non-sensitive.

## Database, backup, and token incident controls

Application code minimizes retained bearer material, but infrastructure must provide the remaining controls. Require TLS with certificate verification between the application and PostgreSQL; encrypt database volumes, snapshots, replicas, exports, and off-site backups with managed keys; restrict and audit key access; define retention; and regularly prove restore integrity in an isolated environment. Do not place database URLs, raw session cookies, provider credentials, or backup encryption keys in logs or support tickets.

Use separate least-privilege database identities:

- The runtime identity needs only the application tables/sequences and must not own the database, create extensions, alter schema, bypass row security, or access unrelated databases.
- The release/migration identity is short-lived, separately audited, and available only to the deployment job.
- Backup, restore, monitoring, and disposable-test identities are separate from runtime and from one another.

In particular, the runtime role may `SELECT` and `INSERT` `AuditEvent` rows but must have `UPDATE`, `DELETE`, and `TRUNCATE` revoked. It must not own that table and must not have permission to disable triggers. The migration's trigger has no application-settable maintenance flag. Exceptional audit-retention work therefore requires the separately controlled owner/release identity, a reviewed transaction that explicitly disables and restores the trigger, and independent database/IAM logging. Do not grant the runtime role membership in that owner role.

If a session or token compromise is suspected:

1. Contain access, preserve structured logs/audit history, and record an incident correlation/timeline without copying secrets.
2. For an individual, disable the user through `/admin`; this revokes their sessions. For a global event, set `INCIDENT_ADMIN_EMAIL` and `INCIDENT_CONFIRMATION=REVOKE ALL APPLICATION SESSIONS`, then run `npm run db:revoke-all-sessions` from the privileged release environment.
3. Rotate `AUTH_SECRET`, `RATE_LIMIT_HASH_SECRET`, Google OAuth client secret, database credentials, and affected infrastructure keys according to what was exposed. Updating the limiter secret starts new logical buckets; plan that availability effect.
4. Revoke the OAuth client or upstream Google sessions in Google administration when provider credentials or accounts are involved. This application cannot revoke provider access tokens from its database because it intentionally does not retain them.
5. Review append-only application audit events, restricted database audit logs, Google provider logs, proxy logs, and backup access logs. Notify affected parties under the applicable incident policy.
6. Redeploy, require reauthentication, verify disabled identities remain denied, and rotate/replace any backup or artifact that contained compromised material.

The session-token SHA-256 mapping is part of the Auth.js adapter contract and is tested for create, lookup, update, and delete. Do not replace it with custom encryption or another lookup transform without a compatible migration and full authenticated smoke tests.

## Restricting a local `.env` on Windows

The repository ignores `.env`; `.env.example` contains names only. Never commit real values, and use a managed secret store plus a least-privilege service identity in production.

On a shared Windows workstation, open PowerShell in the verified repository root, close processes using `.env`, and run the checked-in hardening script deliberately:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\harden-env-acl.ps1
```

The command prompts before changing anything. The script fails if `.env` is missing, never reads or prints its contents, preserves the file's current owner, removes inherited access, and replaces all access rules with Full Control for that owner, built-in Administrators, and SYSTEM. Its verification output contains principal names and permission types only. Do not run it if a service account also requires direct file access. Confirm the application still starts, then rotate secrets if the prior ACL allowed unintended readers; Administrators or SYSTEM can repair an incorrect ACL.

## Dependency security note

Next.js and `eslint-config-next` are paired at `16.4.6`. Auth.js `5.0.0-beta.32`, its Prisma adapter, Prisma `7.10.1`, Zod `4.6.7`, and Vitest `4.1.12` resolve the applicable audit findings with refreshed compatible transitive packages. The old Next PostCSS and Prisma development-tool overrides are removed because the updated packages provide patched dependencies.

One narrow development-only override remains: `@typescript-eslint/typescript-estree` uses `minimatch@11.0.8` instead of its vulnerable 10.x requirement. The parser uses the named `minimatch` matching API, which was checked along with typed TypeScript project parsing and the full lint path on the pinned Node version. Remove the override when upstream accepts a patched version and both audits plus parser/lint checks remain green. This is a patched dependency substitution, not an accepted vulnerability exception.

Re-run both audit graphs when changing the lockfile. The npm production graph can include peer tooling that is excluded from the verified standalone runtime; inspect the final artifact separately. Never use `npm audit fix --force` or downgrade the Prisma architecture to silence a security result.

## Verification and CI order

Configure one of the dedicated test targets described above. Never point `TEST_DATABASE_URL` at a development, shared, staging, or production database. The complete local order is:

```bash
npm ci
npm run db:generate
npm run db:test:prepare
npm run db:validate
npm run db:test:status
npm run lint
npm run typecheck
npm test
npm run test:unit
npm run test:integration
npm run test:authorization
npm run knip
npm run build:webpack
npm run verify:proxy-manifest
npm run build
npm run verify:proxy-manifest
npm run runtime:verify
npm run audit
# Start the built server, then set E2E_BASE_URL to its loopback origin:
npm run test:e2e
```

The checked-in `.github/workflows/ci.yml` performs these as separately named failure points with exact Node/npm versions and an isolated PostgreSQL 17 service managed by GitHub Actions. That service is CI-only and requires no local workstation or production-VPS service runtime. The workflow caches only npm's content-addressed download cache—never `node_modules`, `.next`, generated clients, or environment files—and injects non-secret runner-only values without a database password. It scans committed history with the pinned native Gitleaks CLI after verifying the official release checksum. Chromium installation and the production-server E2E suite are mandatory steps. The server is started from the pruned standalone artifact, so the E2E stage also proves the final runtime starts successfully. Configure the `CI / quality` check as required in GitHub branch protection; repository files cannot change that setting.

Start the built application against the disposable database before `test:e2e`, install the pinned Chromium build with `npx playwright install chromium`, and set `E2E_BASE_URL` to its loopback HTTP origin. Vitest sends real HTTP requests to the production server for public pages, every protected page family, the full authenticated role matrix, disabled-session rejection, the minimized public session DTO, response headers, and both health probes. The Playwright suite uses synthetic database sessions but submits the actual browser forms and Next Server Action transport for team creation, membership request/approval, duplicate-safe additions, removal, pagination, quarantine/restore, and disabled-user rejection. Real Google OAuth remains a post-deployment smoke because CI has no provider identity or callback authority. Run `npm run verify:proxy-manifest` after each matcher/framework change; Next.js 16 records the Node.js Proxy matcher in `.next/server/functions-config-manifest.json`. A successful Webpack fallback does not replace a successful default Turbopack build.

For canonical local E2E, supply a validated `TEST_DATABASE_URL`, synthetic authentication secrets/provider settings, and `E2E_BASE_URL=http://127.0.0.1:3000`, then run `npm run start:test -- --standalone` after building, pruning, and verifying the artifact. The launcher defaults to the exact loopback base URL as `AUTH_URL`; it never reads a normal application database into the test server. Omit `--standalone` to retain the existing `next start` launcher. Run `npm run test:e2e` in another shell with the same test settings. To exercise CI's managed topology, start the launcher and run the tests with explicit `VERCEL=1` and an HTTPS synthetic `AUTH_URL`, as in CI. Qualify both topologies separately.

The browser-only loopback proxy forwards its upstream canonical host and maps only its own browser Origin/Referer to that origin. Redirects from the configured upstream or explicit managed application identity, including Server Action redirect headers, return through this local transport; unrelated origins and ports remain unchanged. Foreign request origins remain unchanged for CSRF rejection. Synthetic session headers are consumed only by this test helper and never reach application code. HTTP tests independently reject an unexpected real request Host in canonical mode and assert the explicit dynamic-host behavior in managed mode.

Dependabot checks npm packages weekly and GitHub Actions monthly. Review and merge those pull requests only after the full pipeline succeeds; security updates do not bypass migration, authorization, build, or audit checks. Knip is intentionally run against source-controlled application and test entry points. Next.js route discovery and generated `.next`/Prisma output are handled by Knip's framework integration or ignored build artifacts, not broad source exclusions; any future exception must include a narrow explanation beside its configuration.

## Production deployment

Use a build/release stage that installs development dependencies. `npm run build` generates Prisma Client first, creates Next.js's traced `.next/standalone` deployment, copies the required static assets, removes copied `.env*` files and any traced `node_modules/prisma` or `node_modules/@prisma/dev`, and verifies that Prisma Client, the PostgreSQL adapter, and database runtime remain. The build fails if runtime verification fails. Private source environment files are left untouched; runtime settings must be injected by the deployment platform. Re-run the assertion explicitly before publishing:

```bash
npm run runtime:verify
```

Deploy `.next/standalone` rather than copying the full root `node_modules`. Do not use `--omit=optional`: Next.js distributes native runtime bindings as optional platform dependencies. Migration and bootstrap jobs run from the fully installed release stage, not from the traced runtime artifact.

A direct VPS release uses ordinary npm processes. Build before the maintenance window, then stop writers and verify the backup before applying migrations:

```bash
npm ci
npm run db:generate
npm run build

# Stop the running application and writers; verify the quiesced backup.
npm run db:migrate:deploy

# Fresh database only:
npm run db:bootstrap-admin

node .next/standalone/server.js
```

If PM2 is already installed and managed on the VPS, it can supervise the final command instead:

```bash
pm2 start .next/standalone/server.js --name "money-tracker"
pm2 save
```

1. Build and test the exact release artifact with `npm ci` and the complete workflow sequence above.
2. Prove the restore procedure in an isolated environment using a recent backup, and confirm continuous PITR/WAL coverage through the planned writer-stop point.
3. Stop application instances and transaction writers for the migration maintenance window. The old and new releases are not mutually compatible with the required ledger columns, session-token digest lookup, or corrected persisted moderator label; do not leave an old instance serving after those migrations commit.
4. Capture and verify a final quiesced backup or restore point, record its exact cutoff, and retain the matching previous application artifact.
5. Run `npm run db:migrate:deploy` once from the release job. Never run `prisma migrate dev` or `prisma db push` in production.
6. Verify migration state, transaction/team row counts, per-team balance invariants, lifecycle status counts, both role enums' `MODERATOR` value, session counts/expiry bounds, and audit append-only behavior without selecting personal, financial, OAuth, or session-token values.
7. On a fresh database, run `npm run db:bootstrap-admin` explicitly from the fully installed release job before administrator smoke tests or public traffic are enabled.
8. Deploy the already-built application artifact and production dependencies while writers remain disabled.
9. Smoke-test invited and existing-user authentication, denial, Host rejection, session lookup, Proxy redirects, authorization, idempotent writes, quarantine/restore, headers, and probes; only then re-enable writers and traffic.

### Rollback and recovery

Prefer forward recovery. The financial-integrity migration preserves amounts and attribution, makes transaction actors nullable with `ON DELETE SET NULL`, restricts team-owner deletion, and adds required idempotency/snapshot columns. Do not restore the old cascading foreign keys.

- Before writes resume, a failed migration or deployment can be recovered by restoring the verified backup and the previous application release.
- After the migration succeeds, do not deploy the old writer against the new schema. Fix forward, or restore the database and application together while writers remain stopped.
- The security migration one-way hashes existing session lookup values and caps legacy expiry at eight hours. Rolling back only the application to a raw-token adapter invalidates session lookup; prefer forward recovery or revoke sessions deliberately.
- Rolling back across the moderator compatibility migration requires stopped traffic and inverse in-place enum renames before the old application starts. Never run old and corrected role writers concurrently.
- After an actor is hard-deleted, the live foreign-key value cannot be reconstructed from the user table. Keep the immutable attribution snapshot and safer relation.
- If verification finds a count or balance mismatch, keep writes disabled, retain logs and the backup, and investigate rather than editing ledger rows manually.

The committed migration contains its own deployment-order, fail-closed precondition, and recovery comments.

## Windows SWC repair

Windows x64 is supported by Turbopack and should load `@next/swc-win32-x64-msvc`. If Next.js reports an invalid Win32 application, treat it as a corrupt installation rather than changing the permanent build script to Webpack.

From the repository root, close running development servers and verify the architecture:

```powershell
node -p "process.platform + '/' + process.arch"
npx next info
```

For a `win32/x64` Node process on 64-bit Windows, repair dependencies from the committed lockfile:

```powershell
npm ci
node -e "require('@next/swc-win32-x64-msvc'); console.log('Native SWC loaded')"
npm run build
npm run build:webpack
```

`npm ci` performs the clean `node_modules` replacement. If it cannot remove a locked file, stop the process holding that file and retry from the verified project root; do not delete an unverified computed path. Keep a Linux CI build as the independent deployment-platform check.
