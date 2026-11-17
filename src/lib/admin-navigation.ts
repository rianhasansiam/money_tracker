export const ADMIN_VIEWS = ["accounts", "invitations", "access", "recovery"] as const;
export type AdminView = (typeof ADMIN_VIEWS)[number];

export const ADMIN_VIEW_LABELS: Record<AdminView, string> = {
  accounts: "Accounts",
  invitations: "Invitations",
  access: "Team access & ownership",
  recovery: "Team recovery",
};

const QUERY_KEYS: Record<AdminView, string> = {
  accounts: "accountsQ", invitations: "invitationsQ", access: "accessQ", recovery: "recoveryQ",
};
const CURSOR_KEYS: Record<AdminView, string> = {
  accounts: "userCursor", invitations: "invitationCursor", access: "teamCursor", recovery: "recoveryCursor",
};

export interface AdminNavigationState {
  view: AdminView;
  queries: Record<AdminView, string>;
  cursors: Partial<Record<AdminView, string>>;
  memberTeamId?: string;
  memberCursor?: string;
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export function readAdminNavigation(values: Record<string, string | string[] | undefined>): AdminNavigationState {
  const view = ADMIN_VIEWS.find((candidate) => candidate === values.view) ?? "accounts";
  const queries = Object.fromEntries(ADMIN_VIEWS.map((candidate) => [
    candidate, single(values[QUERY_KEYS[candidate]] ?? (view === candidate ? values.q : undefined)).trim().slice(0, 254),
  ])) as Record<AdminView, string>;
  const cursors = Object.fromEntries(ADMIN_VIEWS.flatMap((candidate) => {
    const value = single(values[CURSOR_KEYS[candidate]]).slice(0, 254);
    return value ? [[candidate, value]] : [];
  }));
  return {
    view, queries, cursors,
    memberTeamId: single(values.memberTeamId).slice(0, 32) || undefined,
    memberCursor: single(values.memberCursor).slice(0, 254) || undefined,
  };
}

function adminNavigationParams(state: AdminNavigationState) {
  const params = new URLSearchParams({ view: state.view });
  for (const view of ADMIN_VIEWS) {
    if (state.queries[view]) params.set(QUERY_KEYS[view], state.queries[view]);
    if (state.cursors[view]) params.set(CURSOR_KEYS[view], state.cursors[view]!);
  }
  if (state.memberTeamId) params.set("memberTeamId", state.memberTeamId);
  if (state.memberCursor) params.set("memberCursor", state.memberCursor);
  return params;
}

export function adminViewHref(state: AdminNavigationState, view = state.view) {
  return `/admin?${adminNavigationParams({ ...state, view })}`;
}

export function resetAdminViewPage(state: AdminNavigationState, query = state.queries[state.view]) {
  return {
    ...state,
    queries: { ...state.queries, [state.view]: query },
    cursors: { ...state.cursors, [state.view]: undefined },
    ...(state.view === "access" ? { memberTeamId: undefined, memberCursor: undefined } : {}),
  };
}

export function adminSearchFields(state: AdminNavigationState) {
  const params = adminNavigationParams(resetAdminViewPage(state));
  params.delete(QUERY_KEYS[state.view]);
  return { name: QUERY_KEYS[state.view], hidden: Array.from(params.entries()) };
}
