# Money Tracker Usability Implementation Plan

17 November 2026. This iteration builds on the current functionality guide and the existing, uncommitted remediation work. Historical reports remain unchanged.

## Baseline

Eight desktop/mobile captures of the current standalone application are in [screenshots/before](screenshots/before). They use synthetic fixtures in the guarded, disposable PostgreSQL 17 database. The source baseline was fingerprinted before application edits; private environment files were excluded.

The rendered dashboard makes the always-visible entry form compete with history and provides no way to search older notes. The mobile Teams page stacks unrelated membership, discovery, requests, approvals, and management tasks into one long page. Navigation mixes Groups and Teams and has no bounded team switcher. Administration opens with invitations and loads other collections that are below the fold, even when the administrator needs an account or custody action. The current invitation response gives no copyable access instructions.

## Stages

1. Standardize workspace terminology on Teams while preserving `/groups`. Add a compact shared shell and an authorized, paginated team switcher. Separate Your teams, Discover teams, Your requests, and Approvals with independent server pagination and useful admission states.
2. Give the ledger the full dashboard width. Use one retained transaction form in the existing accessible dialog primitive, with direction preselected, explicit submission states, safe retry, and per-team draft retention through SPA navigation. Warn before discarding drafts through session navigation or document exit.
3. Add a normalized, validated history-filter contract. Share its database predicate across literal note search, date/direction filtering, matching counts/totals, and paginated history. Keep all-time balances separate. Extend coherent snapshots and cursor/request scope to filters; preserve search text in memory only.
4. Split Administration into independently queried task views. Return persisted invitation details and trusted access instructions; add copy fallback, explicit privileged confirmations, and supported reauthentication without automatic mutation replay.
5. Verify financial/authorization invariants, browser navigation/races, panel retry/close behavior, invitation/reauth flows, responsive layouts, native zoom, and the final standalone artifact. Update the functionality guide and record actual outcomes, screenshots, query-plan decisions, and external limitations.

## Boundaries and verification

The existing financial service, Auth.js/session policy, server authorization, CSRF/host checks, rate limits, audit writes, ownership rules, and quarantine retention remain authoritative. No dependency change or schema redesign is planned. An additive index will be considered only if measured query plans justify it.

Use Node 22.22.2, npm 11.11.0, and the separately verified disposable PostgreSQL 17 target. Add focused tests with each stage, then run applicable unit/integration/authorization/browser suites, lint, type checking, builds, Proxy and pruned-runtime checks. Browser evidence must use the real Server Action flow and synthetic data; screenshots and local checks do not establish hosted deployment, real Google callbacks, or formal accessibility certification.
