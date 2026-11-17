# Money Tracker audit verification record

This record supports the [project audit](2026-11-16-project-audit.md) and [remediation plan](2026-11-16-remediation-plan.md), dated 16 November 2026 in Asia/Dhaka. Results apply to commit `cdc7a911f49a72c975bc0f1ae6cc1b3a86dda451` and its committed lockfile.

## Environment

| Item | Value |
| --- | --- |
| Verification OS | macOS arm64 |
| Node.js | 22.22.2, the repository pin |
| npm | 11.11.0, the repository pin |
| Framework | Next.js 16.2.10, React 19.2.4 |
| Database | Newly initialized disposable local PostgreSQL 18 cluster |
| Test database | `money_tracker_audit_test`, loopback port 54379 |
| Production preview | Loopback port 3047, pruned standalone artifact |
| Browser | Playwright 1.61.1 with its Chromium revision 1228 |

The host initially had Node.js 26 and no installed project dependencies. The pinned Node/npm toolchain was obtained without changing the global toolchain, then `npm ci` completed successfully. Prisma Client generation ran through the install lifecycle. The required pinned Chromium was installed before the completed browser runs.

All database fixtures used the newly created test cluster. Commands received explicit synthetic authentication settings and database targets. The normal application database was not opened. Temporary reproduction code was removed from the repository after verification; the final repository changes are audit documents only. The temporary server and database were stopped after the checks.

## Command results

Commands below ran under the pinned toolchain. Database/E2E commands used the dedicated target described above. Authorization tests overlap unit tests, so their counts must not be added as unique tests.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | Pass | Clean locked install and automatic Prisma generation |
| `npm run db:validate` | Pass | Prisma schema valid |
| `npm run lint` | Pass | Exit 0 |
| `npm run typecheck` | Pass | Exit 0 |
| `npm run test:unit` | Pass | 28 files, 234 tests |
| `npm run test:integration` | Pass | Seven migrations deployed; two files, 45 tests |
| `npm run test:authorization` | Pass | Five files, 55 tests |
| `npm run knip` | Pass | Exit 0, no findings |
| `npm run build` | Pass | Default Turbopack production build; automatic runtime pruning and verification passed |
| `npm run verify:proxy-manifest` after default build | Pass | All three protected route families present |
| `npm run build:webpack` | Pass | Additional production bundler build |
| `npm run verify:proxy-manifest` after Webpack | Pass | All three protected route families present |
| `npm run runtime:prune` and `npm run runtime:verify` after Webpack | Pass | Required runtime packages retained; Prisma CLI/dev tooling absent |
| `npm audit --json` | Fail | Exit 1; 33 affected package entries |
| `npm audit --omit=dev --json` | Fail | Exit 1; 20 affected package entries |
| `npm run test:e2e` with canonical local auth | Partial failure | Seven HTTP tests passed; browser session request failed at line 219, AUD-009 |
| `npm run test:e2e` with CI-style managed auth | Pass | Seven HTTP tests and one complete Chromium workflow passed |
| Additional production browser probe | Pass as a probe | Workflow completed and emitted direct evidence for AUD-002 and AUD-005 |

The final HTTP/browser checks used the pruned Webpack standalone build. The default Turbopack build and its runtime assertions were verified separately. The full hosted GitHub Actions workflow and committed-history Gitleaks scan were not executed in this local review.

## Dependency audit snapshot

| Dependency graph | Critical | High | Moderate | Total package entries |
| --- | --- | --- | --- | --- |
| Full | 4 | 15 | 14 | 33 |
| Production only | 4 | 11 | 5 | 20 |

The [JSON snapshot](2026-11-16-dependency-audit.json) includes the lockfile SHA-256, installed versions, affected ranges, advisory URLs, and npm's proposed fix availability. Package counts include transitive meta-vulnerabilities. Production-only npm classification does not mean every entry ships in the standalone artifact. Advisory reachability was assessed separately in AUD-001.

The Auth.js entries were checked against the configured code paths: Google is the sole provider, guards check concrete user fields, and application code does not call `getToken()`. Those controls prevent treating the package-level Critical labels as demonstrated application account takeover.

## Reproduction results

### Dashboard history and modal in the production browser

A temporary copy of the existing browser workflow added observational probes without changing application code. After the first transaction was committed and the amount field cleared, the history probe returned:

