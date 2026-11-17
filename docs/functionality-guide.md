# Money Tracker Functionality Guide

Updated 17 November 2026.

Money Tracker gives teams a shared BDT ledger with controlled access. Approved members can review their team's balance and history. Approved team Admins and Moderators can record money and approve join requests. Global Admins manage application admission, accounts, team creation, and team lifecycle.

This guide describes the current functionality and permission boundaries. It does not report test results or deployment qualification.

## New functionality in this iteration

- Search transaction notes across the full authorized ledger, combine money direction and Asia/Dhaka date filters, and see totals for every matching entry.
- Use one transaction entry panel with explicit editing, pending, confirmed, recoverable-failure, and outcome-unknown states. Drafts and original retry keys stay in memory for the same actor and team during client-side navigation, including Back and Forward.
- Use consistent **Teams**, **Global role**, **Team role**, and **Owner** labels, separate Teams task views, and a bounded switcher containing approved active teams only.
- Open one administration task at a time, review contextual confirmations, return from recent-sign-in recovery without automatic mutation replay, and copy invitation access instructions.

Draft memory is temporary. It does not use persistent browser storage and does not survive a hard reload, closing the page, or a full sign-out/reauthentication flow.

## Screens and navigation

| Screen | Route | Functionality |
| --- | --- | --- |
| Home | `/` | Introduces the shared ledger and provides sign-in or Teams navigation. |
| Sign in | `/login` | Starts Google sign-in and explains invitation requirements, sign-in limits, and temporary protection failures. |
| Sign-in recovery | `/auth-error` | Explains an unsuccessful sign-in and offers a route back to sign in. |
| Teams | `/groups` | Provides Your teams, Discover, Your requests, and permitted Approvals views. Global Admins also have separate creation and management sections. |
| Dashboard entry | `/dashboard` | Opens an approved team, preferring a team the user manages, or returns the user to Teams. |
| Team ledger | `/dashboard/[teamId]` | Shows the current balance, all-time totals, searchable history, matching totals, and permitted transaction entry. |
| Administration | `/admin` | Provides separate Accounts, Invitations, Team access & ownership, and Team recovery tasks for Global Admins. |

The public interface calls workspaces **Teams**. The existing `/groups` route and some internal group identifiers remain for compatibility.

Authenticated pages share responsive navigation, the current global-role label, and sign-out. Administration appears for Global Admins. The team switcher offers links to approved active teams and shows Team role and Owner separately. It loads at most 20 options per request and offers **Load more teams** when more are available. The active team remains identified even when it is outside the first options page. Pending, revoked, and quarantined teams are excluded.

Navigation visibility does not grant permission. The server derives the actor from the session and checks the active account, team state, and required membership again for protected reads and changes.

## Roles and permissions

### Global roles

| Global role | Authority |
| --- | --- |
| Admin | Can enter Administration, create and quarantine teams, manage invitations and eligible accounts, change global roles, revoke memberships, transfer ownership, and restore eligible teams. |
| Moderator | Uses teams through approved team memberships. This global role does not grant Administration access or team creation/quarantine authority. |
| Member | Uses teams through approved team memberships and can request access to discoverable teams. |

### Team roles and ownership

These permissions require an active account, an active team, and an **approved membership in that team**.

| Team role | View balance and history | Record additions or removals | Approve join requests |
| --- | --- | --- | --- |
| Admin | Yes | Yes | Yes |
| Moderator | Yes | Yes | Yes |
| Member | Yes | No | No |

A Global Admin still needs an appropriate approved team membership to read or change its ledger. A global role does not grant membership-approval authority by itself. View-only members receive an explanation of their access instead of an editable transaction form.

**Owner** identifies custody of a team; it is separate from both role scopes. Creating a team makes its creator the owner and an approved team Admin. Changing a global role does not transfer ownership or change a team role. Administration's role editor changes global roles and is not a general team-role editor.

## Sign in and application admission

A Global Admin provisions application access for the intended Google email with a 1, 7, 14, or 30-day invitation. On first admission, Google must supply a verified matching email and the invitation must still be valid. The account becomes active and the invitation is consumed. Existing active users can sign in again without a new invitation.

