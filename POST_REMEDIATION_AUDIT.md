# Money Tracker Post-Remediation Audit

## Audit metadata

| Item | Value |
| --- | --- |
| Audit date | 2026-07-15 (Asia/Dhaka) |
| Repository HEAD | `b45f7a384554707d32c8a1d274c3f0cc7e7049c2` |
| Audited state | Current working tree, including modified and untracked remediation files |
| Application | `money-tracker` 0.1.0 |
| Runtime | Node.js 22.22.2, npm 11.11.0, Windows x64 |
| Database used for destructive checks | Standalone temporary PostgreSQL 18 cluster on loopback, with separate `money_tracker_postfix_audit_test` and `money_tracker_postfix_upgrade_test` databases |
| Production database access | None. The configured application target was not connected to, migrated, reset, queried, or modified. |

This report is a post-fix verification of `AUDIT_REPORT.md`, not an assumption that newly added code works. Application source was not changed to make checks pass. The only repository file created by this audit is `POST_REMEDIATION_AUDIT.md`.

## Executive summary

The remediation substantially improves the application. The directly used Next.js version and its lint configuration are now 16.2.10; both dependency audits report zero vulnerabilities; the default Turbopack and compatibility Webpack builds pass; and the compiled output contains Proxy matchers for `/dashboard`, `/groups`, and `/admin`.

The most important financial and identity controls were demonstrated against disposable PostgreSQL databases. Duplicate transaction submissions converge on one ledger row, actor deletion preserves amount and attribution, owner deletion is restricted until transfer, dashboard aggregate/history reads share a repeatable-read snapshot, membership races return controlled results, sessions are hashed and revocable, provider bearer material is not retained, teams are quarantined and restorable, and the persisted `MODARETOR` value is renamed in place without replacing rows or enum OIDs. A separate legacy-seeded upgrade scenario also preserved the ledger through all three remediation migrations.

The repository is nevertheless **not production-ready yet**. `npm test`, `npm run test:integration`, and `npm run ci` fail because an invitation integration test uses fixed times that are now earlier than the database row's `createdAt`; the local `.env` ACL remains broadly readable/modifiable; group and administration collections are bounded but not fully paginated; and a plain `npm ci --omit=dev` still installs the Prisma CLI through `@prisma/client`'s optional peer edge until the separately documented prune command is run. There are no unresolved High findings, but the remaining Medium issues must be resolved before release.

The remediation is also entirely uncommitted at the audited HEAD. Files under `.github`, the new migrations, tests, and most new controls are currently untracked. They cannot protect a deployed branch or run in GitHub Actions until they are reviewed and committed.

## Status counts

Counts cover MT-001 through MT-026 plus OBS-001.

| Status | Count |
| --- | ---: |
| FIXED | 23 |
| PARTIALLY FIXED | 3 |
| NOT FIXED | 1 |
| REGRESSION | 0 |
| NOT VERIFIABLE | 0 |
| NO LONGER APPLICABLE | 0 |
| **Total** | **27** |

## Test-database safety

No requested database-backed command used `DATABASE_URL` from `.env`. The audit initialized a standalone temporary PostgreSQL cluster under the Windows temp directory, bound it only to `127.0.0.1:55432`, and created two explicitly named test databases. Test commands received:

- the disposable database through `TEST_DATABASE_URL`;
- a different, deliberately nonexistent loopback database through `DATABASE_URL` to prevent fallback to the configured application database;
- `NODE_ENV=test` and synthetic authentication/rate-limit values;
- no inherited target-changing `PG*` variables.

The repository's own guard additionally rejected application/test identity overlap, production-looking database names, unsafe remote targets, and concurrent destructive leases. Seven migrations applied successfully to an empty database, migration status was current, and `prisma migrate diff` reported no difference between the migrated database and `prisma/schema.prisma`.

Docker was not used. The local checks used installed PostgreSQL binaries directly, and the documented local/VPS workflows use ordinary npm and PostgreSQL processes. No `Dockerfile`, Compose file, Docker command, or Docker runtime requirement exists in the repository. GitHub Actions does declare an isolated PostgreSQL service container for CI, but that does not make Docker a local or production application requirement.

