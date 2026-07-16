import { z } from "zod";

const DATABASE_CURSOR_MAX_LENGTH = 32;

export const transactionCursorSchema = z
  .string()
  .max(DATABASE_CURSOR_MAX_LENGTH, "Invalid history cursor.")
  .cuid("Invalid history cursor.");

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