Application admission and team approval are separate. A newly admitted account without memberships can discover teams and request access; it cannot read a team's balance, history, or transaction notes before approval.

| Account state | Meaning |
| --- | --- |
| Pending | The identity has been provisioned and must complete valid invited admission. |
| Active | The account may sign in and use features allowed by its roles and memberships. |
| Disabled | Access is blocked and application sessions are revoked. A Global Admin can re-enable an eligible account. |
| Deleted | Access is blocked. This lifecycle state is not a self-service account deletion screen. |

Sessions have an absolute eight-hour lifetime. A new successful Google sign-in revokes older application sessions, including sessions on other devices. Re-enabling an account does not restore old sessions; the user must sign in again.

Sensitive administration changes, invitation changes, quarantine, and restoration require a Google sign-in within the preceding 15 minutes. Ordinary transaction entry and membership approval use their normal account/team checks without this additional freshness requirement.

When sensitive action feedback requests recent authentication, **Sign in again** signs out the current application session and leads back through Google sign-in. The return location is restricted to supported internal pages and task parameters. Returning to the task does not restore sensitive form input or run the original change. Review the current target and explicitly confirm a new attempt.

## Teams task views

Teams loads the selected task's collection rather than stacking every collection on one page. Each view has independent cursor pagination, with at most 20 displayed records per page. Switching tasks preserves their navigation state. **Shown on this page** describes displayed records rather than an application-wide total.

| View | Contents and available actions |
| --- | --- |
| Your teams | Active teams with approved memberships, Team role, Owner where applicable, and **Open team** links. |
| Discover | Active teams for which the current account has no membership. Shows team name and description with **Request to join**; it does not preview financial data. |
| Your requests | The account's pending requests to active teams, with an explanation that a team Admin or Moderator must approve access. |
| Approvals | Pending requests for active teams the viewer manages through an approved team Admin or Moderator membership. This view is unavailable without that authority. |

Without an explicit selected view, approved membership leads to Your teams; otherwise a pending request leads to Your requests; an account with neither starts in Discover. First-admission guidance explains: **Your account is active. Request access to a team to view its ledger.**

Empty feedback distinguishes having no teams or requests from reaching an empty later page. Pagination provides **First page** and **Next page** as applicable. An action-needed indicator identifies incoming approvals without presenting it as an exact global count.

### Request and approve team access

1. Open **Teams → Discover** and choose **Request to join** for the intended team.
2. Follow it in **Your requests** while it is pending.
3. An approved team Admin or Moderator opens **Approvals** and selects **Approve request**.
4. The approved member can open the ledger from **Your teams** or the team switcher.

New requests use the Member team role. Repeated requests do not create duplicate memberships. Pending membership grants no ledger access, and a revoked membership cannot submit a fresh request to bypass revocation. Approval preserves the request's team role. There is no request rejection or cancellation control in the current interface.

### Creation and management

Only Global Admins have the **Create team** section on Teams. Names must be unique and contain 3–80 characters; optional descriptions allow up to 240 characters. Creation establishes ownership and approved team Admin membership for the creator.

Quarantine actions are placed in a separate **Team management** section. They are not mixed into ordinary discovery or membership approval. The quarantine and recovery rules are described below.

## Current balance and transaction history

The team ledger identifies the team and the viewer's Team role. Its primary figure is:

`Current balance = all money added − all money removed`

**Total added · all time** and **Total removed · all time** also cover the complete authorized team ledger. These three figures do not change meaning when history filters are applied, and they are not calculated from the rows currently loaded in the browser.

History shows transaction date, note or **No note provided**, Added/Removed direction, recorded-by name, and a signed BDT amount. Larger screens use a semantic table; smaller screens use transaction cards. Ordering is transaction date descending, then creation time descending, then transaction ID descending to resolve ties consistently.

The initial page contains up to 25 matching entries. **Load more transactions** retrieves subsequent bounded pages. **25 loaded**, for example, means rows currently displayed, not every entry in the team ledger or every search match. Pending pagination retains keyboard focus, guards repeated requests, and announces loaded counts. When the last page removes the button, its focused user is moved to the completion message without scrolling the page.