## Verification command matrix

### Requested commands

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | Exit 0; 584 packages installed; guarded postinstall generated Prisma Client; audit summary reported zero vulnerabilities. |
| `npm run db:generate` | PASS | Prisma Client 7.7.0 generated successfully. |
| `npm run db:validate` | PASS | Prisma schema valid. |
| `npm run lint` | PASS | Exit 0, no findings. |
| `npm run typecheck` | PASS | Exit 0 after the clean install/generation path. |
| `npm test` | **FAIL** | Unit phase: 218/218 passed. Integration phase: 38/39 passed; fixed-time invitation test violated `Invitation_expiry_check`. Authorization phase was not reached by this chained command, but passed separately. |
| `npm run test:unit` | PASS | 28 files, 218 tests passed. |
| `npm run test:integration` | **FAIL** | 1 file passed, 1 file failed; 38 tests passed and 1 failed for the same fixed-time invitation case. |
| `npm run test:e2e` | PASS | Database preparation passed; 2 Vitest files/7 tests passed; the real Chromium critical UI workflow passed. |
| `npm run build` | PASS | Next.js 16.2.10 default Turbopack build compiled, typechecked, generated 11 routes, and reported `Proxy (Middleware)`. |
| `npm audit --omit=dev` | PASS | Zero vulnerabilities. |
| `npm audit` | PASS | Zero vulnerabilities. |
| `npx knip` | PASS | Exit 0 with no output/findings. |

### Additional checks

| Command/check | Result | Evidence |
| --- | --- | --- |
| `npm run db:test:migrate` on empty database | PASS | All seven committed migrations applied in order. |
| `npm run db:test:status` | PASS | Database schema up to date. |
| `npx prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma` | PASS | No difference detected. |
| `npm run test:authorization` | PASS | 5 files, 54 tests passed. |
| `npm run build:webpack` | PASS | Webpack production build compiled and generated all routes. |
| `npm run verify:proxy-manifest` after each build | PASS | All three protected route families found. |
| Production route/header smoke | PASS | Public routes 200; protected families 307 without a session; required security headers present; health/readiness 200 with no-store and correlation IDs. |
| Administrator bootstrap twice | PASS | Both executions exited 0 and exactly one active administrator existed. |
| Legacy-seeded migration audit | PASS after audit-harness correction | Backfill count 1; two existing users active; session hashed/capped; provider tokens cleared; zero legacy enum labels; both moderator rows preserved; actor deletion retained ledger; owner deletion raised PostgreSQL `restrict_violation`; team and ledger remained. |
| Isolated `npm ci --omit=dev` | PARTIAL | The install passed but retained `prisma` and `@prisma/dev` via the optional peer edge. The documented `npm uninstall prisma --no-save --omit=dev --ignore-scripts` removed 78 tooling packages and left both absent. |
| `npm run ci` | **FAIL** | Reached the integration phase and failed on the same fixed-time invitation test. |
| `.env` tracking/history | PASS | `.env` is ignored, untracked, and absent from Git history; `.env.example` is explicitly unignored but is currently untracked. |
| `.env` ACL | **FAIL** | Inherited `Authenticated Users: Modify` and `BUILTIN\\Users: ReadAndExecute` remain. |

## Failed commands

Three repository commands failed for one shared reason:

1. `npm test` — exit 1.
2. `npm run test:integration` — exit 1.
3. `npm run ci` — exit 1 before authorization, Knip, build, and audit stages.

The failing test is `tests/integration/postgres-financial-integrity.test.ts:1223`. It supplies `now = 2026-07-15T06:00:00Z` and `expiresAt = 2026-07-15T06:10:00Z`, while `Invitation.createdAt` is generated by the database's current clock. At audit time the disposable database clock was after 07:15 UTC, so the database correctly enforced `Invitation_expiry_check (expiresAt > createdAt)` and rejected the insert. This is not evidence that expired invitations are admitted; it is a non-hermetic test and mixed-clock-source defect.

