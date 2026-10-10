import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "tests/server-only-stub.ts") } },
  esbuild: { jsx: "automatic" },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
