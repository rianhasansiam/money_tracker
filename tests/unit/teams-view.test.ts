import { describe, expect, it } from "vitest";
import { parseTeamsLocation, teamsPageHref } from "@/lib/validators/teams-view";

const cursor = "clh1234567890abcdefghijk";
const other = "clh1234567890abcdefghijl";

describe("Teams task navigation", () => {
  it("preserves independent safe task cursors without persisting unrelated input", () => {
    const location = parseTeamsLocation({ view: "requests", teamCursor: cursor, availableCursor: other, requestCursor: cursor, approvalCursor: other, note: "private financial draft", redirect: "https://outside.example" });
    expect(location).toEqual({ view: "requests", cursors: { teams: cursor, discover: other, requests: cursor, approvals: other } });
    const href = teamsPageHref("discover", location!.cursors);
    expect(href).toContain("view=discover");
    expect(href).toContain(`requestCursor=${cursor}`);
    expect(href).not.toContain("private");
    expect(href).not.toContain("outside");
  });
  it.each([{ view: "unexpected" }, { view: ["teams", "discover"] }, { teamCursor: "bad" }, { availableCursor: [cursor, other] }])("rejects malformed or repeated task state %j", (input) => {
    expect(parseTeamsLocation(input)).toBeNull();
  });
  it("keeps the default task server-selected and maps a validated legacy membership cursor", () => {
    expect(parseTeamsLocation({})).toEqual({ view: undefined, cursors: {} });
    expect(parseTeamsLocation({ view: "requests", membershipCursor: cursor })).toEqual({ view: "requests", cursors: { requests: cursor } });
  });
  it("never manufactures an unsafe cursor in outgoing links", () => {
    expect(teamsPageHref("teams", { teams: "javascript:alert(1)" })).toBe("/groups?view=teams");
  });
});