An initial audit-only legacy probe caught the owner delete as `foreign_key_violation`, but PostgreSQL reports an `ON DELETE RESTRICT` failure as `restrict_violation`. Re-running the probe with the correct SQLSTATE class passed and confirmed the intended constraint. This audit-harness correction is not a repository failure.

## Detailed finding verification

### MT-001 — Known vulnerabilities in the directly used Next.js version

- **Status:** FIXED
- **Current evidence:** `package.json:57` pins `next` 16.2.10 and `package.json:75` aligns `eslint-config-next` to 16.2.10. The lockfile installed that version. Both production dependency and full dependency audits report zero vulnerabilities.
- **Tests or commands used:** `npm ci`; `npm audit --omit=dev`; `npm audit`; `npm run lint`; `npm run typecheck`; `npm run build`; `npm run build:webpack`; protected-route and header E2E tests.
- **Remaining work:** No repository remediation remains for the original finding. Keep dependency audit/Dependabot gates active and re-run both build modes after framework updates.

### MT-002 — User deletion can erase transactions or an entire team ledger

- **Status:** FIXED
- **Current evidence:** `Transaction.createdBy` is nullable with `onDelete: SetNull` and immutable actor ID/name snapshots (`prisma/schema.prisma:88-100`). `Team.createdBy` uses `onDelete: Restrict` (`prisma/schema.prisma:117`). The financial-integrity migration backfills legacy attribution before changing foreign keys (`20260715090000_financial_integrity/migration.sql:77-125`). User lifecycle helpers require ownership transfer before deletion.
- **Tests or commands used:** Integration tests for actor deletion and owner transfer passed; custom legacy-upgrade audit deleted a legacy actor while preserving the transaction/count/amount/snapshot, and PostgreSQL blocked legacy-owner deletion while retaining the team and ledger.
- **Remaining work:** Execute the migration only with the documented backup/quiescence procedure in production and verify production counts/balances after deployment. No code-level cascade remains from user deletion to financial facts.

### MT-003 — Financial writes are not idempotent

- **Status:** FIXED
- **Current evidence:** `Transaction` has a required bounded idempotency key and unique `(teamId,idempotencyKey)` constraint (`prisma/schema.prisma:88,100`). The action validates a UUID operation key (`src/actions/transactions.ts:81`) and the client retains the same key for an unchanged ambiguous retry. The data layer checks an existing row, verifies the original actor and complete normalized payload, and writes inside a serializable transaction (`src/lib/data/transactions.ts:168-340`). Post-commit refresh failures are returned separately from ledger commit state.
- **Tests or commands used:** The PostgreSQL suite passed double-click, duplicate-tab, simultaneous duplicate, lost-response, post-commit refresh failure, payload-conflict, and concurrent-removal scenarios. The Chromium workflow also exercised duplicate-safe writes.
- **Remaining work:** None for the original finding. Preserve the unique constraint and operation-key retry contract in future clients.

### MT-004 — Clean installation/build depends on manual Prisma generation

- **Status:** FIXED
- **Current evidence:** `postinstall` and `prebuild` are configured at `package.json:13,19`; CI has explicit generation; `scripts/postinstall.mjs` resolves the pinned local CLI and fails a full install if generation fails.
- **Tests or commands used:** A real `npm ci` generated Prisma Client and exited 0; clean-path `db:generate`, typecheck, default build, and Webpack build passed.
- **Remaining work:** Production runtime-only installs intentionally skip generation, so release artifacts must continue to be built in a full build stage as documented.

### MT-005 — Fresh databases have no safe first-admin path

- **Status:** FIXED
- **Current evidence:** `scripts/bootstrap-admin.ts` validates `BOOTSTRAP_ADMIN_EMAIL` before importing the database. `src/lib/admin-bootstrap.ts` canonicalizes the configured email, uses a serializable transaction, rejects ambiguous/disabled/deleted identities, and retries unique/serialization conflicts. It never promotes the first person to sign in.
- **Tests or commands used:** Unit bootstrap tests passed; the full E2E workflow bootstrapped the admin and created the first team; the audit ran `npm run db:bootstrap-admin` twice and observed exactly one active administrator.
- **Remaining work:** Restrict the bootstrap job and remove/rotate its one-purpose configuration after use. Production job authorization is deployment-specific and was not inspected.

