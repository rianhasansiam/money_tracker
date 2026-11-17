export { proxy } from "@/lib/auth";

export const config = {
  matcher: ["/dashboard/:path*", "/groups/:path*", "/admin/:path*"],
};
