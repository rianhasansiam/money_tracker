import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AuthLoading from "@/app/(auth)/loading";
import AdminLoading from "@/app/admin/loading";
import DashboardLoading from "@/app/dashboard/loading";
import ApplicationError from "@/app/error";
import GlobalError from "@/app/global-error";
import AdminError from "@/app/admin/error";
import DashboardError from "@/app/dashboard/error";
import GroupsError from "@/app/groups/error";
import GroupsLoading from "@/app/groups/loading";
import Loading from "@/app/loading";
import { LoadingPanel } from "@/components/system/loading-panel";
import { RecoveryPanel } from "@/components/system/recovery-panel";

function privateError() {
  return Object.assign(
    new Error(
      "Prisma SQL failed for postgresql://user:password@private-host/database",
    ),
    { digest: "internal-error-digest" },
  );
}

describe("recovery boundaries", () => {
  it.each([ApplicationError, DashboardError, GroupsError, AdminError, GlobalError])("wires the installed framework's retry callback", (Boundary) => {
    const retry = vi.fn();
    function findRecovery(node: ReactNode): ReactElement<{ onRetry: () => void }> | undefined {
      if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
      if (node.type === RecoveryPanel) return node as ReactElement<{ onRetry: () => void }>;
      const children = node.props.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = findRecovery(child);
        if (found) return found;
      }
      return undefined;
    }
    const recovery = findRecovery(Boundary({ error: privateError(), retry }));
    expect(recovery?.props.onRetry).toBe(retry);
    recovery?.props.onRetry();
    expect(retry).toHaveBeenCalledOnce();
  });
  it.each([
    ["application", ApplicationError],
    ["dashboard", DashboardError],
    ["groups", GroupsError],
    ["administration", AdminError],
  ])("renders an accessible, non-sensitive %s recovery state", (_, Boundary) => {
    const html = renderToStaticMarkup(
      createElement(Boundary, {
        error: privateError(),
        retry: vi.fn(),
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
    ["groups", GroupsLoading, "Loading your teams"],
    ["dashboard", DashboardLoading, "Loading the financial dashboard"],
    ["administration", AdminLoading, "Loading the administrative console"],
  ])("renders the %s route loading screen", (_, Boundary, label) => {
    const html = renderToStaticMarkup(createElement(Boundary));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(label);
  });
});
