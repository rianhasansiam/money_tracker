# Money Tracker project audit

Audit date: 16 November 2026, Asia/Dhaka. Reviewed commit: `cdc7a911f49a72c975bc0f1ae6cc1b3a86dda451`.

The current project has nine confirmed findings: one High, six Medium, and two Low. The most urgent issue is the locked dependency set, which includes an applicable Next.js Server Actions denial-of-service vulnerability. Application findings cover transaction history refresh, absolute session lifetime, an OAuth rate-limit bypass, the quarantine dialog, date preservation, and readiness query cancellation. Two lower-priority defects affect extreme currency totals and the local browser-test setup.

The existing quality checks and database tests pass. Both production bundlers compile, and standalone artifact checks pass. These results coexist with the findings below because several affected behaviors are outside the current assertions. Dependency audits fail. See the [verification record](2026-11-16-verification.md) for results and the [remediation plan](2026-11-16-remediation-plan.md) for implementation order and acceptance criteria.

## Scope and evidence

The review covered application routes and API handlers, all source modules and components, authentication and authorization, financial writes and reads, team and administrative lifecycles, Prisma schema and all seven migrations, operational scripts, dependency configuration, CI, and tests. The starting checkout contained 165 tracked files, including 85 under `src`, 36 under `tests`, 12 scripts, nine Prisma files, and two GitHub configuration files.

Verification used the pinned Node.js 22.22.2 and npm 11.11.0. Database checks ran on a newly created, disposable PostgreSQL 18 instance, separate from the application database. The repository's CI targets PostgreSQL 17; that platform was not reproduced locally. Relevant Next.js 16 documentation was read from the installed package before authoring reproduction code. Application code, schema, and migrations were not changed.

Severity describes impact in this application, rather than copying the highest advisory score from a dependency tree. High means a material security or availability issue requiring release attention. Medium means a reproducible functional, security-control, or reliability failure. Low means an uncommon edge case or a development-workflow defect. Each finding below identifies its evidence and triggering conditions.

## Finding register

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| AUD-001 | High | Locked dependencies include applicable security advisories | Registry audit and upstream advisories |
| AUD-002 | Medium | Transaction history ignores refreshed server data | Production browser workflow and component reproduction |
| AUD-003 | Medium | Sessions exceed the documented eight-hour absolute lifetime | Running application and disposable database |
| AUD-004 | Medium | Direct OAuth sign-in bypasses the authentication quota | 21 direct HTTP sign-ins, zero limiter buckets |
| AUD-005 | Medium | Quarantine confirmation fails to behave as a viewport modal | Production browser workflow and keyboard reproduction |
| AUD-006 | Medium | Accepted transaction years below 0100 change before storage | Actual validation and database write |
| AUD-007 | Medium | Readiness timeout leaves its database query running | Actual delayed database query |
| AUD-008 | Low | Currency formatting loses cent precision at extreme totals | Actual money helpers |
| AUD-009 | Low | Browser test proxy fails with canonical local authentication | Production browser workflow under two configurations |

## Detailed findings

### AUD-001 Locked dependencies include applicable security advisories

**Severity: High. Status: Open.**