### MT-006 — The intended Next.js Proxy is not compiled

- **Status:** FIXED
- **Current evidence:** Proxy is now `src/proxy.ts`, beside `src/app`, matching the installed Next.js 16 convention. It exports Auth.js Proxy and matchers for all three protected families.
- **Tests or commands used:** Both builds reported `Proxy (Middleware)`; `npm run verify:proxy-manifest` passed after both and found `/dashboard/:path*`, `/groups/:path*`, and `/admin/:path*`; unauthenticated route smoke returned 307.
- **Remaining work:** None. Continue treating page/action/data-layer checks as authoritative rather than Proxy alone.

### MT-007 — Any successfully authenticated Google account can enumerate team metadata

- **Status:** FIXED
- **Current evidence:** Google admission requires a verified email and an active pre-provisioned identity or unexpired single-use invitation (`src/lib/auth.ts:58-70`, `src/lib/invitations.ts:509-642`). Disabled/deleted users are denied. Nonmember DTOs now omit creator identity and member counts, and the public session endpoint removes the internal user ID.
- **Tests or commands used:** Unit admission/session tests, authorization tests, PostgreSQL invitation/disabled-user tests, production route tests, and Chromium lifecycle tests passed. The E2E route test proved the browser session DTO does not expose the internal user ID.
- **Remaining work:** Real Google Cloud consent/client/domain configuration was not available; smoke-test it after deployment. The repository-side allowlisting and disabled-user controls are present.

### MT-008 — Session lifetime and offboarding are not explicitly controlled

- **Status:** FIXED
- **Current evidence:** Database sessions use explicit eight-hour `maxAge` and 15-minute `updateAge` (`src/lib/auth.ts:31-33`). Session lookup tokens are SHA-256 digests in the database, inactive users are rejected on lookup, sign-in revokes older sessions, and administrative disable/role/membership/ownership operations revoke affected sessions. A global incident-response revocation command also exists.
- **Tests or commands used:** Auth adapter/session unit tests passed; PostgreSQL tests for old-session revocation, hashed lookup, offboarded lookup, user disablement, role change, membership revocation, and ownership transfer passed; route E2E rejected a disabled user on the next request.
- **Remaining work:** Validate cookie/identity-provider revocation behavior in the real deployment and retain incident exercises. No missing application revocation path from the original finding remains.

### MT-009 — Permanent team deletion lacks durable safeguards and audit

- **Status:** FIXED
- **Current evidence:** Browser deletion is now a typed-name, recent-authentication-gated 30-day quarantine (`src/lib/team-lifecycle.ts:156-246`). Normal reads hide quarantined teams. Restore retains the same ledger/memberships (`src/lib/team-lifecycle.ts:249-327`). Permanent purge is offline, retention-gated, backup-reference-gated, and writes an independent append-only audit snapshot before the cascade (`src/lib/team-lifecycle.ts:330-417`).
- **Tests or commands used:** Unit lifecycle/action tests, PostgreSQL quarantine/restore/retention/purge/audit tests, full workflow E2E, and Chromium UI quarantine/restore passed.
- **Remaining work:** Production backup restoration and the separately controlled purge identity were not verifiable in this repository. Test them operationally before enabling purge.

### MT-010 — Unbounded reads and missing rate limits create a scaling/DoS path

- **Status:** PARTIALLY FIXED
- **Current evidence:** Dashboard history now uses a 25-row initial page, validated authorized cursor, 50-row hard server maximum, repeatable-read transactions, and durable per-user rate limits (`src/lib/queries/dashboard.ts:8,126-280`; `src/actions/dashboard.ts:48-70`). Group reads use scoped relation counts and hard sentinel limits of 100/50/100 with a durable read limiter (`src/lib/queries/groups.ts:5-7,129-312`). Writes are also rate-limited through PostgreSQL HMAC buckets.
- **Tests or commands used:** Unit rate-limit/query tests passed; PostgreSQL atomically enforced a shared limiter and paginated 1,025 transactions over 41 pages without gaps/duplicates; Chromium exercised history pagination.
- **Remaining work:** Group collections and administration collections are capped, not cursor-paginated. `GroupsPage` does not consume its `truncated` flags, so memberships/available teams/approvals beyond the limits cannot be reached; the admin console requires search after truncation and its initial read is not rate-limited. Add navigable pagination/search for every capped collection, rate-limit the administration read, display group truncation, define performance targets, and operationalize expired-bucket cleanup.

