import type { UserRole } from "@prisma/client";

export interface PublicSessionUserInput {
  id: string;
  name?: string | null;
  image?: string | null;
  role: UserRole;
}

/** Server-side authorization DTO. The public Auth.js handler removes `id`. */
export function createPublicSessionDto(
  expires: string,
  user: PublicSessionUserInput,
) {
  return {
    expires,
    user: {
      id: user.id,
      name: user.name ?? null,
      image: user.image ?? null,
      email: null,
      role: user.role,
    },
  };
}

export function createBrowserSessionDto(
  session: ReturnType<typeof createPublicSessionDto>,
) {
  return {
    expires: session.expires,
    user: {
      name: session.user.name,
      image: session.user.image,
      email: null,
      role: session.user.role,
    },
  };
}