**Last refreshed** shows the snapshot time in Asia/Dhaka. **Refresh dashboard** requests current authorized data; the interface has no live subscription. Another writer's changes become visible on refresh or a subsequent history request.

### Search and filters

Search runs on the server across the full authorized team ledger, including entries not yet loaded in history. On smaller screens, **Search and filters** opens the controls in an accessible dialog; on larger screens they appear directly above history.

| Control | Behavior |
| --- | --- |
| Search notes | Matches a literal, case-insensitive substring of transaction notes. Text is trimmed and limited to 120 characters. Characters such as `%`, `_`, and backslash are ordinary text, not wildcards. It does not search amount, actor name, or other teams. |
| Money direction | All directions, Money added, or Money removed. |
| All time | Applies no transaction-date restriction. |
| This month | Includes the first day of the current Asia/Dhaka calendar month through today there. |
| Last month | Includes the entire preceding Asia/Dhaka calendar month, including year transitions. |
| Custom date range | Requires real From and To dates, includes both endpoints, and rejects reversed ranges and dates after today in Asia/Dhaka. |

Use **Apply filters** to request the selected view. Active filters are stated above history. **Clear filters** requests the unfiltered ledger again. Invalid filters receive field or general feedback, and a failed read keeps the previous displayed results rather than replacing them with empty data.

With active filters, **Matching transactions** reports the matching count, Money added, Money removed, and **Net change · matching only** across **all** matching entries. These values are independent of how many history pages have been loaded. Matching net change is not the team's current balance.

An empty ledger says **No transactions yet**. An existing ledger with no matches says **No matching transactions** and suggests adjusting or clearing filters. Neither state changes the stored entries.

### Filter privacy and navigation

Direction, period, and custom date bounds may appear in the dashboard URL. These validated navigation parameters can be revisited using Back and Forward. Note-search text is sent as Server Action POST data and stays in the current page's memory; it is not placed in the URL or browser history state, persistent browser storage, or application log context. A copied link or hard reload does not restore the private note search. Back and Forward between filter URLs retain the current in-memory search while applying the URL's safe date/direction state.

Transaction draft values and operation keys are also excluded from URLs and persistent browser storage. Draft memory has a separate actor/team scope and lifetime, described below.

### Snapshot consistency

A dashboard read returns all-time amounts, matching totals, and the matching first page as one coherent authorized snapshot. Pagination is scoped to the actor, team, normalized filters, and snapshot generation. If the ledger or matching view changes before an older-page request, the response does not append an incompatible page: the dashboard requests a new snapshot and announces that history has reset to the newest matching first page.

A confirmed new transaction triggers this authoritative refresh and resets previously loaded pages. A backdated entry, or an entry excluded by active filters, can be outside the visible first page; feedback explains that the balance includes it and suggests clearing filters or loading older entries. Replaying an already committed operation does not create a new entry, and an unchanged snapshot can retain loaded pages. Delayed responses from an older view or a different team cannot append into the current history.

If the transaction is confirmed but the follow-up read fails, feedback distinguishes **saved** from **could not refresh**. The displayed balance and history remain the previous snapshot until a later refresh succeeds.

## Recording money

Approved team Admins and Moderators choose **Add money** or **Remove money** to open the same transaction entry panel. A fresh draft starts with the chosen direction; an existing draft resumes without silently changing its direction or entered amount. The panel names the destination team. Closing it keeps the draft, and **Resume draft** reopens it.

1. Review the team and money direction.
2. Enter a positive **Amount in BDT**.
3. Choose the transaction date.
4. Add an optional note.
5. Select **Save addition** or **Save removal** and wait for confirmation.

| Field | Accepted input |
| --- | --- |
| Direction | Add money or remove money; the amount itself remains positive. |
| Amount | BDT 0.01 through BDT 21,474,836.47 per transaction, with up to two decimal places. Plain digits or correctly grouped three-digit comma separators are accepted, such as `1250.50` or `1,250.50`. |
| Transaction date | A real `YYYY-MM-DD` calendar date from `0001-01-01` through today in Asia/Dhaka. Future dates are rejected. |
| Note | Optional text, up to 240 characters after trimming, with a character counter. |