### MT-011 — Browser security headers are absent

- **Status:** FIXED
- **Current evidence:** `next.config.ts:5-8` disables `X-Powered-By` and applies global header rules. The rules emit report-only CSP, frame denial, nosniff, conservative referrer and permissions policies, plus HSTS only for known HTTPS production topologies (`src/lib/security-headers.ts:13-121`).
- **Tests or commands used:** Header unit tests, production route E2E, and direct smoke requests to public, protected, health, and readiness routes passed. `X-Powered-By` was absent.
- **Remaining work:** Collect and review real CSP reports before enforcement; no report sink was available to verify. HSTS preload/subdomain policy remains an explicit deployment decision.

### MT-012 — Accepted money values exceed the database storage range

- **Status:** FIXED
- **Current evidence:** Parser maximum is exactly 2,147,483,647 minor units and uses `BigInt` before number conversion (`src/lib/money.ts:8-64`). Shared Zod validation maps the range to a field error. The migration installs and validates `CHECK (amountInCents > 0)` (`prisma/migrations/20260715090000_financial_integrity/migration.sql:131-135`).
- **Tests or commands used:** Money/transaction validator unit tests passed; PostgreSQL boundary and positive-check tests passed; live constraint inventory confirmed the check.
- **Remaining work:** None while PostgreSQL `int4` remains the storage type. Revisit all aggregate/storage paths together before increasing the range.

### MT-013 — Date validation and timezone rules are inconsistent

- **Status:** FIXED
- **Current evidence:** `src/lib/date-time.ts` defines `Asia/Dhaka`, validates real Gregorian dates/leap years, separates date-only UTC storage/formatting from business-zone timestamp formatting, and calculates business today from an instant. The shared transaction schema rejects impossible/future dates before the action.
- **Tests or commands used:** Date-time and transaction-validator unit tests passed, including leap days and Dhaka/UTC boundaries; E2E transaction creation passed.
- **Remaining work:** None for the original defect. Retain explicit date-only versus instant types in future features.

### MT-014 — Dashboard balance and history can come from different snapshots

- **Status:** FIXED
- **Current evidence:** Membership authorization, aggregate totals, and initial history page are performed in one `RepeatableRead` transaction (`src/lib/queries/dashboard.ts:121-201`). Incremental cursor pages use the same isolation level.
- **Tests or commands used:** PostgreSQL synchronization-barrier test inserted between aggregate and list phases and passed, proving the rendered response remains internally consistent.
- **Remaining work:** None for the original finding.

### MT-015 — Membership mutations have check-then-write races

- **Status:** FIXED
- **Current evidence:** Requests run serializably and map duplicate creation to an idempotent current state. Approval locks actor, team, pending request, and approver membership, then performs a conditional PENDING-to-APPROVED `updateMany` requiring one row (`src/actions/groups.ts:641-759`). Client components catch rejected action transport.
- **Tests or commands used:** PostgreSQL tests for simultaneous requests, simultaneous approvals, stale retries, deleted membership/team, and revoked approver passed; authorization and Chromium approval flows passed.
- **Remaining work:** None for the tested race classes. Retain lock order and concurrency tests when adding membership mutations.

### MT-016 — Local `.env` permissions are broader than necessary

- **Status:** NOT FIXED
- **Current evidence:** `.env` remains ignored/untracked and absent from history, but its inherited ACL still grants `NT AUTHORITY\\Authenticated Users` Modify and `BUILTIN\\Users` ReadAndExecute. Owner, Administrators, and SYSTEM are not the only principals.
- **Tests or commands used:** `Get-Acl .env`; `git check-ignore`; `git ls-files`; full-history `git log -- .env`.
- **Remaining work:** Restrict this file to the owner, Administrators, and SYSTEM; remove broad inherited rules or store secrets in a managed secret store; rotate credentials if other local principals may have accessed them.

