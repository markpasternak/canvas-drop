import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/shared/src/db/schema.pg.ts",
  out: "./drizzle/pg",
});