Transaction dates remain calendar dates across browser time zones, including years below 100. Operational timestamps, such as invitation expiry and quarantine deadlines, are displayed as Asia/Dhaka business time.

### The five entry states

| State | What happens |
| --- | --- |
| Editing | Fields can be changed. Closing the panel retains meaningful input. A normal unsaved draft has an explicit discard confirmation. |
| Pending | The request is in flight; input and duplicate submission are blocked. The panel cannot be dismissed through its close controls while pending. |
| Confirmed | The server confirms the saved or replayed entry. The form clears its operation information, closes the panel, and refreshes the ledger snapshot. |
| Recoverable failure | Field or general feedback explains the problem. Entered values remain available for correction or retry. |
| Outcome unknown | The server response could not be confirmed and the entry may already exist. The original payload and operation key are retained; editing is blocked and the action becomes **Retry unchanged addition** or **Retry unchanged removal**. |

An unchanged retry uses the original key and payload. If the entry already committed, the server returns that entry instead of inserting a duplicate. Reusing an operation key with different details is rejected. Starting a different operation with a fresh key is not duplicate detection for a previously uncertain entry; resolve the original operation before recording it again.

### Draft and retry-key lifetime

The root workspace provider keeps transaction drafts in an in-memory store, keyed by an opaque actor/team scope. This retains the team's fields, submission state, uncertain payload, and original retry key across closing/reopening the panel, client-side route changes, switching teams, and Back/Forward within the same running application page. A different actor or team cannot inherit the stored operation. A retired form cannot overwrite the memory owned by a newer form.

If a pending form is left during client-side navigation and its response is not confirmed, reopening treats it as outcome unknown rather than offering a fresh write. A later confirmed result can clear that operation's memory. Returning to a team does not automatically resubmit a transaction.

Memory is not persistent storage. Hard reloads, closing the page, and full sign-out/reauthentication flows can lose it; the application does not promise recovery of drafts or operation keys afterward. When unresolved drafts exist, a page-unload handler requests the browser's native leave warning. Browser behavior controls whether that warning is shown.

Sign-out and **Sign in again** show an explicit draft-discard confirmation when necessary. An unknown-outcome warning explains that the transaction may already be saved and that discarding loses the original retry information. While an entry is reported as Pending, the session-leave confirmation is disabled. Confirming clears draft memory before the session-navigation request, even if that request later fails. This confirmation never submits a financial transaction. If retry information has been lost, review the authoritative team ledger before recording the same entry again.

### Financial rules

Financial calculations use integer cents. Removals cannot make the current team balance negative, including when multiple writers submit concurrently. Application workflows append entries; there are no transaction edit, delete, or undo controls. Saved attribution snapshots preserve the recorded actor's identity if the live user reference later disappears.

## Administration task views

Only an active Global Admin can enter Administration. It opens **Accounts** by default and loads only the selected task's main collection. Each view has its own server-side search and pagination state, preserved when switching views. Searches operate on the authorized collection, not merely the records displayed on the current page. Account and invitation pages show up to 25 records; team pages show up to 20, with bounded member pages of up to 25.

| Task | Functionality |
| --- | --- |
| Accounts | Search accounts, inspect Global role and account status, see ownership blockers, disable or re-enable eligible accounts, and review global-role changes. |
| Invitations | Search invitations, provision or revoke eligible invitations, and share access instructions after successful provisioning. |
| Team access & ownership | Search active teams, inspect Owner and Team role/status, page through members, revoke eligible memberships, and transfer ownership. |
| Team recovery | Search quarantined teams, inspect quarantine and recovery deadlines, and restore eligible teams. Expired retention is explained as an operator review. |

Empty and no-results messages belong to the selected task. Team recovery is separate from ordinary membership access management. Administration search parameters are independent task-navigation state; the private transaction-note search follows the memory-only policy above.

### Contextual confirmations

