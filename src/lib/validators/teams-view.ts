import { z } from "zod";
import { collectionCursorSchema } from "@/lib/validators/pagination";

export const teamsViewSchema = z.enum(["teams", "discover", "requests", "approvals"]);
export type TeamsView = z.infer<typeof teamsViewSchema>;

export interface TeamsViewCursors {
  teams?: string;
  discover?: string;
  requests?: string;
  approvals?: string;
}

export interface TeamsLocation {
  view?: TeamsView;
  cursors: TeamsViewCursors;
}

const cursorParameters = {
  teams: "teamCursor",
  discover: "availableCursor",
  requests: "requestCursor",
  approvals: "approvalCursor",
} as const;

/** Only known task/cursor parameters can enter workspace navigation URLs. */
export function parseTeamsLocation(input: Record<string, string | string[] | undefined>): TeamsLocation | null {
  const view = input.view === undefined ? undefined : teamsViewSchema.safeParse(input.view);
  if (view && !view.success) return null;
  const cursors: TeamsViewCursors = {};
  for (const [key, parameter] of Object.entries(cursorParameters)) {
    const raw = input[parameter];
    if (raw === undefined) continue;
    const parsed = collectionCursorSchema.safeParse(raw);
    if (!parsed.success) return null;
    cursors[key as TeamsView] = parsed.data;
  }
  // The earlier combined membership page remains a safe legacy route input.
  // Its cursor is authorized again under the selected task's membership scope.
  if (input.membershipCursor !== undefined && !cursors.teams && !cursors.requests) {
    const legacy = collectionCursorSchema.safeParse(input.membershipCursor);
    if (!legacy.success) return null;
    cursors[view?.data === "requests" ? "requests" : "teams"] = legacy.data;
  }
  return { view: view?.data, cursors };
}

export function teamsPageHref(view: TeamsView, cursors: TeamsViewCursors = {}) {
  const params = new URLSearchParams({ view });
  for (const [key, parameter] of Object.entries(cursorParameters)) {
    const cursor = cursors[key as TeamsView];
    if (cursor && collectionCursorSchema.safeParse(cursor).success) params.set(parameter, cursor);
  }
  return `/groups?${params.toString()}`;
}