### MT-017 — No automated tests, CI, or dependency-security gate

- **Status:** PARTIALLY FIXED
- **Current evidence:** The working tree now contains 28 unit files/218 unit tests, authorization tests, PostgreSQL integration/concurrency tests, production route tests, one real Chromium workflow, `.github/workflows/ci.yml`, Dependabot, npm audits, Knip, and a pinned/checksummed Gitleaks CI step. However these files are untracked at the audited HEAD, the E2E stage is optional behind `RUN_E2E`, and the integration test defect makes both `npm test` and `npm run ci` fail today.
- **Tests or commands used:** Unit 218/218 pass; authorization 54/54 pass; E2E 7/7 plus Chromium 1/1 pass; integration 38/39; `npm run ci` fails at integration; audits and Knip pass separately.
- **Remaining work:** Fix the clock-dependent invitation test, make the complete required pipeline green, commit the workflow/tests, enable branch protection, and decide whether the Chromium workflow is mandatory rather than opt-in. Branch-protection state was not verifiable locally.

### MT-018 — Unconditional `trustHost` is unsafe on an untrusted proxy

- **Status:** FIXED
- **Current evidence:** Production self-hosting now fails configuration without an exact HTTPS `AUTH_URL`; auth request handlers compare the normalized request origin with that canonical origin and reject forged/multi-valued hosts (`src/lib/security-policy.ts:67-177`, `src/lib/auth.ts:114-152`). Dynamic hosts are limited to the explicitly recognized managed topology.
- **Tests or commands used:** Security-policy unit tests covered self-hosted HTTPS requirements, forged/multi-valued forwarded hosts, managed hosts, and loopback development. Production route/auth tests passed.
- **Remaining work:** Verify the real ingress overwrites forwarded headers and run off-domain callback tests in each deployed topology. Repository behavior is fail-closed for self-hosting.

### MT-019 — OAuth and session bearer tokens are readable in a database compromise

- **Status:** FIXED
- **Current evidence:** The hardened adapter removes provider token fields before persistence and hashes every create/get/update/delete session-token lookup (`src/lib/auth-adapter.ts`). The migration hashes legacy session values, caps their expiry, and nulls provider bearer fields (`prisma/migrations/20260715120000_security_lifecycle/migration.sql:117-147`). Browser session DTOs are minimized.
- **Tests or commands used:** Adapter/session unit tests passed; PostgreSQL tests confirmed only token digests are stored, inactive lookup is rejected, and the real adapter does not persist provider bearer material; legacy-upgrade audit confirmed hashes/caps/nulls on seeded rows.
- **Remaining work:** Database/backup encryption, access auditing, and Google-side token revocation remain infrastructure controls and were not verifiable here.

### MT-020 — Malformed comma placement changes the entered amount

- **Status:** FIXED
- **Current evidence:** Money parsing accepts either ungrouped digits or strict three-digit comma groups before removing commas (`src/lib/money.ts:16-50`). Inputs such as `1,2` and `1,,000` are rejected.
- **Tests or commands used:** Money and transaction-validator unit suites passed malformed/valid grouping and range cases.
- **Remaining work:** None for the documented format.

### MT-021 — Transaction team IDs are not schema-validated

- **Status:** FIXED
- **Current evidence:** `createTransaction` validates the team ID before rate-limit or authorization/database work and returns one non-enumerating unavailable message (`src/actions/transactions.ts:72-79`). History cursors and team IDs are likewise validated.
- **Tests or commands used:** Transaction action unit tests and PostgreSQL unknown/cross-team equivalence test passed; authorization matrix passed.
- **Remaining work:** None for the original boundary.

### MT-022 — Prisma CLI is in production dependencies and pulls vulnerable tooling