Sensitive administrative changes open a confirmation dialog that identifies the target and consequences before the mutation runs. Ownership transfer, restoration, and quarantine also require the exact team name. Pending controls prevent repeated confirmation. The server rechecks recent sign-in, current permissions, ownership protection, and target state for the actual attempt.

| Change | Result and conditions |
| --- | --- |
| Provision an invitation | Records normalized Google-email admission with a selected expiry. A still-valid existing invitation retains its actual expiry; eligible expired or revoked admission can be reissued. An already active account needs no new invitation. |
| Revoke an invitation | Prevents that pending invitation from admitting the account; it does not disable an already admitted account. |
| Disable an account | Blocks access and revokes sessions. Team ownership must be resolved first, including ownership retained by quarantined teams. |
| Re-enable an account | Restores eligible disabled-account access; the user must sign in again. |
| Change a global role | Assigns Admin, Moderator, or Member and revokes affected sessions. At least one active Global Admin must remain. |
| Revoke team membership | Removes access and revokes the affected user's sessions. The owner's membership is protected until ownership is transferred. A displayed member or an eligible target identified by email can be selected. |
| Transfer ownership | Requires an active team and active approved target member. The target becomes Owner and team Admin; both owners' sessions are revoked. The previous owner's membership and team role remain unless changed through a separately supported operation. No global role is granted. |
| Restore a team | Returns an eligible quarantined team with its ownership, memberships, approvals, and ledger intact, before the recovery deadline. |

Sensitive changes append administrative audit events. If recent authentication is missing, the interface offers the explicit sign-in recovery described above. No original administrative mutation is automatically replayed after sign-in.

### Copy invitation access instructions

The invitation form uses **Google account email**, **Valid for**, and **Review invitation** before **Confirm invitation**. A newly created invitation returns **Invitation created. No email has been sent.** The result shows the normalized intended email, the actual invitation expiry in Asia/Dhaka, and a trusted sign-in address derived from configured deployment identity.

**Copy access instructions** copies the sign-in URL, intended Google account, actual expiry, and the separate Teams request/approval steps. The instructions state that Money Tracker has sent no email. The administrator must communicate them to the intended person. Clipboard failure reveals a selectable text fallback; instructions can also be selected directly.

The application does not invent a sign-in address from an arbitrary request host. If it cannot resolve a trusted canonical address, provisioning reports the configuration problem instead of returning misleading instructions. Copying instructions neither sends an email nor approves any team membership.

## Quarantine and recovery

Quarantine removes a team from normal use while retaining its data for a 30-day recovery window.

1. A recently signed-in Global Admin opens **Teams → Team management** and selects **Quarantine team**.
2. The confirmation identifies the team and requires its exact name.
3. Confirming quarantines it and removes normal access.
4. Before the deadline, a recently signed-in Global Admin can open **Administration → Team recovery**, enter the exact name, review the restoration confirmation, and restore it.

Quarantined teams are excluded from the switcher, normal Teams views, dashboard reads, transactions, history, and approvals. Memberships and ledger data remain stored. Team recovery displays quarantine time and the recovery deadline in Asia/Dhaka. Restoration eligibility is checked again when the change is confirmed.

