# Money Tracker Usability Results

17 November 2026, Asia/Dhaka. This iteration extends the existing working tree; it does not replace the earlier remediation. Changes are uncommitted and have not been deployed. The [functionality guide](../functionality-guide.md) describes the resulting product behavior.

## Implemented workflows

| Area | Result | Regression evidence |
| --- | --- | --- |
| Teams and navigation | Consistent Teams labels retain `/groups`. Your teams, Discover, Your requests, and Approvals load their own authorized collections. Admission guidance distinguishes account activation from team approval. Creation and quarantine management are separate from opening a team. | Teams unit/query tests, four Teams browser workflows, and the preserved critical lifecycle workflow. |
| Approved team switcher | Uses bounded, authorized pages of active approved memberships. Team role and Owner are explicit; pending, revoked, and quarantined teams are excluded. | Browser traversal from 20 to 26 approved options, exclusion checks, final-page keyboard focus, and server authorization regressions. |
| Ledger and entry | History occupies the full dashboard width. One retained entry form opens in the existing native dialog with the requested direction, target team, note counter, inline errors, and explicit save states. All-time figures remain authoritative. | Twelve dashboard browser workflows cover first save, duplicate clicks, rejected/pending writes, backdating, retry, navigation, focus, and viewport shrink. |
| Draft and uncertain-write recovery | Drafts are isolated by opaque actor/team scope in the existing root provider's memory. Panel closure, team switching and SPA Back/Forward retain them. Unknown outcomes lock the original payload/key for unchanged retry, even after another failed attempt. Session exit requires explicit discard when needed. | Real committed-response loss followed by panel closure, another team, browser Back, a rejected retry, and successful replay without a second row. Separate draft and sign-out tests plus cache ownership tests. |
| History discovery | Literal note search covers the whole authorized ledger. Direction, Dhaka month/custom date filters and matching count/added/removed/net totals share one predicate. All-time balance remains distinct. | Eight real browser workflows and seven new PostgreSQL integration tests; focused filter, cursor, query and action unit tests. |
| Administration | Accounts, Invitations, Team access & ownership, and Team recovery have independent server search/page state. Hidden task collections are not fetched. Sensitive actions show target/consequences before explicit confirmation. | Query-call assertions, selected-task PostgreSQL tests, administration browser flows and original role/lifecycle regressions. |
| Invitations and reauthentication | Results show normalized email, persisted expiry and truthful no-email copy. Trusted access instructions have clipboard and selectable-text paths. Sign in again uses the supported sign-out/Google flow with validated internal return state and no mutation replay. | Browser clipboard denial, actual stored-expiry comparison, server sign-out/provider initiation and fresh synthetic-session return requiring a new confirmation. |
| Responsive interaction | Compact shell, desktop table/mobile cards, mobile filter panel, viewport-aware entry/confirmation panels, labels, visible focus and reduced motion reuse existing primitives and tokens. | The responsive matrix, actual Chromium 200% zoom, focus/scroll assertions, quarantine pending/failure checks and controlled loading/error/retry. |

## Architectural decisions

**One filter contract:** [history-filters.ts](../../src/lib/history-filters.ts) validates and normalizes direction, date periods, inclusive custom dates and up to 120 trimmed search characters. Notes use case-insensitive literal substring matching; `%`, `_` and backslash are escaped as literal text and remain bound Prisma parameters. [Dashboard queries](../../src/lib/queries/dashboard.ts) reuse the predicate for matching history and aggregates. No ledger is loaded into the browser to search or summarize it.

**Coherent snapshots:** each successful read returns whole-ledger totals, matching totals/count and the first matching page in one repeatable-read snapshot. The first page remains 25 entries; subsequent pages retain the existing maximum of 50 and deterministic date/creation-time/ID ordering. Signed cursors bind actor, team, normalized filter hash and revision, using a versioned HMAC purpose with the existing `AUTH_SECRET`. Every read rechecks the active account, active team and approved membership. Changed snapshots refresh rather than merge incompatible pages.

