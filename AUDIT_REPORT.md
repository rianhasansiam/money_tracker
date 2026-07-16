# Money Tracker Security, Correctness, and Reliability Audit

## Audit metadata

| Item | Value |
| --- | --- |
| Audit date | 2026-07-15 (Asia/Dhaka) |
| Repository commit | b45f7a384554707d32c8a1d274c3f0cc7e7049c2 |
| Repository state | Clean before report creation |
| Application | bank 0.1.0 |
| Main stack | Next.js 16.2.4, React 19.2.4, Auth.js / next-auth 5.0.0-beta.31, Prisma 7.7.0, PostgreSQL |
| Runtime used for checks | Node.js 22.22.2, npm 11.11.0, Windows x64 |
| Audit type | Safe review with no tracked source/configuration or database writes; generated/build output was limited to ignored local artifacts |
| Report audience | Engineering team, with an executive summary for project owners |

No credential, OAuth identifier, database endpoint, session value, or personal record is included in this report.

This audit created only AUDIT_REPORT.md in repository-tracked state; it did not modify application code, public interfaces or types, database schema or records, migrations, dependencies, or configuration. Diagnostic generation/build commands updated only ignored node_modules/.next artifacts.

## Executive summary

The application has several good foundational controls: every exported mutation authenticates on the server, transaction authorization is checked close to the write, dashboard reads require an approved team membership, removals use a serializable database transaction, inputs use Zod, and database access uses typed Prisma APIs rather than raw SQL.

The audit nevertheless found **26 actionable findings**:

| Severity | Count | Meaning |
| --- | ---: | --- |
| Critical | 0 | Immediate compromise or catastrophic loss is readily exploitable |
| High | 5 | Serious security, financial-integrity, or deployment risk requiring prompt action |
| Medium | 12 | Material correctness, privacy, availability, or defense-in-depth weakness |
| Low | 9 | Conditional hardening, maintainability, or lower-impact correctness issue |

The highest priorities are:

1. Upgrade the directly used vulnerable Next.js release.
2. Prevent identity deletion from cascading into financial-history or whole-team deletion.
3. Add idempotency to money writes so retries cannot duplicate credits or debits.
4. Make Prisma Client generation part of clean installation/build/CI.
5. Provide a safe, documented first-admin bootstrap for a fresh database.

This is a best-effort snapshot. A safe static/read-only review cannot prove that every possible defect is absent.

## Scope and methodology

The review covered:

- All tracked application source, server actions, route protection, validation, financial calculations, Prisma schema, and migrations.
- Authentication, authorization, IDOR, CSRF, XSS, injection, SSRF, session, privacy, secret, and destructive-action risks.
- Dependency advisories from npm’s current registry, dependency reachability, and package placement.
- Lint, TypeScript, Prisma validation/migration status, production builds, generated Proxy manifest, and unauthenticated route/header smoke tests.
- Test/CI inventory, dead-code analysis, environment-file tracking/history, redacted environment health, and local file permissions.
- The installed Next.js 16 documentation, especially:
  - node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md:35
  - node_modules/next/dist/docs/01-app/02-guides/data-security.md:272-360 and 592-600
  - node_modules/next/dist/docs/01-app/02-guides/authentication.md:1449-1492

