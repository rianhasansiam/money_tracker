# Money Tracker remediation results

16 November 2026, Asia/Dhaka. Base commit: `cdc7a911f49a72c975bc0f1ae6cc1b3a86dda451`. Changes are in the working tree and have not been committed or deployed.

All nine audit remediations are implemented and locally verified. Every listed local gate passed, including both authentication topologies and both bundlers. The historical [audit](../audits/2026-11-16-project-audit.md), [plan](../audits/2026-11-16-remediation-plan.md), and [verification record](../audits/2026-11-16-verification.md) remain unchanged. Production release qualification still requires the deployment checks listed at the end of this document.

## Finding status

| Finding | Status | Implementation and regression evidence |
| --- | --- | --- |
| AUD-001 | Resolved locally | Next.js and its ESLint configuration are paired at 16.4.6; Auth.js beta.32/core 0.41.3, Prisma 7.10.1, Zod 4.6.7 and Vitest 4.1.12 replace affected versions. Both dependency graphs report zero vulnerabilities. Both bundlers and runtime checks pass. See [dependency evidence](dependency-verification.json). |
| AUD-002 | Resolved locally | Stable actor/team scope and ledger revision identify the authoritative first page. Confirmed writes reset loaded history; stale responses cannot append into another generation. Incremental reads reject a changed server revision and refresh. Nine real browser regressions cover first save, pagination, backdating, failures/retries, external writes, races, team switches and keyboard focus. |
| AUD-003 | Resolved locally | The adapter anchors expiry to immutable creation time, rejects at or beyond eight hours, deletes invalid sessions and normalizes valid legacy expiry. Request-local handling caps actual API and Proxy renewal cookies. Unit, PostgreSQL and HTTP checks cover renewal, exact boundaries, nine-hour-old sessions, legacy shorter expiry and non-revival of expired rows. |
| AUD-004 | Resolved locally | One shared authentication-start policy protects the UI action and direct Google HTTP initiation. The invocation chain charges the UI once and excludes callbacks. A real CSRF-equipped HTTP client receives 20 Google redirects and a 429 on request 21; the UI creates one bucket increment. Unavailable limiter/client-IP behavior has focused fail-closed regressions. |
| AUD-005 | Resolved locally | Native dialog top-layer behavior replaces the containing-block overlay. Explicit Tab wrapping, background scroll lock, focus restoration/fallback during pending work, bounded content scrolling and synchronous submission guarding are implemented. Real mobile/desktop browser checks cover cancellation, failure, retained confirmation and one request under duplicate interaction. Copy distinguishes recoverable quarantine from permanent purge. |
| AUD-006 | Resolved locally | The financial service clones the parsed date and normalizes its UTC hours without changing its year. PostgreSQL round trips and idempotent replay preserve 0001, 0099, 0100 and an ordinary leap-day date. The accepted date range and Asia/Dhaka policy are unchanged. |
| AUD-007 | Resolved locally | Readiness coalesces callers onto one isolated PostgreSQL connection per process. Acquisition is bounded to 500 ms, the transaction-local statement to 1,000 ms, and stalled I/O/cleanup to 2,000 ms. Real PG17 tests verify cancellation, released backends, repeated bounded probes, available business queries and restored settings. |
| AUD-008 | Resolved locally | Formatting uses exact integer quotient/remainder and locale parts. The maximum supported aggregate retains `.91`, including negative and signed representations. Zero, ordinary amounts, negative zero, range boundaries and overflow rejection are tested. |
| AUD-009 | Resolved locally | The guarded launcher supports the pruned standalone artifact. The loopback-only browser proxy forwards canonical authority and its own Origin/Referer, preserves foreign origins, and handles NextURL's known localhost normalization at the configured port. Canonical HTTP rejects an unexpected real Host. Canonical and explicit managed topology are exercised separately. |

No dependency vulnerability exceptions await acceptance. The retained development-only override substitutes patched `minimatch@11.0.8` under `@typescript-eslint/typescript-estree`; it does not suppress an audit result. Its matching API, typed TypeScript project parsing and the full lint path were exercised. Remove the override when upstream accepts a patched dependency and those checks remain green.

## Architecture and behavior

Financial writes, authorization and lifecycle rules remain in the existing Server Action/service/data-access boundaries. Pages continue to read on the server; client state owns interaction and pagination only. The existing integer-cent storage, idempotency constraint, concurrent-withdrawal protection, cross-team membership checks, token hashing, invitation admission, recent authentication, revocation, append-only audit and quarantine retention remain in place. No Prisma schema or applied migration changed.

**Dashboard snapshots:** an opaque hash scopes state to the authenticated actor and team. A deterministic revision includes separate authoritative added/removed totals and the ordered first page/cursor. A confirmed mutation resets history to that first page and announces the reset; a backdated entry outside the page receives an explicit explanation. Incremental reads compare the expected revision inside their repeatable-read transaction before appending a page. This adds aggregate/first-page validation to each incremental read and avoids a database transaction held across browser requests. There are no ledger filters in the current product; existing server-side administration search remains unchanged.