**Private search and safe navigation:** search is explicit Server Action POST data and React memory. URLs contain only validated direction, period and custom date bounds. Back/Forward reapplies those safe parameters with the current in-memory note search. Complete authoritative responses replace the displayed snapshot; generation and mounted-component guards reject late results. A confirmed write explicitly refreshes its current filter/search view, including truthful feedback for entries outside the filter or first page.

**Draft memory:** the small [draft memory boundary](../../src/components/dashboard/transaction-draft-memory.tsx) extends the existing React provider and stores only drafts the user has entered. It is not a new state-management dependency. Financial values and keys never enter URLs, history state, persistent storage or analytics. Each form claims ownership of its scope so late responses cannot erase a newer form's retry information. Returning does not submit anything. Explicit discard precedes session navigation; native document-exit warnings remain browser-controlled. There is no reload-safe recovery promise.

**One accessible panel:** [ConfirmationDialog](../../src/components/ui/confirmation-dialog.tsx) retains native top-layer focus/inert/background behavior and now accepts contextual labels and entry focus. It follows the visual viewport for smaller keyboard-visible areas. Initial entry focus is applied as the dialog opens rather than through a later focus call that could steal subsequent typing. Viewport geometry is prepared before opening and cleared on close so a previous mobile height cannot constrain a desktop reopening.

**Task-specific reads:** [Teams queries](../../src/lib/queries/teams.ts) and [administration queries](../../src/lib/admin-workflows.ts) fetch selected task collections only. Bounded existence reads support default views and action-needed indicators. Counts are labeled as displayed/loaded unless an authorized aggregate supplies an exact matching count. Global roles, Team roles, ownership, recent authentication and lifecycle decisions stay in server boundaries.

**Index review:** the [PostgreSQL plans](history-query-plans.json) use 3,067 synthetic ledger rows, including 67 in the target team. Representative filtered history and aggregate queries use the existing team/type index. This supports retaining the current indexes for this iteration; it is not a production throughput benchmark. Large per-team substring-search workloads may warrant a separately measured additive index later. No schema or migration changed.

## Before and after

All captures use synthetic users and ledger entries in the guarded disposable database. Comparison captures use the same sample team and a 900-pixel-high viewport; stress, recovery, modal and native-zoom states are separate.

| Screen | Before | After |
| --- | --- | --- |
| Desktop ledger | [Before](screenshots/before/dashboard-1440.png) | [After](screenshots/after/comparison/dashboard-1440.png) |
| Mobile Teams | [Before](screenshots/before/groups-390.png) | [After](screenshots/after/comparison/groups-390.png) |
| Desktop Administration | [Before](screenshots/before/admin-1440.png) | [After](screenshots/after/comparison/admin-1440.png) |
| Mobile sign-in | [Before](screenshots/before/login-390.png) | [After](screenshots/after/comparison/login-390.png) |

The [responsive measurements](screenshots/after/responsive-matrix.json) record 103 passing cases at 320, 390, 768, 1024 and 1440 pixels, including actual 200% browser zoom. They cover overflow, financial visibility, sampled contrast and control heights. The lowest sampled text contrast is 4.84:1 and the smallest measured primary control height is 44 CSS pixels; these samples are not a comprehensive accessibility certification. Screenshots were inspected rather than treated as proof solely because files were produced. Additional real captures show [filtered mobile history](screenshots/after/history-filtered-390.png), [filtered desktop history](screenshots/after/history-filtered-1280.png), [new-account admission guidance](screenshots/after/teams-first-admission-390.png), and [selectable invitation instructions](screenshots/after/invitation-access-instructions.png).

## Verification

Local toolchain: Node.js 22.22.2, npm 11.11.0, PostgreSQL 17.12, and the pinned Playwright/Chromium build on macOS arm64. Tests use the verified temporary `money_tracker_remediation_test` database, never an application database. Existing private environment files and applied migrations remain untouched.