The bundled guidance states that Proxy must be beside app or pages, and that Server Actions must be treated as public endpoints with their own authorization. Official equivalents are the [Next.js Proxy guide](https://nextjs.org/docs/app/getting-started/proxy), [data-security guide](https://nextjs.org/docs/app/guides/data-security), and [authentication guide](https://nextjs.org/docs/app/guides/authentication).

### Severity and confidence

- **Severity** combines likely impact and practical exploitability in this application; it is not copied blindly from package-level CVSS.
- **Confidence: High** means directly demonstrated or unambiguously established by source/schema behavior.
- **Confidence: Medium** means the behavior is established but impact depends on product intent, deployment, or an external configuration.
- **Conditional** findings should be resolved by confirming the stated deployment or product assumption.

## Prioritized remediation roadmap

### Priority 0 — immediate

- Upgrade Next.js and eslint-config-next together to a patched compatible release, currently at least 16.2.10 according to npm audit, then repeat the full verification matrix.
- Add transaction idempotency and distinguish committed writes from post-commit presentation failures.
- Prevent operational user/team deletion until financial-history retention and ownership-transfer safeguards are in place.
- Add automatic Prisma Client generation and prove a clean checkout can lint, typecheck, test, and build.

### Priority 1 — protect financial integrity

- Migrate destructive user/team relations away from cascading financial-history deletion; add ownership transfer and soft deletion.
- Enforce the database-compatible amount range and a positive-amount database constraint.
- Make dashboard totals/history use one consistent database snapshot.
- Make membership request/approval writes atomic and map expected database conflicts to stable action results.
- Add the safe first-admin bootstrap, relocate proxy.ts beside src/app, restrict the local .env ACL, and retain page/action authorization as authoritative.

### Priority 2 — access, scale, and operations

- Add account allowlisting/invites, user disablement, session revocation, and a defined session lifetime.
- Add cursor pagination, scoped counts, action/read rate limits, and durable audit events.
- Add security headers, recovery boundaries, structured redacted logging, monitoring, backup/restore verification, and CI.
- Add unit, PostgreSQL integration, authorization, concurrency, and end-to-end regression tests.

### Priority 3 — maintenance

- Correct the MODARETOR compatibility typo through a database-safe migration.
- Replace the template README, add an env example and production migration instructions, pin supported tooling, and clean unused exports/dependencies.

---

## Detailed findings

### MT-001 — Known vulnerabilities in the directly used Next.js version

- **Severity:** High
- **Confidence:** High
- **Evidence:** package.json:28 pins Next.js 16.2.4. npm audit --omit=dev reports seven vulnerable production-tree packages: three high and four moderate at package level. The direct Next.js package has advisories affecting Server Components, Proxy, caching, image optimization, CSP/script handling, and WebSocket upgrades. npm reports a compatible fix at 16.2.10.
- **Impact:** Depending on the exercised framework feature, a remote actor may cause denial of service, SSRF, cache poisoning, XSS, or bypass the optimistic Proxy layer. Page-level and action-level authorization reduce the impact of Proxy-bypass advisories but do not address framework availability or SSRF defects.
- **Remediation:** Upgrade next and eslint-config-next together to at least the patched compatible version reported by the registry. Do not rely on Proxy as the only authorization control. Re-audit after updating.
- **Verification:** npm audit no longer lists next or its bundled postcss; lint, typecheck, both production build modes, protected-route tests, cache behavior, and authenticated authorization tests pass.
- **References:** See the complete linked Next.js advisory list in Appendix B.

### MT-002 — User deletion can erase transactions or an entire team ledger

- **Severity:** High
- **Confidence:** High for schema behavior; trigger likelihood is conditional
- **Evidence:** prisma/schema.prisma:86-87 configures Transaction.createdBy with onDelete: Cascade. prisma/schema.prisma:101 configures Team.createdBy with onDelete: Cascade. Team deletion then cascades its transactions and memberships through prisma/schema.prisma:86 and 118. No application user-deletion path currently exists, so triggering user deletion requires an operational process or future adapter/application behavior.
- **Impact:** If a user who recorded transactions is deleted, those ledger facts disappear and the computed balance changes. Deleting a team creator can delete the team, all memberships, and all transactions. This conflicts with the UI’s representation of transaction history as permanent.
- **Remediation:** Use Restrict or a nullable SetNull actor relation, retain an immutable actor display snapshot, require ownership transfer before creator deletion, and use user soft deletion. Keep financial facts independent from identity lifecycle.
- **Verification:** On a disposable integration database, deleting or disabling an actor preserves every transaction and balance; deleting a creator is blocked until ownership is transferred; historical attribution remains readable.

### MT-003 — Financial writes are not idempotent

- **Severity:** High
- **Confidence:** High
- **Evidence:** src/lib/data/transactions.ts:97-106 inserts a transaction without a client operation key or unique replay guard. src/actions/transactions.ts:65-67 performs revalidation/refresh after the commit, while lines 102-105 tell the user to retry after an unclassified failure. prisma/schema.prisma:76-92 has no idempotency column or constraint.
- **Impact:** A lost response, timeout, double submission, retry after an ambiguous result, or failure after commit can create a duplicate credit or debit. UI button disabling does not protect direct Server Action calls or network retries.
- **Remediation:** Generate an operation UUID on the client, persist it with the transaction, add a unique teamId/idempotencyKey constraint, and atomically return the original result on replay. Separate post-commit presentation/cache failures from write failures.
- **Verification:** Simultaneous duplicate submissions and retries after an intentionally dropped response produce exactly one database row and the same logical result.

### MT-004 — Clean installation/build depends on manual Prisma generation

- **Severity:** High
- **Confidence:** High
- **Evidence:** package.json:5-14 provides a manual db:generate script but no postinstall, prebuild, or CI lifecycle hook. prisma/schema.prisma:1-3 generates into ignored node_modules state. At the start of the audit, the generated client was absent and npm run typecheck failed with 19 errors, beginning with missing Prisma and PrismaClient exports. After npx prisma generate, the same typecheck passed.
- **Impact:** A clean clone, deployment cache, or CI runner can fail typechecking/building even when the source is valid. Cascading implicit-any errors obscure the real setup cause.
- **Remediation:** Run prisma generate explicitly during installation/build and CI. Document the required order and test it from a clean dependency installation.
- **Verification:** A clean checkout with no generated client succeeds through npm ci, Prisma generation, lint, typecheck, tests, and production build without manual intervention.

### MT-005 — Fresh databases have no safe first-admin path

- **Severity:** High
- **Confidence:** High
- **Evidence:** prisma/schema.prisma:15 defaults every new user to MEMBER. src/actions/groups.ts:64-69 permits only global ADMIN users to create a team. No seed, bootstrap command, allowlist, admin UI, or setup documentation exists.
- **Impact:** A new deployment can accept Google sign-in but cannot create its first team through supported application behavior. Manual database editing becomes an undocumented and error-prone production requirement.
- **Remediation:** Add an explicit idempotent bootstrap command/seed driven by a configured administrator identity. Avoid “first person to sign in becomes admin,” which creates a race and account-takeover opportunity. Document rotation and recovery.
- **Verification:** Starting with an empty disposable database, the documented bootstrap creates exactly one intended administrator on repeated execution, and that administrator can create the first team.

### MT-006 — The intended Next.js Proxy is not compiled

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** The application is under src/app, but proxy.ts is at the repository root. The installed Next.js 16 guide says Proxy must be at the same level as app or pages. After a successful production build, .next/server/middleware-manifest.json contained zero middleware, zero functions, and zero sorted middleware entries.
- **Impact:** The Auth.js authorized callback is not providing the intended early route gate. Current protected pages and mutations perform their own checks, so no direct unauthorized data access was demonstrated, but a defense layer and expected request behavior are absent.
- **Remediation:** Move proxy.ts to src/proxy.ts. Keep authorization checks in pages, Server Actions, and the data layer because Proxy is only an optimistic check.
- **Verification:** The production manifest contains the expected matcher, unauthenticated protected requests are rejected by Proxy, and direct Server Action/resource-authorization tests still reject unauthorized callers.

### MT-007 — Any successfully authenticated Google account can enumerate team metadata

- **Severity:** Medium
- **Confidence:** High for behavior; Medium for product impact
- **Evidence:** src/lib/auth.ts:15-44 enables Google without an application-level invite, user allowlist, domain rule, or active-user check. src/lib/queries/groups.ts:143-166 loads every team the caller has not joined, including name, description, creator name, and member count. Approved dashboard data also serializes creator email fallback data into a Client Component at src/app/dashboard/[teamId]/page.tsx:65-74 and src/lib/queries/dashboard.ts:91-128. Google Cloud consent-screen, test-user, Workspace, and organization restrictions were not reviewed.
- **Impact:** If this is an organization-private application, any Google account permitted by the external OAuth configuration can discover team names, descriptions, creator identity, approximate size, and submit unsolicited requests. Approved members receive more identity data than may be necessary.
- **Remediation:** Use invitations or a server-side account/domain allowlist, add an active/disabled user state, minimize metadata for nonmembers, and serialize only the display information the client actually needs. Do not rely solely on Google’s hosted-domain UI hint.
- **Verification:** Non-allowlisted users cannot establish an application session or enumerate teams; disabled users lose sessions; DTO tests prove private fields are not serialized.

### MT-008 — Session lifetime and offboarding are not explicitly controlled

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/lib/auth.ts:18-20 selects database sessions but does not set maxAge or updateAge. The installed Auth.js configuration documents defaults of 30 days and one-day rolling updates at node_modules/@auth/core/src/index.ts:254-266. The User model has no active or disabledAt field and no application session-revocation workflow. There is also no supported promotion, demotion, membership-revocation, or ownership-transfer workflow; src/components/dashboard/dashboard-shell.tsx:81-83 explicitly instructs direct database role changes.
- **Impact:** A stolen session, or a session belonging to an upstream account that has since been disabled, may remain valid locally for an extended period. Emergency suspension and routine privilege lifecycle depend on manual database operations.
- **Remediation:** Define an explicit risk-appropriate session lifetime, add user disablement, reject disabled users during session/auth checks, delete all sessions during offboarding or sensitive role changes, require recent authentication for destructive actions, and add audited role/membership/ownership lifecycle operations.
- **Verification:** Disabled users and revoked sessions fail on their next request; expired sessions cannot be rolled forward; role/ownership changes are authorized and audited; destructive-action tests enforce the chosen recent-authentication rule.

### MT-009 — Permanent team deletion lacks durable safeguards and audit

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/actions/groups.ts:130-177 hard-deletes a team. The additional confirmation is client-side window.confirm at src/components/groups/delete-team-button.tsx:27-37. No append-only audit record, soft-delete state, recent-authentication check, or restore workflow is present.
- **Impact:** A mistaken or compromised global-admin session can permanently erase a complete ledger. A browser confirmation is easy to automate or accept accidentally and leaves no durable evidence.
- **Remediation:** Prefer soft deletion with a retention window, require typed confirmation and recent authentication, record an audit event outside the deletion cascade, restrict global-admin scope where possible, and test backup restoration.
- **Verification:** Deletion first hides/quarantines the team, creates an immutable audit event, can be restored during retention, and cannot be executed without the required privilege and recent authentication.

### MT-010 — Unbounded reads and missing rate limits create a scaling/DoS path

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/lib/queries/dashboard.ts:69-98 fetches every transaction and serializes the list into DashboardShell. src/lib/queries/groups.ts:116-141 performs two global membership groupings, lines 143-166 load all unjoined teams, and lines 168-204 load all pending approvals. src/lib/data/transactions.ts:76-110 recalculates the ledger during every serializable write. No application rate limiter exists.
- **Impact:** Database work, response size, RSC payload, browser memory, and render time grow without a bound. Authenticated callers can repeatedly trigger expensive queries or writes.
- **Remediation:** Add cursor pagination with hard limits, scoped/relation counts, incremental history rendering, and user/IP rate limits. Consider maintaining balance/counter aggregates atomically while retaining the immutable ledger as source of truth.
- **Verification:** Load tests with large ledgers keep query count, response size, memory, and p95 latency within defined limits; exceeding request quotas returns a controlled response.

### MT-011 — Browser security headers are absent

- **Severity:** Medium
- **Confidence:** High for repository/local behavior; production edge unknown
- **Evidence:** next.config.ts:3-5 defines no headers and leaves poweredByHeader enabled. A production-server request to /login returned X-Powered-By: Next.js and no Content-Security-Policy, Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, or Permissions-Policy.
- **Impact:** The browser receives weaker containment against script injection, clickjacking, content sniffing, referrer leakage, and unnecessary feature access. Framework fingerprinting is also enabled.
- **Remediation:** Upgrade Next first, disable poweredByHeader, deploy a CSP in report-only mode before enforcement, set frame-ancestors, object-src, base-uri, form-action, nosniff, a conservative referrer policy, and a minimal permissions policy. Enable HSTS only on HTTPS production domains.
- **Verification:** Automated response-header tests pass on public, authenticated, HTML, and API routes; CSP reporting shows no required resource is blocked before enforcement.

### MT-012 — Accepted money values exceed the database storage range

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/lib/money.ts:21-36 accepts any positive JavaScript safe integer after conversion to cents. prisma/schema.prisma:81 uses Prisma Int, backed by PostgreSQL int4 with a maximum of 2,147,483,647. For example, 21,474,836.48 BDT converts to 2,147,483,648 cents and passes application validation before failing persistence. The schema has no positive-amount CHECK constraint.
- **Impact:** A value presented as valid reaches the database and returns a generic save failure. Future or alternate write paths could insert invalid nonpositive amounts unless they reproduce application checks.
- **Remediation:** Cap values at 21,474,836.47 BDT or migrate amount/totals consistently to BigInt/Decimal. Add a database constraint requiring amountInCents greater than zero.
- **Verification:** Boundary tests cover zero, one cent, the maximum, maximum plus one cent, very long input, and aggregate growth; application and database reject the same invalid values with field-level errors.

### MT-013 — Date validation and timezone rules are inconsistent

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/lib/validators/transaction.ts:21-25 checks only the YYYY-MM-DD shape and lexical future comparison. Real calendar validation occurs later at src/lib/money.ts:86-105, so a value such as 2024-02-30 passes Zod and becomes a generic action error at src/actions/transactions.ts:102-105. “Today” uses the executing machine’s local zone at src/lib/money.ts:77-83, while validation runs in both browser and server. A UTC production host rejects Bangladesh’s local today between 00:00 and 05:59. formatTransactionDate forces UTC and is also used for membership timestamps at src/app/groups/page.tsx:217 and 342.
- **Impact:** Valid local dates can be rejected, impossible dates receive misleading feedback, and timestamp dates can display one day early around midnight in Dhaka.
- **Remediation:** Validate a real calendar date inside the shared schema, define the business zone explicitly as Asia/Dhaka if that is the product rule, and use separate formatters for date-only transaction values and timestamp instants.
- **Verification:** Tests cover leap years, invalid month/day combinations, UTC/Dhaka midnight boundaries, clients in other zones, and timestamp/date-only formatting.

### MT-014 — Dashboard balance and history can come from different snapshots

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/lib/queries/dashboard.ts:59-99 issues the aggregate and transaction-list queries concurrently as separate reads. Under the normal PostgreSQL READ COMMITTED behavior, a transaction can commit between the snapshots.
- **Impact:** A response can show a balance that includes a row absent from the displayed history, or history containing a row not reflected in totals. This undermines trust in a financial dashboard.
- **Remediation:** Run authorization, aggregate, and list reads in a read transaction with RepeatableRead, or derive both views from one versioned snapshot.
- **Verification:** A concurrency integration test inserts a transaction between the two read phases and proves each rendered response is internally consistent.

### MT-015 — Membership mutations have check-then-write races

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** src/actions/groups.ts:223-256 checks for a membership and later creates it despite the unique teamId/userId constraint, so concurrent requests can produce an uncaught P2002. Lines 287-349 read pending state and approver rights separately, then update unconditionally; two approvers can both report success and overwrite approval metadata. Delete has a similar find/delete P2025 race at lines 156-177. Client callers do not consistently catch rejected Server Action promises.
- **Impact:** Users see unhandled failures, stale success messages, last-writer approval attribution, or a write authorized by state that changed just after the check.
- **Remediation:** Use upsert or map P2002 to an idempotent result, perform authorization and conditional PENDING-to-APPROVED update in one transaction, require exactly one affected row, map P2025 cleanly, and catch transport/action failures in the clients.
- **Verification:** Parallel request, approval, revocation, and deletion integration tests return deterministic results and preserve the first valid approval record.

### MT-016 — Local .env permissions are broader than necessary

- **Severity:** Medium
- **Confidence:** High for this host; deployment applicability conditional
- **Evidence:** The file is correctly ignored and untracked, but its inherited Windows ACL grants BUILTIN Users read/execute and Authenticated Users modify access.
- **Impact:** On a shared workstation or build host, another local account can read or tamper with database, OAuth, and application secrets.
- **Remediation:** Restrict the file to its owner, Administrators, and SYSTEM. Use a managed secret store and least-privilege service identities in production.
- **Verification:** Get-Acl shows no broad read/modify principals, the application still starts, and secret rotation procedures are tested.

### MT-017 — No automated tests, CI, or dependency-security gate

- **Severity:** Medium
- **Confidence:** High
- **Evidence:** package.json has no test script, no test/spec files exist, no .github/workflows directory exists, and no dependency-update/security-scanner configuration is present.
- **Impact:** Money/date regressions, authorization errors, race conditions, build setup failures, and vulnerable dependency releases can reach production undetected.
- **Remediation:** Add unit tests for money/date/balance/roles; PostgreSQL integration tests for authorization, transactions, constraints, cascades, and races; authenticated end-to-end role/navigation tests; and CI running install, generation, lint, typecheck, tests, build, dependency audit, and secret scan.
- **Verification:** CI is required for merge, fails on seeded regressions, and publishes test/security results without secrets.

### MT-018 — Unconditional trustHost is unsafe on an untrusted proxy

- **Severity:** Low
- **Confidence:** Medium; deployment-conditional
- **Evidence:** src/lib/auth.ts:6-17 deletes canonical URL variables on Vercel and sets trustHost: true in every environment. The installed Auth.js source warns that the deployment must safely set Host.
- **Impact:** On a self-hosted or misconfigured proxy, forged Host or forwarded-host values may influence OAuth URLs or redirects. Vercel is expected to normalize these headers.
- **Remediation:** Limit dynamic-host behavior to trusted platforms, configure a canonical AUTH_URL for self-hosting, and sanitize/allowlist forwarded hosts at ingress.
- **Verification:** Host-header tests cannot produce an off-domain callback or redirect in every supported deployment topology.

### MT-019 — OAuth and session bearer tokens are readable in a database compromise

- **Severity:** Low
- **Confidence:** High for storage behavior; conditional on database/log compromise
- **Evidence:** prisma/schema.prisma:31-36 stores provider refresh/access/ID tokens, and lines 44-48 store the database session token. This follows common adapter behavior but leaves reusable bearer material in database rows.
- **Impact:** A database snapshot/read compromise can expose active application sessions and potentially provider tokens. Risk depends on Google scopes, token lifetime, database access, backups, and logging controls.
- **Remediation:** Enforce database/backup encryption, least-privilege roles, short token retention, restricted/redacted logs, and incident rotation. Avoid retaining provider tokens not needed by the application; consider hashing session lookup tokens through a compatible adapter design.
- **Verification:** A data-retention review proves only required tokens are stored; backup/database access is audited; revocation invalidates compromised tokens.

### MT-020 — Malformed comma placement changes the entered amount

- **Severity:** Low
- **Confidence:** High
- **Evidence:** src/lib/money.ts:17-24 removes every comma before validating. Values such as 1,2 and 1,,000 are silently interpreted as 12 and 1000.
- **Impact:** A typo in a finance form can create a valid but unintended transaction instead of a validation error.
- **Remediation:** Accept ungrouped digits only, or validate a specific en-BD grouping format before removing separators.
- **Verification:** Unit tests reject malformed grouping and accept only the documented formats.

### MT-021 — Transaction team IDs are not schema-validated

- **Severity:** Low
- **Confidence:** High
- **Evidence:** src/actions/transactions.ts:33-63 validates the form object but passes teamId separately without teamIdSchema. Authorization later fails safely for unknown values, and Prisma parameterization prevents SQL injection.
- **Impact:** Oversized or malformed identifiers cause an unnecessary authorization query and can return misleading resource/permission feedback. The current path does not demonstrate an injection or IDOR exploit.
- **Remediation:** Validate teamId at the Server Action boundary and return a stable invalid-resource result before database access.
- **Verification:** Empty, oversized, malformed, unknown, cross-team, and valid IDs produce the expected field/resource result without leaking existence.

### MT-022 — Prisma CLI is in production dependencies and pulls vulnerable tooling

- **Severity:** Low
- **Confidence:** High dependency graph; low runtime reachability
- **Evidence:** package.json:31 places prisma in dependencies. npm audit --omit=dev therefore includes @prisma/dev, @hono/node-server, Hono, and fast-uri advisories in the production tree. These packages are tooling dependencies and are not imported by the running application.
- **Impact:** Production installs are larger and report toolchain vulnerabilities; risk rises if Prisma Studio/dev services are exposed or tooling processes untrusted input.
- **Remediation:** Move the Prisma CLI to devDependencies, never expose Studio publicly, update Prisma packages together after compatibility testing, and re-audit. Do not blindly apply npm’s suggested major Prisma downgrade.
- **Verification:** A production-only install can run the application without the CLI/toolchain subtree, while build/migration jobs still have the pinned CLI.

### MT-023 — Missing recovery boundaries and structured observability

- **Severity:** Low
- **Confidence:** High
- **Evidence:** src/app contains no error.tsx, global-error.tsx, loading.tsx, or route-specific not-found.tsx. Several group actions allow unexpected database failures to reject without a stable result. No structured application logging, request correlation, error monitoring, or health/readiness behavior is defined.
- **Impact:** Database or network faults can replace an entire dynamic page with framework defaults, produce poor user feedback, and be difficult to diagnose safely.
- **Remediation:** Add accessible recovery/loading boundaries, stable action errors, redacted structured logs with correlation IDs, monitoring/alerting, and operational health checks.
- **Verification:** Fault-injection tests show recoverable UI, no sensitive error details, and a correlated server-side event.

### MT-024 — Setup, environment, migration, and dependency documentation is incomplete

- **Severity:** Low
- **Confidence:** High
- **Evidence:** README.md is the create-next-app template, refers to app/page.tsx rather than src/app/page.tsx, mentions different fonts, and omits Auth.js, environment, database, roles, migrations, and deployment. .gitignore ignores all .env* files without an exception for .env.example. package.json has no engines/packageManager pin and offers prisma migrate dev but no production migrate deploy script. Knip reports dotenv/config as unlisted from prisma.config.ts:1 and pg as unused; @prisma/adapter-pg already declares pg as its own dependency.
- **Impact:** New developers and deployment automation can choose unsupported tooling, miss required variables/generation, use a development migration command in production, or depend accidentally on transitive hoisting.
- **Remediation:** Replace the README with actual setup/architecture/deployment instructions, add a names-only .env.example plus ignore exception, pin supported Node/npm, add an explicit production migration command, declare dotenv directly, and remove direct pg after verification.
- **Verification:** A new developer or clean CI runner follows only documented steps to configure, migrate, generate, test, and build.

### MT-025 — MODARETOR is persisted as a public compatibility typo

- **Severity:** Low
- **Confidence:** High
- **Evidence:** MODARETOR appears in Prisma UserRole and TeamMemberRole enums at prisma/schema.prisma:127-137, a committed migration, manual TypeScript unions, permission checks, and user-facing text.
- **Impact:** The typo leaks into database values, generated types, APIs/UI copy, and future integrations. A later naive correction can break existing rows or sessions.
- **Remediation:** Use a compatibility-safe PostgreSQL enum-value migration to MODERATOR, update generated types/code/copy atomically, regenerate Prisma Client, and document the migration.
- **Verification:** Existing moderator rows retain permissions, no old value remains in schema/source/UI, and authorization tests pass before and after migration.

### MT-026 — Dead exports and duplicated helper logic increase maintenance risk

- **Severity:** Low
- **Confidence:** High
- **Evidence:** Knip reports unused exports buttonVariants, CardFooter, normalizeMoneyInput, and transactionTypeValues, plus four unused exported group-summary interfaces. hasPrismaErrorCode and server-field-error mapping are also duplicated.
- **Impact:** Unused public surface and duplicate error logic make security/correctness behavior easier to change inconsistently.
- **Remediation:** Remove or make unused exports private, centralize narrow shared error helpers, and keep the dependency graph explicit.
- **Verification:** Knip passes with documented exceptions only, and lint/typecheck/tests remain green.

---

## Positive controls observed

- Every exported Server Action calls auth on the server.
- Transaction creation rechecks approved team role inside the serializable write transaction.
- Dashboard reads require the exact approved teamId/userId membership before ledger data is fetched.
- Insufficient-balance enforcement occurs in the same serializable transaction as removal creation, with retry handling for serialization conflicts.
- Form payloads are validated with Zod on the server; Prisma uses parameterized typed queries.
- No raw SQL, eval/new Function, user-controlled outbound fetch, dangerous HTML sink, or permissive CORS configuration was found.
- User-provided names, descriptions, and notes are rendered through React escaping.
- Next Server Actions retain built-in same-origin/Origin-versus-Host CSRF checks.
- .env is ignored, untracked, and absent from Git history. Required variable names are present, the auth secret passes a length-only check (entropy was not assessed), and the database URL declares an SSL option (transport and certificate behavior were not independently verified).
- No high-confidence private-key, OAuth-key, OpenAI-key, or credential-bearing database URL signature was found in tracked source.
- Prisma schema validation and migration status passed; the configured schema is current.
- Lint, generated-client typechecking, and the Webpack production build passed.
- Unauthenticated /dashboard and /groups requests redirect to /login, independently of the missing Proxy, because the pages perform their own auth checks.

## Environment observation (not classified as an application defect)

### OBS-001 — Local native SWC binary is invalid

The default npm run build failed before application compilation because the installed @next/swc-win32-x64-msvc binary is not a valid Win32 application. Turbopack cannot use the loaded WASM fallback on this platform. The documented npx next build --webpack fallback compiled, typechecked, generated all seven routes, and exited successfully.

This points to local dependency/platform state rather than a proven source defect. Reinstall dependencies for the correct architecture and verify the default build on a clean supported Windows installation and Linux CI before changing build tooling.

## Verification matrix

| Check | Result | Notes |
| --- | --- | --- |
| git status --short before report | Pass | Worktree clean |
| git rev-parse HEAD | Pass | b45f7a384554707d32c8a1d274c3f0cc7e7049c2 |
| npm run lint | Pass | Exit 0 |
| Initial npm run typecheck before generation | Fail, setup-related | 19 cascading errors; generated Prisma Client absent |
| npx prisma generate | Pass | Generated ignored client artifacts |
| Refreshed npm run typecheck | Pass | Exit 0 |
| npx prisma validate | Pass | Schema valid |
| npx prisma migrate status | Pass | Four migrations found; configured schema current |
| npm audit --omit=dev --json | Findings | 7 production-tree vulnerable packages: 3 high, 4 moderate |
| npm audit --json | Findings | 10 vulnerable packages: 3 high, 6 moderate, 1 low |
| npm run build | Environment failure | Invalid local native SWC; Turbopack cannot use WASM |
| npx next build --webpack | Pass | Seven routes built successfully |
| middleware-manifest inspection | Finding | Zero compiled Proxy/middleware entries |
| GET / and /login | Pass | HTTP 200 |
| GET /dashboard and /groups without session | Pass | HTTP 307 to /login |
| /login security-header inspection | Finding | Six reviewed security headers absent; X-Powered-By present |
| Env tracking/history scan | Pass | .env ignored, untracked, zero history commits |
| Tracked secret-signature scan | Pass | Zero high-confidence matches |
| .env ACL inspection | Finding | Broad inherited read and modify principals |
| Test/CI inventory | Finding | No test script, test files, or CI workflow |
| Knip | Findings | Unused/unlisted dependency and export issues documented in MT-024/026 |
| External Markdown links | Pass | All 25 unique HTTPS links resolved successfully during final QA |
| Report consistency check | Pass | MT-001 through MT-026 are contiguous; totals are 5 High, 12 Medium, and 9 Low; every finding has all required fields |
| git status --short after report | Pass | Only AUDIT_REPORT.md is untracked |

## Appendix A — Recommended regression scenarios

1. **Authorization matrix:** anonymous, pending member, approved member, moderator, team admin, global admin, revoked user, and disabled user across every page and Server Action.
2. **Cross-team isolation:** valid IDs belonging to another team must reveal neither data nor resource existence and must never mutate.
3. **Money boundaries:** zero, one cent, maximum int4 value, maximum plus one, malformed grouping, too many decimals, huge strings, and concurrent removals.
4. **Idempotency:** duplicate tabs, double click, replayed action ID, retry after response loss, and retry after cache-refresh failure.
5. **Date boundaries:** leap days, impossible dates, Dhaka/UTC midnight, client zones east/west of Dhaka, future date, and date-only versus timestamp formatting.
6. **Membership concurrency:** duplicate request, simultaneous approvals, approver revocation during approval, deleted request/team, and stale UI.
7. **Identity lifecycle:** disable/delete actor, creator, member, moderator, and admin while preserving financial facts and required ownership.
8. **Scale:** large transaction history, many teams/memberships/pending requests, repeated reads, and rate-limit enforcement.
9. **Deployment:** clean install/generate/migrate/build, Proxy manifest, environment validation, production migration, headers, CSP reporting, and backup restoration.

## Appendix B — Dependency advisory references

### Direct Next.js package

- [GHSA-8h8q-6873-q5fj — Server Components denial of service](https://github.com/advisories/GHSA-8h8q-6873-q5fj)
- [GHSA-26hh-7cqf-hhc6 — App Router segment-prefetch Proxy bypass follow-up](https://github.com/advisories/GHSA-26hh-7cqf-hhc6)
- [GHSA-3g8h-86w9-wvmq — Proxy redirect cache poisoning](https://github.com/advisories/GHSA-3g8h-86w9-wvmq)
- [GHSA-ffhc-5mcf-pf4q — CSP nonce XSS](https://github.com/advisories/GHSA-ffhc-5mcf-pf4q)
- [GHSA-vfv6-92ff-j949 — RSC cache-busting collision/cache poisoning](https://github.com/advisories/GHSA-vfv6-92ff-j949)
- [GHSA-gx5p-jg67-6x7h — beforeInteractive script XSS](https://github.com/advisories/GHSA-gx5p-jg67-6x7h)
- [GHSA-mg66-mrh9-m8jx — Cache Components connection-exhaustion denial of service](https://github.com/advisories/GHSA-mg66-mrh9-m8jx)
- [GHSA-h64f-5h5j-jqjh — Image Optimization denial of service](https://github.com/advisories/GHSA-h64f-5h5j-jqjh)
- [GHSA-c4j6-fc7j-m34r — WebSocket-upgrade SSRF](https://github.com/advisories/GHSA-c4j6-fc7j-m34r)
- [GHSA-492v-c6pp-mqqv — dynamic-route Proxy bypass](https://github.com/advisories/GHSA-492v-c6pp-mqqv)
- [GHSA-wfc6-r584-vfw7 — RSC response cache poisoning](https://github.com/advisories/GHSA-wfc6-r584-vfw7)
- [GHSA-267c-6grr-h53f — App Router segment-prefetch Proxy bypass](https://github.com/advisories/GHSA-267c-6grr-h53f)
- [GHSA-36qx-fr4f-26g5 — Pages Router i18n Proxy bypass](https://github.com/advisories/GHSA-36qx-fr4f-26g5)

Not every advisory’s feature is used by this repository; for example, no custom WebSocket-upgrade code, CSP nonce setup, or Pages Router i18n configuration was found. The direct framework package still requires upgrade because several applicable availability and App Router/Proxy advisories remain.

### Representative tooling and transitive package advisories

- [GHSA-92pp-h63x-v22m — @hono/node-server static middleware bypass](https://github.com/advisories/GHSA-92pp-h63x-v22m)
- [GHSA-q3j6-qgpj-74h6 — fast-uri encoded path traversal](https://github.com/advisories/GHSA-q3j6-qgpj-74h6)
- [GHSA-v39h-62p7-jpjc — fast-uri host confusion](https://github.com/advisories/GHSA-v39h-62p7-jpjc)
- [GHSA-88fw-hqm2-52qc — Hono credentialed CORS origin reflection](https://github.com/advisories/GHSA-88fw-hqm2-52qc)
- [GHSA-wwfh-h76j-fc44 — Hono Windows encoded-backslash traversal](https://github.com/advisories/GHSA-wwfh-h76j-fc44)
- [GHSA-qx2v-qp2m-jg93 — PostCSS style-output XSS](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)
- [GHSA-4x5r-pxfx-6jf8 — Babel source-map arbitrary file read](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)
- [GHSA-jxxr-4gwj-5jf2 — brace-expansion denial of service](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2)
- [GHSA-h67p-54hq-rp68 — js-yaml quadratic-complexity denial of service](https://github.com/advisories/GHSA-h67p-54hq-rp68)

The Hono/fast-uri findings are reached through the Prisma CLI/dev subtree, while Babel, brace-expansion, and js-yaml findings are development-only. This lowers runtime reachability but does not remove the need to update and correctly classify the dependency tree. The links above are representative; the dated npm audit JSON is authoritative for the full current transitive-advisory set.

## Limitations and exclusions

The audit did **not** perform:

- Authenticated mutation or destructive testing against the configured database.
- Active exploitation, fuzzing, load testing, race injection, or denial-of-service testing.
- Verification of Google Cloud OAuth consent/client settings or organizational access rules.
- Verification of production CDN/edge headers, reverse-proxy host sanitation, WAF/rate limiting, DNS, TLS, or firewall rules.
- Review of cloud IAM, database roles, provider audit logs, backups, retention, disaster recovery, or restore evidence.
- Mobile/browser matrix accessibility testing or authenticated visual end-to-end testing.

Those areas require a disposable environment, test identities for each role, and infrastructure access. Findings marked conditional must be reassessed when that context is available.
