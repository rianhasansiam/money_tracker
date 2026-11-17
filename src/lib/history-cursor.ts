import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const payloadSchema = z.object({
  v: z.literal(1),
  id: z.string().max(32).cuid(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  filters: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type HistoryCursorPayload = z.infer<typeof payloadSchema>;

function signingSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret?.trim()) throw new Error("History cursor protection is unavailable.");
  return secret;
}

function signatureFor(encoded: string) {
  return createHmac("sha256", signingSecret())
    .update("money-tracker:history-cursor:v1:")
    .update(encoded)
    .digest();
}

export function encodeHistoryCursor(payload: Omit<HistoryCursorPayload, "v">) {
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
  const signature = signatureFor(encoded).toString("base64url");
  return `${encoded}.${signature}`;
}

export function decodeHistoryCursor(cursor: string): HistoryCursorPayload | null {
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) return null;
  const [encoded, signature] = cursor.split(".");
  const expected = signatureFor(encoded);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = payloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}
