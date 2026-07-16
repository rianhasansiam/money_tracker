import { z } from "zod";

export const transactionOperationKeySchema = z
  .string()
  .trim()
  .uuid("Invalid transaction operation key.")
  .transform((value) => value.toLowerCase());
