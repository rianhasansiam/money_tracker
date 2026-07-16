import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AuthLoading from "@/app/(auth)/loading";
import AdminLoading from "@/app/admin/loading";
import DashboardLoading from "@/app/dashboard/loading";
import ApplicationError from "@/app/error";
import DashboardError from "@/app/dashboard/error";
import GroupsError from "@/app/groups/error";
import GroupsLoading from "@/app/groups/loading";
import Loading from "@/app/loading";
import { LoadingPanel } from "@/components/system/loading-panel";

function privateError() {
  return Object.assign(
    new Error(
      "Prisma SQL failed for postgresql://user:password@private-host/database",
    ),
    { digest: "internal-error-digest" },
  );
}

describe("recovery boundaries", () => {
  it.each([
    ["application", ApplicationError],
    ["dashboard", DashboardError],
    ["groups", GroupsError],
  ])("renders an accessible, non-sensitive %s recovery state", (_, Boundary) => {
    const html = renderToStaticMarkup(
      createElement(Boundary, {
        error: privateError(),
        unstable_retry: vi.fn(),
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("Prisma");
    expect(html).not.toContain("private-host");
    expect(html).not.toContain("password");
    expect(html).not.toContain("internal-error-digest");
  });

  it("announces loading state without exposing data placeholders", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingPanel, { label: "Loading the dashboard" }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading the dashboard");
  });

  it.each([
    ["application", Loading, "Loading Money Tracker"],
    ["authentication", AuthLoading, "Loading sign-in"],
    ["groups", GroupsLoading, "Loading your groups"],
    ["dashboard", DashboardLoading, "Loading the financial dashboard"],
    ["administration", AdminLoading, "Loading the administrative console"],
  ])("renders the %s route loading screen", (_, Boundary, label) => {
    const html = renderToStaticMarkup(createElement(Boundary));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(label);
  });
});