```json
{
  "savedEntryVisible": 0,
  "emptyStateVisible": 1,
  "zeroLoadedVisible": 1
}
```

The same workflow measured the quarantine overlay:

```json
{
  "overlay": { "x": 33, "y": 329, "width": 806, "height": 380 },
  "viewport": { "width": 1280, "height": 720 }
}
```

An independent Chromium harness bundled the actual `TransactionList` and `DeleteTeamButton` components, mocking only Server Actions and the router. It reproduced the stale incoming-prop behavior and the overlay's containing block. Keyboard navigation escaped the dialog to an outside button. This supports the focus finding without implying that the production workflow itself asserts keyboard containment.

### Session lifetime

A synthetic active administrator received a hashed database session with creation time nine hours in the past and expiry one hour in the future. A real request to `/api/auth/session` with its opaque cookie authenticated successfully. A subsequent Prisma lookup showed stored expiry renewed for approximately eight hours:

```json
{
  "ageHours": 9,
  "authenticated": true,
  "databaseRenewedForHours": 8
}
```

No real Google callback was involved. The installed Auth.js core session handler was also invoked independently with a synthetic adapter and showed the same rolling-expiry behavior.

### Direct OAuth quota bypass

A loopback HTTP client fetched its own CSRF token and cookie, then made 21 direct POST requests to `/api/auth/signin/google`, retaining the valid CSRF cookie. Redirects were inspected without following them to Google:

```json
{
  "requests": 21,
  "statusCounts": { "302": 21 },
  "googleRedirects": 21,
  "authenticationStartBucketCount": 0
}
```

The fixture database had no authentication-start bucket before or after these requests. This tests the public HTTP path independently of the UI action's limiter.

### Financial date preservation

The actual form schema accepted `0099-01-01`. The actual transaction service then wrote it into the disposable database:

```json
{
  "inputDate": "0099-01-01",
  "accepted": true,
  "persisted": "1999-01-01T00:00:00.000Z"
}
```

This confirms persistence behavior, rather than inferring it solely from a JavaScript date example.

### Readiness resource lifetime

A real PostgreSQL query executed `SELECT pg_sleep(1)::text`. The readiness helper raced that promise against a 25 ms deadline:

```json
{
  "timeoutMs": 25,
  "queryDurationMs": 1000,
  "ready": false,
  "queryStillRunningAfterTimeout": true
}
```

The query eventually finished. The probe establishes that the helper does not cancel work; it is not a production outage or pool-exhaustion benchmark.

### Extreme currency display

Running the actual money helpers with `Number.MAX_SAFE_INTEGER` cents returned:

```text
Input cents: 9007199254740991
Formatted:   BDT 90,071,992,547,409.90
Exact:       BDT 90,071,992,547,409.91
```

### Aggregate above PostgreSQL integer range

Two actual transactions of `2_147_483_647` cents each were written and read through the dashboard query. The returned balance was exactly `4_294_967_294` cents. The potential int4 aggregation concern was ruled out for this tested case and is not an audit finding.

## Coverage and limits

| Area | Review coverage |
| --- | --- |
| Routes and framework | Public/protected pages, Proxy, API handlers, layouts, loading/error boundaries, installed Next.js guides |
| Identity and permissions | Auth.js configuration/adapter, sessions, invitations, bootstrap, role checks, recent authentication, host policy |
| Ledger | Input schemas, money/date utilities, transaction operations, idempotency, financial service, dashboard queries, pagination |
| Team administration | Team/group actions, membership approval/revocation, ownership, disable/restore, quarantine and purge |
| User interface | Dashboard and forms, group controls, administration console, UI primitives, styling and confirmation behavior |
| Persistence | Prisma schema, seven migrations, PostgreSQL constraints, audit immutability, integration/concurrency suites |
| Operations | Build/runtime packaging, migration/test launchers, incident scripts, maintenance commands, CI and dependency automation |
| Documentation | README, environment template, agent instructions, both historical audits |

No claim is made about real Google account callbacks, production ingress/TLS/IAM, PostgreSQL runtime grants, branch protection, backup restoration, external log/alert delivery, or production performance. Local PostgreSQL 18 results do not replace the repository's PostgreSQL 17 CI run. The async transition callbacks that discard a promise were investigated but not reported as bugs because Next.js Server Action dispatch may independently retain pending state; no actual transport failure was established.
