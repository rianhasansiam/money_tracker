import { adminViewHref, readAdminNavigation } from "@/lib/admin-navigation";

/** A location only: never a privileged operation or a draft to replay. */
export function safeAuthenticationReturn(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return "/groups";
  }
  try {
    const url = new URL(value, "https://internal.invalid");
    if (url.origin !== "https://internal.invalid" || url.hash) return "/groups";
    if (url.pathname === "/admin") {
      return adminViewHref(readAdminNavigation(Object.fromEntries(url.searchParams)));
    }
    if (url.pathname === "/groups") {
      const allowed = new Set(["view", "teamCursor", "membershipCursor", "availableCursor", "approvalCursor", "requestCursor"]);
      const params = new URLSearchParams();
      for (const [key, entry] of url.searchParams) {
        if (allowed.has(key) && entry.length <= 254) params.set(key, entry);
      }
      return params.size ? `/groups?${params}` : "/groups";
    }
    if (url.pathname === "/dashboard" && !url.search) return "/dashboard";
  } catch {
    // Malformed values never become redirects.
  }
  return "/groups";
}

export function reauthenticationLocation(returnTo: unknown) {
  return `/login?reauth=1&returnTo=${encodeURIComponent(safeAuthenticationReturn(returnTo))}`;
}
