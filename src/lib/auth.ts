import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { NextResponse, type NextFetchEvent, type NextMiddleware, type NextRequest } from "next/server";
import { createHardenedPrismaAdapter } from "@/lib/auth-adapter";
import { enforceAuthenticationStart } from "@/lib/authentication-start";
import { withSessionCookieDeadline } from "@/lib/auth-session-lifetime";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
} from "@/lib/rate-limit";
import {
  createBrowserSessionDto,
  createPublicSessionDto,
} from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  admitInvitedGoogleIdentity,
  createPrismaInvitationRepository,
} from "@/lib/invitations";
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  AUTH_SESSION_UPDATE_AGE_SECONDS,
  isAuthRequestHostAllowed,
  resolveAuthDeploymentConfig,
} from "@/lib/security-policy";

const authDeployment = resolveAuthDeploymentConfig(process.env);
const invitationRepository = createPrismaInvitationRepository(db);

const authResult = NextAuth({
  adapter: createHardenedPrismaAdapter(db),
  // Auth.js requires Host trust for request URL construction. Managed hosts
  // are trusted only in the recognized topology; production self-hosting is
  // rejected at startup unless AUTH_URL supplies an exact HTTPS origin.
  trustHost: authDeployment.trustHost,
  session: {
    strategy: "database",
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
  },
  pages: {
    signIn: "/login",
    error: "/auth-error",
  },
  providers: [
    Google({
      // The bootstrap command creates the configured user before their first
      // login. Invitations also pre-provision a PENDING user. Automatic
      // linking is limited below to a verified Google identity that exactly
      // matches one of those server-side identities.
      allowDangerousEmailAccountLinking: true,
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email.trim().toLowerCase(),
          image: profile.picture,
          role: "MEMBER",
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (
        account?.provider !== "google" ||
        !profile ||
        profile.email_verified !== true ||
        typeof profile.email !== "string"
      ) {
        return false;
      }

      return admitInvitedGoogleIdentity(
        invitationRepository,
        profile.email,
      );
    },
    authorized({ auth: session, request }) {
      if (
        request.nextUrl.pathname.startsWith("/dashboard") ||
        request.nextUrl.pathname.startsWith("/groups") ||
        request.nextUrl.pathname.startsWith("/admin")
      ) {
        return !!session?.user;
      }

      return true;
    },
    session({ session, user }) {
      return createPublicSessionDto(session.expires, user);
    },
  },
  events: {
    async signIn({ user }) {
      const authenticatedAt = new Date();
      const updated = await db.user.updateMany({
        where: {
          id: user.id,
          status: "ACTIVE",
          disabledAt: null,
          deletedAt: null,
        },
        data: {
          lastAuthenticatedAt: authenticatedAt,
        },
      });

      if (updated.count !== 1) {
        // The identity was offboarded between admission and session creation.
        // Revoke every possible race-created session before failing closed.
        await db.session.deleteMany({
          where: {
            userId: user.id,
          },
        });
        throw new Error("The authentication state changed before sign-in completed.");
      }
    },
  },
});

function protectAuthHandler(
  handler: (request: NextRequest) => Promise<Response>,
) {
  return async (request: NextRequest) => {
    if (!isAuthRequestHostAllowed(request.headers, authDeployment)) {
      return new Response("Invalid authentication request.", {
        status: 400,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (
      request.method === "POST" &&
      /^\/api\/auth\/signin\/google\/?$/.test(request.nextUrl.pathname)
    ) {
      try {
        await enforceAuthenticationStart(request.headers);
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return Response.json(
            {
              error: "rate_limited",
              message: "Too many sign-in attempts. Please try again shortly.",
            },
            {
              status: 429,
              headers: {
                "cache-control": "no-store",
                "retry-after": String(error.retryAfterSeconds),
              },
            },
          );
        }
        if (error instanceof RateLimitUnavailableError) {
          return Response.json(
            {
              error: "unavailable",
              message: "Sign-in protection is temporarily unavailable. Please try again later.",
            },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        throw error;
      }
    }

    const response = await withSessionCookieDeadline(() => handler(request));

    if (
      request.nextUrl.pathname.endsWith("/session") &&
      response.ok &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const session = (await response.json()) as ReturnType<
        typeof createPublicSessionDto
      > | null;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");

      return Response.json(
        session ? createBrowserSessionDto(session) : null,
        {
          status: response.status,
          headers: responseHeaders,
        },
      );
    }

    return response;
  };
}

export const handlers = {
  GET: protectAuthHandler(authResult.handlers.GET),
  POST: protectAuthHandler(authResult.handlers.POST),
};

export const { auth, signIn, signOut } = authResult;

// The Node.js Proxy overload emits renewal cookies too. Server-component
// auth() calls have no response cookies and receive the capped adapter DTO.
export function proxy(request: NextRequest, event: NextFetchEvent) {
  return withSessionCookieDeadline(async () => {
    // Auth.js augments NextRequest.auth inside this overload; its published
    // input type already requires that augmentation, although the runtime
    // explicitly accepts an ordinary NextRequest (the direct Proxy export).
    const authProxy = authResult.auth as unknown as NextMiddleware;
    const response = await authProxy(request, event);
    return response ?? NextResponse.next();
  });
}
