import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/** Fixture <-> PostgreSQL adapter parity. Needs PARITY_DATABASE_URL (see scripts/public-pipeline-integration.sh). */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "tests/server-only-stub.ts") } },
  test: { include: ["tests/parity/**/*.test.ts"], environment: "node" },
});
