import { describe, expect, it } from "vitest";
import {
  createBrowserSessionDto,
  createPublicSessionDto,
} from "@/lib/auth-session";

describe("public authentication session DTO", () => {
  it("serializes only the fields needed by application clients", () => {
    const source = {
      id: "user-1",
      name: "Team member",
      email: "private@example.test",
      image: null,
      role: "MEMBER" as const,
      status: "ACTIVE",
      disabledAt: null,
      lastAuthenticatedAt: new Date("2026-07-15T10:00:00.000Z"),
      sessionToken: "must-not-leave-server",
    };

    const dto = createPublicSessionDto("2026-07-15T18:00:00.000Z", source);

    expect(dto).toEqual({
      expires: "2026-07-15T18:00:00.000Z",
      user: {
        id: "user-1",
        name: "Team member",
        image: null,
        email: null,
        role: "MEMBER",
      },
    });
    expect(JSON.stringify(dto)).not.toContain("must-not-leave-server");
    expect(JSON.stringify(dto)).not.toContain("private@example.test");
    expect(dto.user).not.toHaveProperty("status");
    expect(dto.user).not.toHaveProperty("lastAuthenticatedAt");
  });

  it("removes the server-only user key at the browser session boundary", () => {
    const serverSession = createPublicSessionDto(
      "2026-07-15T18:00:00.000Z",
      {
        id: "internal-user-key",
        name: "Team member",
        image: null,
        role: "MEMBER",
      },
    );

    const browserSession = createBrowserSessionDto(serverSession);

    expect(browserSession.user).not.toHaveProperty("id");
    expect(JSON.stringify(browserSession)).not.toContain("internal-user-key");
  });
});
