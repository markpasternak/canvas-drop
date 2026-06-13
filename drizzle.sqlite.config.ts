import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/shared/src/db/schema.sqlite.ts",
  out: "./drizzle/sqlite",
});
