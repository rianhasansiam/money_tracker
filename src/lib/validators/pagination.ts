import { z } from "zod";

const DATABASE_CURSOR_MAX_LENGTH = 32;

export const transactionCursorSchema = z
  .string()
  .max(512, "Invalid history cursor.")
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/, "Invalid history cursor.");

export const collectionCursorSchema = z
  .string()
  .max(DATABASE_CURSOR_MAX_LENGTH, "Invalid collection cursor.")
  .cuid("Invalid collection cursor.");

export const emailCursorSchema = z
  .string()
  .trim()
  .max(254, "Invalid collection cursor.")
  .email("Invalid collection cursor.")
  .transform((email) => email.toLowerCase());