| Check | Outcome |
| --- | --- |
| Schema validation | Passed: `npm run db:validate` |
| ESLint | Passed: `npm run lint` |
| TypeScript | Passed: `npm run typecheck` |
| Unit suite | Passed: `npm run test:unit`, 40 files / 379 tests |
| PostgreSQL integration suite | Passed: `npm run test:integration`, 7 files / 65 tests on PostgreSQL 17.12 |
| Authorization suite | Passed: `npm run test:authorization`, 5 files / 66 tests |
| Knip | Passed: `npm run knip` |
| Default Turbopack build, Proxy and pruned runtime | Passed: `npm run build`, 3 protected Proxy families, automatic prune/runtime verification and actual standalone startup |
| Webpack build, Proxy and pruned runtime | Passed: `npm run build:webpack`, `verify:proxy-manifest`, `runtime:prune` and `runtime:verify` |
| Canonical standalone E2E | Passed: canonical-host configuration on the final Webpack standalone artifact, 14 E2E + 33 browser tests; the default Turbopack artifact also passed 14 + 33 |
| Managed-host standalone E2E | Passed: managed-host configuration on the Webpack standalone artifact, 14 E2E + 33 browser tests |
| Full and production-only dependency audits | Passed: `npm audit --json` and `npm audit --omit=dev --json`, zero vulnerabilities in each graph |

Authorization results overlap unit coverage. Both E2E configurations run the documented test command against the actual pruned standalone artifact; synthetic session transport is test-only and never an application authentication path. The loopback fixture maps the framework's Server Action redirect header and the explicitly configured managed application origin, retaining navigation mode and leaving unrelated origins and ports untouched. Real request-host and CSRF protections remain independently exercised.

During verification, old presentation-dependent assertions were adapted to the task views, entry panel and semantic controls while retaining financial and permission assertions. Browser checks exposed and corrected deferred-focus stealing and retained modal viewport dimensions. Expanded rendered contrast coverage caught an active approvals badge at 4.06:1; an opaque surface now preserves readable contrast in both badge states. The final gates above describe the resulting implementation, not the earlier failing candidates. Machine-readable outcomes and log fingerprints are recorded in [verification-results.json](verification-results.json). Vitest's existing future CommonJS/native-config-loader warning is not suppressed.

## Changed files and configuration

The [iteration file inventory](changed-files.json) groups changes relative to the usability baseline, excluding pre-existing remediation changes. Main review areas are Teams/shell queries and components; dashboard filters/cursors/actions/entry/memory; invitation/admin/reauthentication; shared dialog behavior; focused regressions; the functionality guide, README and this evidence.

No dependency or lockfile change belongs to this iteration. No new production variable, database schema change or migration is required. Canonical access instructions use existing application identity settings; unavailable trusted configuration produces a controlled failure before an invitation is changed. Rotating the existing auth secret invalidates outstanding signed history cursors; reopening the team obtains a fresh first page and its current cursors.

The original BDT amount/date boundaries, exact integer-cent accounting, append-only ledger, insufficient-funds/concurrency protection, immutable attribution, idempotency, invitation admission, eight-hour sessions, prior-session revocation, recent-authentication policy, last-active-admin protection, ownership restrictions, append-only audit events and 30-day quarantine remain enforced. The unresolved quarantined-owner offboarding policy is unchanged. There is no new ledger edit/delete/undo, team-role editor, browser purge, live subscription, budgeting or charting feature.

## Remaining deployment and environment checks

| Unexecuted check | Blocker and next step |
| --- | --- |
| Hosted Linux CI and branch protection | This session runs locally. Execute the repository workflow on its PostgreSQL 17 service and require its quality gate before merge/release. |
| Real Google callback and deployed ingress | Local tests use synthetic identities and intercept the external provider destination. Verify invitation admission, provider callback, sign-out, canonical forwarding/TLS and safe return behavior in isolated staging with the actual OAuth application. |
| Physical mobile keyboard, assistive technology and additional browsers | Chromium viewport shrink, keyboard focus and native zoom are exercised locally; they do not reproduce every OS keyboard or screen reader. Verify supported mobile Safari/Chrome keyboard behavior and assistive-technology flows on real devices. |
| Production-sized note-search workloads | Recorded plans use a controlled synthetic fixture. Measure actual expected team cardinalities/selectivity and concurrent reads in staging before setting deployment performance expectations. |
| Deployment controls and recovery | Managed secrets, runtime grants, backups/restoration, ingress settings and log/alert delivery require the deployment environment and operator access. The UI iteration does not establish those controls. |

This record does not mark production release qualification complete.
