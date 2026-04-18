import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";

const isVercelDeployment = process.env.VERCEL === "1";

if (isVercelDeployment) {
  // Vercel deployments should use the incoming host for OAuth callbacks.
  // This avoids cross-domain state/cookie issues across aliases and previews.
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  trustHost: true,
  session: {
    strategy: "database",
  },
  pages: {
    signIn: "/login",
  },
  providers: [Google],
  callbacks: {
    authorized({ auth: session, request }) {
      if (
        request.nextUrl.pathname.startsWith("/dashboard") ||
        request.nextUrl.pathname.startsWith("/groups")
      ) {
        return !!session?.user;
      }

      return true;
    },
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        session.user.role = user.role;
      }

      return session;
    },
  },
});