**Sessions:** creation time is written by the adapter, not accepted from an update. Lookup/update reject elapsed absolute or rolling expiry before any legacy normalization. Updates whitelist the token and capped expiry. Auth.js constructs renewal cookies independently, so a Node request-local context carries the verified deadline through the catch-all handler and Proxy response. It has no global token cache. Actual cookie expiry is checked at HTTP precision; public expiry and storage retain their timestamp precision.

**OAuth:** the UI's server `signIn` path calls Auth.js core directly, while the HTTP catch-all is independently reachable. Both invoke the shared policy at their own boundary, once per attempt. No client bypass flag is used. The test proxy and synthetic session transport are absent from application imports.

**Readiness:** the probe does not use the Prisma business pool. A short read-only transaction pins its backend and applies `statement_timeout` locally; rollback prevents settings leaking through transaction poolers. An owned socket bounds stalled setup and cleanup. Concurrent callers share the same pending result until cleanup finishes. Liveness remains independent of PostgreSQL. Actual pooler/TLS deployment operation has not been exercised locally.

## Interface changes

The existing routes now share a slate/white/teal light theme, restrained borders and radii, the existing fonts/icons, and role-aware workspace navigation. Reusable buttons, labels, badges, feedback, empty states, headers and confirmation behavior support the current screens. Financial figures use tabular numerals, full currency/sign information and text/icon direction labels.

The dashboard emphasizes the authoritative balance and existing all-time added/removed totals. Desktop history is a semantic table; mobile history uses readable cards. The entry form has persistent labels, inline validation, explicit pending state, preserved failed/uncertain input and server-confirmed feedback. Pagination preserves keyboard focus and scroll position; its final page has a focusable completion message. Group summaries state their page scope and stay compact on mobile. Administration explains ownership blockers and offers server-side search/no-results states.

Verification also corrected three issues exposed by the upgrade/UI work: all five error boundaries now use the installed framework's stable `retry` callback; long administration labels wrap at small widths; and shared buttons enforce a 44 CSS pixel minimum height even when a flex column would otherwise collapse an anchor. An actual cancelled read exercises loading, recovery and successful retry without changing ledger rows.

### Screenshots

Synthetic data only. Before images are full-page captures; comparison images use a 900-pixel viewport. Stress cases and native zoom are captured separately. The evidence contains 29 PNGs: eight before, eight comparison, and thirteen stress/state captures.

| Screen | Before | After |
| --- | --- | --- |
| Desktop dashboard | [Before](screenshots/before/dashboard-1440.png) | [After](screenshots/after/comparison/dashboard-1440.png) |
| Mobile groups | [Before](screenshots/before/groups-390.png) | [After](screenshots/after/comparison/groups-390.png) |
| Mobile sign-in | [Before](screenshots/before/login-390.png) | [After](screenshots/after/comparison/login-390.png) |
| Mobile administration | [Before](screenshots/before/admin-390.png) | [After](screenshots/after/comparison/admin-390.png) |

Additional evidence: [native 200% zoom](screenshots/after/dashboard-1440-native-200-percent.png), [mobile confirmation](screenshots/after/quarantine-dialog-320.png), [loading](screenshots/after/dashboard-loading-390.png), [recovery](screenshots/after/dashboard-recovery-390.png), and the [responsive measurements](screenshots/after/responsive-matrix.json). Screenshots were visually inspected, alongside automated layout/label/contrast/focus assertions.

## Verification

Local environment: macOS arm64, Node.js 22.22.2, npm 11.11.0, PostgreSQL 17.12, Playwright 1.61.1/Chromium revision 1228. PostgreSQL was newly provisioned in a separate temporary cluster, with guarded test target `money_tracker_remediation_test`. No application database was used. The temporary application server and PostgreSQL cluster were stopped after verification.