Expiry does not automatically purge the data. After the retention deadline, the browser offers no permanent-purge action or enabled expired restoration. Permanent purge is an operator command requiring the prescribed exact confirmations and verified backup reference. See the [quarantine, restoration, and purge procedure](../README.md#team-quarantine-restore-and-permanent-purge).

Quarantined teams retain their Owner and can block account offboarding. Ownership transfer operates on active teams. A team within its recovery window can be restored before custody is resolved; expired quarantine requires supported operator retention review. These ownership protections are not bypassed by hiding a control.

## Loading, recovery, and interaction

Route loading panels, first-use guidance, task-specific empty states, no-results messages, pending controls, and retry/navigation actions explain the current state. A missing route has a return path. Route error boundaries provide retry controls and relevant navigation without displaying database or authentication internals.

Forms use persistent labels, associated validation feedback, and visible keyboard focus. Financial direction is conveyed by text, signs, and icons as well as color. Dialogs constrain focus, prevent background interaction, and restore focus on close. Layouts adapt between mobile cards and desktop tables, retain full amounts and currency labels, and accommodate reduced motion. These are implementation features, not a formal accessibility conformance claim.

Request limits can temporarily pause sign-in, reads, or changes. Examples include 20 Google sign-in starts per five minutes per trusted IP, 60 transaction submissions per minute per user, 90 history reads per minute per user, and 45 Teams enumeration requests per minute per user. Feedback gives a retry interval where available. When required request protection is unavailable, the protected operation stops and asks the user to retry later.

## Operational functionality

These capabilities support operators and maintainers rather than adding user navigation screens.

| Capability | Purpose |
| --- | --- |
| `/api/health` | Reports application liveness independently of PostgreSQL. |
| `/api/ready` | Runs a bounded database readiness probe through an isolated connection; concurrent probes share in-flight work. |
| Administrative audit records | Preserve append-only action, actor/target snapshots, timestamps, and correlation information through lifecycle changes. |
| Structured logs and references | Support investigation with controlled messages and correlation references; financial form/search text is excluded from log context. |
| `db:bootstrap-admin` | Explicitly establishes the configured administrator identity. |
| `db:cleanup-rate-limits` | Removes expired durable limiter buckets. |
| `db:revoke-all-sessions` | Performs deliberate incident-response session revocation with required confirmations. |
| `db:purge-team` | Permanently removes an eligible quarantined team under the retention and backup procedure while preserving its independent audit record. |

The [README](../README.md) contains environment, migration, deployment, backup, and operator procedures. This guide describes available functionality and does not certify a particular deployment or report verification outcomes.

## Source reference

| Functionality | Main implementation |
| --- | --- |
| Authentication, admission, and session lifetime | [Authentication](../src/lib/auth.ts), [invitations](../src/lib/invitations.ts), [session adapter](../src/lib/auth-adapter.ts), [authentication actions](../src/actions/authentication.ts) |
| Shared navigation and approved-team switcher | [Workspace header](../src/components/system/workspace-header.tsx), [switcher](../src/components/system/team-switcher.tsx), [navigation action](../src/actions/team-navigation.ts) |
| Teams tasks, requests, and approvals | [Teams page](../src/app/groups/page.tsx), [task queries](../src/lib/queries/teams.ts), [group actions](../src/actions/groups.ts), [task navigation validation](../src/lib/validators/teams-view.ts) |
| Ledger filters, summaries, and snapshots | [History filter contract](../src/lib/history-filters.ts), [dashboard queries](../src/lib/queries/dashboard.ts), [dashboard actions](../src/actions/dashboard.ts), [dashboard shell](../src/components/dashboard/dashboard-shell.tsx) |
| Transaction panel, memory, and retries | [Transaction form](../src/components/dashboard/transaction-form.tsx), [draft memory provider](../src/components/dashboard/transaction-draft-memory.tsx), [operation keys](../src/lib/transaction-operation.ts), [root providers](../src/components/providers.tsx) |
| Financial and date rules | [Transaction actions](../src/actions/transactions.ts), [financial service](../src/lib/data/transactions.ts), [transaction validation](../src/lib/validators/transaction.ts), [money](../src/lib/money.ts), [dates](../src/lib/date-time.ts) |
| Administration, ownership, and access instructions | [Admin console](../src/components/admin/admin-console.tsx), [task navigation](../src/lib/admin-navigation.ts), [admin actions](../src/actions/admin.ts), [admin workflows](../src/lib/admin-workflows.ts), [access instructions](../src/lib/access-instructions.ts) |
| Reauthentication without mutation replay | [Safe return locations](../src/lib/auth-return.ts), [sign-in-again control](../src/components/auth/reauthenticate-button.tsx) |
| Quarantine and restoration | [Team lifecycle](../src/lib/team-lifecycle.ts), [quarantine interaction](../src/components/groups/delete-team-button.tsx) |
| Readiness and request protection | [Readiness](../src/lib/readiness.ts), [rate limits](../src/lib/rate-limit.ts), [authentication starts](../src/lib/authentication-start.ts) |