Evidence: [package.json:60](../../package.json#L60) pins Next.js `16.2.10`; [package.json:61](../../package.json#L61) and the lockfile resolve Auth.js `5.0.0-beta.31`. Other relevant locked versions include `@auth/core@0.41.2`, `sharp@0.34.5`, `zod@4.3.6`, and `postcss@8.5.10`. The existing overrides at [package.json:86](../../package.json#L86) no longer clear the current advisory set.

`npm audit --json` exited 1 with 33 affected package entries: four Critical, 15 High, and 14 Moderate. `npm audit --omit=dev --json` exited 1 with 20 entries: four Critical, 11 High, and five Moderate. These counts include transitive/meta-vulnerable packages and are not counts of independently exploitable application vulnerabilities. The production-only audit describes npm's dependency graph, which can include peer tooling; it does not establish that every flagged package exists in the pruned standalone artifact. A dated [dependency snapshot](2026-11-16-dependency-audit.json) preserves both results.

This application uses the App Router and Server Actions, matching the prerequisites for the published CPU-exhaustion issues affecting this Next.js version. Requests can consume server resources before an action's own authorization or rate limiter runs. The later advisory affects Next.js through `16.4.0` and identifies `16.4.1` as patched. The audit's suggested Next.js upgrade at verification time was `16.4.6`. [Upstream July advisory](https://github.com/vercel/next.js/security/advisories/GHSA-m99w-x7hq-7vfj), [upstream October advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r).

Critical advisory applicability requires care. Windows-hosted releases have an additional published Next.js RCE exposure; the current verification host is macOS. The locked Sharp version also falls below the upstream SVG image-optimization fix for glibc Linux. The current configuration does not enable arbitrary remote image origins, and an RCE exploit was not demonstrated here. These are deployment-dependent exposures requiring upgrade assessment. [Windows advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), [SVG image advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw).

The Auth.js audit entries do not establish an application authentication bypass: current guards inspect concrete user properties, only Google is configured, and the source does not call `getToken()`. Email/magic-link and cross-provider prerequisites are absent. The dependency snapshot retains those advisory links for review.

**Reproduce:** Install the committed lockfile with `npm ci`, then run both audit commands. No hostile payload is needed to establish the affected dependency versions and matching Server Actions configuration.

**Fix:** Upgrade Next.js and its paired ESLint configuration together, update Auth.js and compatible adapters, and refresh vulnerable runtime and development transitive dependencies. Reassess the narrowly pinned overrides against patched upstream packages. Validate the lockfile, migrations, both bundlers, standalone startup, authorization, and browser flows. Do not use a forced bulk dependency fix as a substitute for compatibility review.

### AUD-002 Transaction history ignores refreshed server data

**Severity: Medium. Status: Open.**

Evidence: [transaction-list.tsx:21](../../src/components/dashboard/transaction-list.tsx#L21) initializes `transactions` and `nextCursor` from `initialPage` only once. [dashboard-shell.tsx:52](../../src/components/dashboard/dashboard-shell.tsx#L52) renders that component without a revision key. After a save, [transactions.ts:121](../../src/actions/transactions.ts#L121) revalidates the dashboard and refreshes the router. The preserved component state has no reconciliation path for the new history props.

**Reproduce:** Start with an empty dashboard and save its first transaction. After the save completes and the form clears, the list continues showing `No transactions yet` and `0 loaded`. A probe added to the real production browser workflow returned `savedEntryVisible: 0`, `emptyStateVisible: 1`, and `zeroLoadedVisible: 1`. An independent component reproduction produced the same stale state. A full reload reinitializes the list correctly.

**Impact:** The normal money-entry flow can present a balance and history that disagree. Users may believe a save failed. Newly inserted entries can also remain missing from an already loaded history page.

**Fix:** Reconcile a new server snapshot with the loaded history and pagination cursor, or deliberately remount history when a snapshot revision changes. Handle a refresh arriving during an incremental request so an old response cannot restore stale state. Assert that a newly saved entry appears without a reload, including after loading additional pages.

The current browser test checks database insertion and later reloads before checking history at [critical-ui-workflows.spec.ts:279](../../tests/browser/critical-ui-workflows.spec.ts#L279) and [line 323](../../tests/browser/critical-ui-workflows.spec.ts#L323), leaving this behavior unasserted.

### AUD-003 Sessions exceed the documented absolute lifetime

**Severity: Medium. Status: Open.**

Evidence: [README.md:175](../../README.md#L175) promises a fixed eight-hour maximum. [auth.ts:30](../../src/lib/auth.ts#L30) supplies Auth.js with `maxAge` and `updateAge`, but those implement rolling database expiry. [auth-adapter.ts:85](../../src/lib/auth-adapter.ts#L85) checks account state without checking session creation age, and [line 121](../../src/lib/auth-adapter.ts#L121) forwards expiry updates without an absolute cap.

**Reproduce:** Create a synthetic active user's session with `createdAt` nine hours ago and a future expiry. Request `/api/auth/session` with its raw cookie. The running application accepted it and updated its stored expiry to approximately eight hours from the request. The installed Auth.js implementation at `node_modules/@auth/core/lib/actions/session.js:75` independently confirms the renewal logic.

**Impact:** A regularly refreshed session, including a stolen token, can remain valid beyond the stated maximum. The separate recent-authentication requirement still protects sensitive administrative changes; ordinary authorized reads and ledger operations are affected by the longer session lifetime.

**Fix:** Enforce `createdAt + eight hours` in session lookup and update, delete expired sessions, and cap the stored, returned, and cookie expiries consistently. Test repeated renewal before and after the absolute deadline.

### AUD-004 Direct OAuth sign-in bypasses the quota

**Severity: Medium. Status: Open.**

Evidence: [authentication.ts:53](../../src/actions/authentication.ts#L53) enforces 20 starts per five minutes in `beginGoogleSignIn`. The catch-all [auth route](../../src/app/api/auth/%5B...nextauth%5D/route.ts) also exposes Auth.js directly. Its wrapper at [auth.ts:117](../../src/lib/auth.ts#L117) checks the host and delegates without consuming that quota.

**Reproduce:** Fetch `/api/auth/csrf`, retain the returned CSRF cookie and token, then send 21 form-encoded POSTs to `/api/auth/signin/google` with that token and a local callback URL. Against the running application, all 21 returned Google authorization redirects; the disposable database contained zero `authentication-start` buckets. No Google callback or real identity was used.

**Impact:** The public HTTP sign-in path bypasses both the intended request quota and the UI action's fail-closed client-IP availability policy. A valid CSRF token does not prevent clients from initiating their own repeated requests.

**Fix:** Enforce one shared policy at every externally reachable sign-in entry point. Avoid accidentally charging the UI flow twice. Add an HTTP regression that obtains a legitimate CSRF token and verifies the first request over quota is denied.

### AUD-005 Quarantine confirmation is not a viewport modal

**Severity: Medium. Status: Open.**

Evidence: [delete-team-button.tsx:47](../../src/components/groups/delete-team-button.tsx#L47) renders a fixed-position overlay inline under the group card. The ancestor at [groups/page.tsx:218](../../src/app/groups/page.tsx#L218) uses `.glass-panel.animate-entry`. [globals.css:135](../../src/app/globals.css#L135) applies `backdrop-filter`; the retained animation transform also establishes a containing block and stacking context. The dialog has no focus trap or inert background.

**Reproduce:** Open the confirmation inside a glass card. In the production browser workflow, the overlay measured `806 × 380` at `(33, 329)` inside a `1280 × 720` viewport. An independent component reproduction also confirmed the containing-block problem and showed Tab moving focus into background controls while the dialog remained open.

**Impact:** The overlay covers its containing card instead of the viewport. On a tall card, its centered confirmation can be away from the visible area. Background controls remain available to keyboard users despite `aria-modal="true"`.

**Fix:** Use an accessible modal primitive rendered through a body portal, or native `<dialog>`. Verify viewport coverage, keyboard focus containment, Escape, focus restoration, and a small viewport with many groups.

### AUD-006 Accepted early years change before storage

**Severity: Medium. Status: Open.**

Evidence: The validator and [date-time.ts:66](../../src/lib/date-time.ts#L66) accept and preserve Gregorian years `0001` through `0099`. [data/transactions.ts:146](../../src/lib/data/transactions.ts#L146) rebuilds the parsed value with `Date.UTC(year, month, day)`, which interprets years 0 through 99 as 1900 through 1999.

**Reproduce:** Submit valid input with `transactionDate: "0099-01-01"`. The actual form schema accepted it. Writing through `createTeamTransaction` to the disposable database persisted `1999-01-01T00:00:00.000Z`.

**Impact:** Uncommon but accepted input silently changes the financial record's date by 1,900 years, affecting chronology and sorting.

**Fix:** Preserve the parsed year while normalizing to midnight, using a cloned date with `setUTCHours`, or the existing year-safe helper. If ancient dates are outside the product contract, explicitly validate a minimum year instead. Test the complete write path for `0001`, `0099`, and `0100`.

### AUD-007 Readiness timeout does not stop its query

**Severity: Medium. Status: Open.**

Evidence: [health.ts:10](../../src/lib/health.ts#L10) races the dependency promise against a timeout. Losing the race does not cancel the query. [api/ready/route.ts:16](../../src/app/api/ready/route.ts#L16) uses the shared Prisma client; [db.ts:37](../../src/lib/db.ts#L37) supplies no application-level query or connection deadline. The installed PostgreSQL driver's default query and statement timeouts are disabled.

**Reproduce:** Pass a real one-second `pg_sleep` query to `runReadinessProbe` with a 25 ms timeout. The helper returns `false` while the database promise continues running. The two-second production timeout follows the same control flow.

**Impact:** During slow or stalled database operations, repeated health requests can retain work after HTTP responses finish. With a shared pool and no independent database timeout, outstanding probes can compete with normal queries. This consequence depends on database latency and externally configured timeouts; a production pool-exhaustion load test was not performed.

**Fix:** Bound query execution and connection acquisition at the database/driver level, and limit concurrent probes. Use a cancellation-capable or isolated probe connection where appropriate. Verify that timed-out work releases its connection and that subsequent ordinary queries still complete.

### AUD-008 Extreme aggregate formatting loses a cent

**Severity: Low. Status: Open.**

Evidence: [money.ts:82](../../src/lib/money.ts#L82) divides integer cents by 100 before passing the result to `Intl.NumberFormat`. `calculateBalanceInCents` permits safe integers up to `Number.MAX_SAFE_INTEGER`, but at the upper end the floating-point major-unit value cannot preserve every cent.

**Reproduce:** Calculate and format `9007199254740991` cents. The actual helper returns `BDT 90,071,992,547,409.90`; the exact amount ends in `.91`.

**Impact:** Displayed aggregates can differ from the exact integer ledger. Reaching this scale requires millions of near-maximum transactions, so this is a low-priority boundary defect. Ordinary per-transaction values are below the demonstrated precision boundary.

**Fix:** Format the integer quotient and remainder, or another exact decimal representation, without converting the entire amount to an imprecise major-unit number. Test positive and signed values near the supported aggregate maximum.

### AUD-009 Browser proxy assumes managed host validation

**Severity: Low. Status: Open.**

Evidence: [critical-ui-workflows.spec.ts:60](../../tests/browser/critical-ui-workflows.spec.ts#L60) opens a browser proxy on a random port and forwards incoming headers unchanged. Its `Host` therefore identifies the proxy, while canonical local authentication expects the upstream origin. The initial session check at [line 219](../../tests/browser/critical-ui-workflows.spec.ts#L219) fails. The CI workflow explicitly selects managed topology at [.github/workflows/ci.yml:173](../../.github/workflows/ci.yml#L173), which masks this local setup mismatch.

**Reproduce:** Build and start the application at `http://127.0.0.1:3047` with that canonical `AUTH_URL`, then run the documented E2E command using the same base URL. The seven HTTP tests pass, but the browser session request is rejected. Restarting the same artifact with CI's explicit managed-host topology makes the browser workflow pass.

**Impact:** The documented local production-test setup cannot complete the browser suite under canonical host enforcement. This is a fixture compatibility defect; the application's rejection of the unexpected host is correct.

**Fix:** Make the proxy fixture represent the upstream canonical origin consistently, or provide an explicit local test launcher with a documented test topology. Keep a canonical-host test so the suite exercises production self-hosting as well as managed hosting. Preserve the application's host validation.

## Earlier audit findings

The July reports remain historical records. Current verification found several previously open issues resolved: group/admin pagination and read limits are implemented; the invitation clock mismatch is corrected; the workflow is tracked and requires E2E; and standalone pruning and verification run automatically after the default build. PostgreSQL tests and runtime assertions passed for those paths.

The earlier zero-vulnerability assessment is no longer current because later advisories affect the locked versions. The previous Windows `.env` ACL observation cannot describe this macOS checkout: neither `.env` nor `.env.local` existed during review, and secret-file contents were not inspected.

## Controls that passed verification

The exercised tests support exact normal-range money parsing, idempotent writes, concurrent withdrawal protection, cross-team isolation, lifecycle authorization, session revocation on offboarding, recoverable quarantine, retained audit snapshots, append-only audit enforcement, consistent initial dashboard snapshots, and the enum compatibility migration. A separate probe also confirmed two maximum-size transactions aggregate correctly above the signed PostgreSQL integer range.

These results do not certify external deployment controls. Real Google OAuth callbacks, production ingress, TLS configuration, database grants, branch protection, backups and restore drills, alert delivery, and production load behavior require environment-specific validation. Dependency remediation and the normal-flow dashboard defect should be addressed before release qualification.