| Required gate | Final outcome |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed; automatic Prisma generation succeeded |
| `npm run db:validate` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit` | Passed: 33 files, 293 tests |
| `npm run test:integration` | Passed: 5 files, 56 tests on PostgreSQL 17.12 |
| `npm run test:authorization` | Passed: 5 files, 58 tests; overlaps unit coverage |
| `npm run knip` | Passed |
| `npm run build` | Passed: default Turbopack build, automatic prune/runtime verification, standalone startup smoke |
| `npm run verify:proxy-manifest` after default build | Passed: dashboard, groups and administration |
| `npm run build:webpack` | Passed |
| `npm run verify:proxy-manifest` after Webpack | Passed: all three protected families |
| `npm run runtime:prune` and `npm run runtime:verify` | Passed: private environment copies and Prisma CLI/dev tooling absent; runtime dependencies retained |
| `npm run test:e2e`, canonical local configuration | Passed: 3 HTTP files / 14 tests, plus 15 browser workflows (25.2 seconds) |
| `npm run test:e2e`, explicit managed configuration | Passed: 3 HTTP files / 14 tests, plus 15 browser workflows (36.9 seconds) |
| `npm audit --json` | Passed: zero vulnerabilities |
| `npm audit --omit=dev --json` | Passed: zero vulnerabilities |

The final E2E runs use the actual pruned Webpack standalone artifact through `npm run start:test -- --standalone`. The default artifact has a separate startup smoke for health, readiness, sessions, sign-in and unauthenticated protected-route redirects. Canonical tests use the exact loopback origin. Managed tests explicitly set `VERCEL=1` and an HTTPS synthetic `AUTH_URL` in both server and test processes; this test setting is not a production host-policy exception.

Responsive coverage includes 10 screen states at 320, 390, 768, 1024 and 1440 CSS pixels, plus real Chromium 200% zoom at physical 768 and 1440 pixels. Native zoom is applied through an isolated temporary browser extension, not CSS zoom. Measurements cover overflow, persistent labels, financial text visibility, sampled text contrast and shared button heights; modal and real recovery checks add keyboard and failure evidence. All 75 matrix records passed. Across 65 states with shared controls, 921 repeated button/link observations had a minimum height of 44 CSS pixels; seven representative dashboard links were each 44 pixels tall. The 320-pixel group layout had previously collapsed its dashboard link to 20 pixels. The JSON records the actual dimensions and results rather than inferring usability from screenshots alone.

The CI test process now explicitly uses the same managed-host flag as its server. One final browser run exposed an evicted Chromium response-body cache during a real navigation race; the harness now retains and fulfills the genuine RSC response through Playwright before releasing the older response. The ordering and rendered-state assertions remain, and both full topology suites passed afterward.

The test suites retain their original authorization/financial assertions. The previous offboarding fixture used an expiry in July 2026; its dates now derive from one captured current time so it tests offboarding rather than accidental expiry. UI assertions now target semantic account articles and visible responsive rows rather than a removed visual class. Vitest emits an existing CommonJS/native-config-loader future-migration warning; the pinned runner's checks pass.

## Runtime packaging and configuration

Qualification found that Next.js copied the private source `.env` into standalone output. Tracing exclusions, recursive artifact pruning and a fail-closed verifier now prevent those copies from shipping. A regression verifies nested copies are removed while the original fixture file remains. The actual private environment file was not edited or printed.

Deployments must inject the existing runtime settings through the process environment or managed secret store; the standalone artifact no longer carries dotenv files. No new required production setting or database migration was introduced. `.env.example` now includes an explicitly separate disposable test URL and optional limiter/proxy guidance. The test launcher adds an optional `--standalone` flag and defaults canonical local `AUTH_URL` to `E2E_BASE_URL`.

The [dependency evidence](dependency-verification.json) separates the npm graphs from the copied runtime inventory. Next.js 16.4.6 and Sharp 0.35.5 are copied runtime packages. Auth.js/Zod application code can be bundled into server chunks; their absence as standalone package manifests is not treated as proof they are excluded. Prisma CLI/dev tooling, TypeScript ESLint and Vitest are absent from the copied runtime inventory. Current source versions are recorded against the lockfile hash.

## Changed files by concern

The [complete file inventory](changed-files.json) records modified/new source and tests by concern. The main review boundaries are:

- Dependencies: `package.json`, `package-lock.json` and the scoped development override.
- Authentication: `auth-adapter.ts`, `auth-session-lifetime.ts`, `authentication-start.ts`, `auth.ts`, the authentication action and Proxy.
- Ledger/dashboard: `data/transactions.ts`, `money.ts`, dashboard queries/action and the four dashboard components.
- Readiness: `readiness.ts`, health helpers and the readiness route.
- Interface: global tokens, shared UI/system components, existing public/authenticated pages and error boundaries.
- Runtime/test transport: `next.config.ts`, artifact prune/verifier, guarded launcher, browser session proxy and managed CI test configuration.
- Regressions: focused unit/PG17 tests, real authentication HTTP checks, dashboard workflows and responsive/accessibility checks.
- Documentation: README, environment template, this record, implementation plan and visual/dependency evidence. Historical reports are preserved.

## Outstanding policy and deployment validation

The quarantined-owner offboarding policy remains deliberately unchanged. Owners cannot be disabled until custody is resolved, and quarantined teams cannot use the active-team ownership-transfer path. After recovery expires, the supported retention/purge process may be required. The administration UI explains this blocker. A project-owner decision is still needed if incident response requires a different custody model; no exception was introduced.

Hosted CI was not executed locally. Require its PostgreSQL 17/Linux run and branch-protection gate before merging or release. A staging deployment must still verify real Google callbacks/sign-out, canonical ingress/forwarding and TLS, runtime database grants, managed secrets, backup restoration, log/alert delivery and the final deployment-platform artifact. Local synthetic sessions do not establish those results.

The actual dashboard loading/error/retry boundary was fault-tested. Other root/global error boundaries have unit coverage for callback wiring and safe rendering but were not deliberately fault-injected through a public route; the application has no production fault endpoint. Their next verification step is a controlled root-layout/client fault in isolated staging. Assistive-technology and additional supported-browser sessions also remain environment-specific validation.

Production release qualification is not marked complete by this local implementation record.