- **Status:** PARTIALLY FIXED
- **Current evidence:** `prisma` moved from `dependencies` to `devDependencies` (`package.json:45-81`), and both dependency audits are clean. However a real isolated `npm ci --omit=dev` still installed `prisma@7.7.0` and `@prisma/dev@0.24.3` because `@prisma/client` exposes Prisma as an optional peer and npm 11 retained the root resolution. README documents an explicit post-build `npm uninstall prisma --no-save --omit=dev --ignore-scripts`; the audit verified that command removes the CLI/tooling.
- **Tests or commands used:** Manifest inspection; `npm ls`; isolated `npm ci --omit=dev`; `npm explain prisma`; documented prune; `npm audit --omit=dev`.
- **Remaining work:** Make the runtime packaging pipeline perform and verify the prune automatically, or use traced/bundled output that never copies the full package tree. Add a CI assertion that `node_modules/prisma` and `node_modules/@prisma/dev` are absent from the final runtime artifact. A plain production-only install is not sufficient today.

### MT-023 — Missing recovery boundaries and structured observability

- **Status:** FIXED
- **Current evidence:** Global, route-specific, loading, and not-found boundaries exist. `src/lib/observability.ts` emits structured JSON with correlation IDs and aggressive key/value redaction; `src/instrumentation.ts` registers request-error reporting; health/readiness routes return minimal no-store responses.
- **Tests or commands used:** Recovery-boundary, observability, health, and header unit tests passed; E2E health/readiness and direct fault-safe route behavior passed.
- **Remaining work:** Connect stdout/`onRequestError` to an approved production log/alert provider and test alerts/retention. The repository supplies the structured events but cannot prove external monitoring configuration.

### MT-024 — Setup, environment, migration, and dependency documentation is incomplete

- **Status:** FIXED
- **Current evidence:** README now documents architecture, environment variables, direct disposable databases, generation, development/production migrations, bootstrap, role/lifecycle behavior, deployment, rollback, headers, observability, backups, CI, default/webpack builds, and Windows SWC recovery. `.env.example` is names-only/synthetic and explicitly unignored. Node/npm are pinned, production migration scripts exist, `dotenv` is declared, and Knip passes. Docker is not required.
- **Tests or commands used:** README/config/package review; `.env.example` tracking rule; clean install; full setup/build commands; Knip; direct non-Docker database execution.
- **Remaining work:** Commit the currently untracked README-adjacent files/workflows/template. Keep documentation synchronized with the production Prisma-prune requirement and test commands.

### MT-025 — `MODARETOR` is persisted as a public compatibility typo

- **Status:** FIXED
- **Current evidence:** Current Prisma enums and application roles use only `MODERATOR` (`prisma/schema.prisma:200-222`). Migration `20260715150000_rename_moderator_enum_values` uses guarded in-place `ALTER TYPE ... RENAME VALUE` for both enums and is restart-safe. The old spelling remains only where required in immutable legacy migration history and compatibility tests.
- **Tests or commands used:** Fresh seven-migration deployment passed; dedicated migration test preserved row identity and enum type/value OIDs and passed on repeat execution; custom legacy upgrade preserved both moderator rows and found zero old enum labels; role/authorization tests passed.
- **Remaining work:** Quiesce old writers during production deployment and verify both enums before resuming traffic, as documented. Do not edit the historical typo migration.

### MT-026 — Dead exports and duplicated helper logic increase maintenance risk

- **Status:** FIXED
- **Current evidence:** Previously reported exports are removed/private, Prisma error detection and server-field mapping are centralized, and dependency declarations are explicit.
- **Tests or commands used:** `npx knip` exited 0 with no findings; lint, typecheck, unit, E2E, and builds passed.
- **Remaining work:** None for the original findings; keep Knip in the required CI path.

### OBS-001 — Local native SWC binary is invalid

- **Status:** FIXED
- **Current evidence:** A clean `npm ci` restored the correct Windows optional dependency and the default Next.js 16.2.10 Turbopack build completed successfully. The compatibility Webpack build also passed.
- **Tests or commands used:** `npm ci`; `npm run build`; `npm run build:webpack`; manifest verification after each.
- **Remaining work:** Do not use `--omit=optional` for build installs; retain clean supported-platform build coverage in CI.

