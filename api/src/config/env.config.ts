import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_URL: z
    .string()
    .url()
    .default("postgres://postgres:postgres@localhost:5432/postgres"),
});

export const ENV = envSchema.parse(process.env);