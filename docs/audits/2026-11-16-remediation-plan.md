# Money Tracker remediation plan

This plan addresses the nine open findings in the [16 November project audit](2026-11-16-project-audit.md). It describes proposed work; no application fixes were applied during the audit.

## Implementation order

| Order | Finding | Work | Completion criteria |
| --- | --- | --- | --- |
| 1 | AUD-001 | Upgrade affected runtime/framework dependencies, then development tooling; refresh the lockfile and reassess overrides | Both dependency audits clear, or each remaining entry has a documented applicability decision accepted by the project owner; both builds, database suites, and final runtime smoke pass |
| 2 | AUD-002 | Reconcile refreshed dashboard history with client pagination state | First save appears immediately without reload; later saves appear after pagination; refresh cannot append an old in-flight page into a newer snapshot |
| 3 | AUD-003 | Add an absolute session deadline based on immutable creation time | Refresh never extends a session beyond eight hours; lookup rejects it at the boundary; cookies and returned session expiry respect the same cap |
| 4 | AUD-004 | Apply shared OAuth-start limits to every public sign-in path | A direct HTTP client with valid CSRF is denied over quota; UI sign-in is charged once; unavailable limiter/client-IP states fail according to policy |
| 5 | AUD-005 | Replace inline confirmation overlay with an accessible viewport modal | Overlay covers the viewport; Tab stays inside; Escape and focus restoration work; confirmation remains visible on small screens and tall group lists |
| 6 | AUD-007 | Bound readiness database work and concurrent probes | Query/connection deadlines free resources; repeated failed probes do not starve a normal query; liveness remains independent of PostgreSQL |
| 7 | AUD-006 | Preserve accepted years through write normalization | `0001`, `0099`, and `0100` round-trip unchanged, or a documented lower bound rejects unsupported years before persistence |
| 8 | AUD-009 | Make the browser proxy compatible with canonical authentication | The supported local launcher and CI-managed topology both pass; unexpected real request hosts remain rejected |
| 9 | AUD-008 | Format extreme money totals without losing the remainder | Exact cents remain visible near the maximum supported aggregate, including signed formatting |

## Suggested change boundaries

Keep dependency remediation in its own change. Upgrade Next.js and `eslint-config-next` together, inspect installed upgrade guides, and review Auth.js adapter/session behavior after updating. The audit snapshot suggested Next.js `16.4.6`; resolve current advisories again when implementing rather than treating that version as a permanent security target.

Handle the dashboard repair separately because the choice between resetting history and retaining loaded pages changes user-visible behavior. Define the snapshot/cursor policy first, then test actual Server Action transport. A test that only confirms a database row exists does not establish that the user sees it.

Session expiry and sign-in limiting can share authentication review but need independent regressions. Preserve token hashing, inactive-account rejection, concrete-user authorization checks, invitation admission, and recent authentication. The existing session creation timestamp can support the absolute deadline without replacing the adapter's token mapping.

The modal, date normalization, readiness, browser fixture, and exact-formatting changes can be reviewed independently. Avoid broad refactoring while resolving these defects.

## Verification after fixes

Run lint and strict type checking after each relevant change. Add focused regressions for the failing behavior, then run the affected suites. At release qualification, use the pinned toolchain and a separately provisioned disposable PostgreSQL 17 target to run schema validation, unit, integration, authorization, and HTTP/browser E2E checks. Build with both bundlers and verify the Proxy manifest after each. Verify the pruned standalone artifact, start that artifact, and repeat its production smoke checks.

Re-run both dependency audits after lockfile changes. Maintain a dated record of the results and distinguish root package-graph findings from packages actually shipped in the standalone artifact. Test real Google sign-in and callback configuration in the intended deployment environment.

## Operational decision to resolve

Quarantined team ownership can block account offboarding: user-disable checks include owned quarantined teams, while ownership transfer accepts active teams only. After the restoration deadline, an owner may need offline permanent purge before being disabled. This follows the documented ownership invariant, so it is not counted as a confirmed defect. Decide whether incident response requires immediate identity disable while retaining ownership history, then define a supported custody-transfer or quarantine exception if needed. Relevant code: [admin-workflows.ts:264](../../src/lib/admin-workflows.ts#L264), [line 867](../../src/lib/admin-workflows.ts#L867), and [line 1166](../../src/lib/admin-workflows.ts#L1166).