## New findings introduced or exposed by the remediation

### NEW-001 — Invitation integration test and persistence use inconsistent clocks

- **Severity:** Medium
- **Status:** OPEN
- **Evidence:** The failing test injects fixed `now`/`expiresAt` values at `tests/integration/postgres-financial-integrity.test.ts:1224-1239`, while `Invitation.createdAt` is a database default and `Invitation_expiry_check` requires `expiresAt > createdAt` (`prisma/migrations/20260715120000_security_lifecycle/migration.sql:205`). Once the actual database clock passed 06:10 UTC on 2026-07-15, the test became guaranteed to fail. Application invitation actions normally use dates days ahead, so no admission bypass was demonstrated, but mixed application/database clocks can also turn modest clock skew into an unexpected insert failure.
- **Impact:** The required integration and CI gates are red despite 38 other PostgreSQL tests passing. This masks future regressions and blocks trustworthy release qualification.
- **Tests or commands used:** `npm test`; `npm run test:integration`; `npm run ci`; direct comparison of disposable database UTC time with the fixed test values.
- **Remaining work:** Make the test relative to one captured current instant and either persist `createdAt: input.now` consistently or stop injecting application time where the database owns the invariant. Add an explicit clock-skew boundary test without fixed calendar expiry.

No additional confirmed security, financial-write, authorization, schema-migration, or session-revocation regression was found in the exercised paths. The pagination and production-Prisma gaps are retained under their original findings rather than duplicated as new IDs.

## Unresolved High and Medium issues

### High

None.

### Medium

| ID | Status | Release impact |
| --- | --- | --- |
| MT-010 | PARTIALLY FIXED | Some group/admin collections are only truncated, not navigably paginated; group truncation is not shown and the admin read lacks rate limiting. |
| MT-016 | NOT FIXED | The current host's `.env` remains broadly readable/modifiable by local principals. |
| MT-017 | PARTIALLY FIXED | Tests/CI exist but are untracked locally, E2E is optional, and the required chained test/CI commands fail. |
| NEW-001 | OPEN | Non-hermetic invitation time handling makes integration and CI fail after the fixed expiry time. |

MT-022 remains an unresolved Low packaging issue: the final runtime artifact must run and verify the documented Prisma peer prune.

## Production-readiness conclusion

**Conclusion: NOT READY FOR PRODUCTION RELEASE.**

The core security and financial remediation is credible and much stronger than the original state, with no remaining High finding and strong disposable-database evidence for idempotency, deletion safety, session revocation, recoverable team lifecycle, consistent snapshots, race handling, and safe enum migration. The default production build and dependency audits pass.

Release should remain blocked until all of the following are true:

1. Fix NEW-001 so `npm test`, `npm run test:integration`, and `npm run ci` all pass on current and future dates.
2. Commit and review the remediation, migrations, tests, `.env.example`, and CI workflow; then require the green CI check in branch protection.
3. Restrict the `.env` ACL or replace local file secrets and rotate any potentially exposed credentials.
4. Add navigable pagination/search and appropriate rate limiting for every currently truncated read collection, or explicitly revise the product contract and UI so data is never silently unreachable.
5. Make final runtime packaging automatically remove and assert the absence of Prisma CLI/tooling.
6. Rehearse the documented backup/restore, migration quiescence, ingress Host sanitation, Google OAuth, logging/alerting, and final production smoke tests in an isolated staging environment.

## Limitations

- Google Cloud OAuth configuration and a real provider callback were not available.
- Cloud ingress/CDN Host normalization, TLS, HSTS at the edge, WAF behavior, log shipping, alerting, IAM, database roles, backups, PITR, and restore evidence were not available.
- Local destructive tests ran on PostgreSQL 18. The workflow declares PostgreSQL 17, but a remote GitHub Actions run was not available; the current local CI-equivalent command fails earlier at the clock-dependent test.
- GitHub branch protection and whether the untracked workflow is active on a remote repository were not verifiable.
- No load/denial-of-service test was performed; pagination and rate-limit conclusions use source review plus deterministic integration tests.
