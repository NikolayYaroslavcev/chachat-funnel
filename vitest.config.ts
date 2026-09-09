import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgresql://chachat:chachat@localhost:5432/chachat_funnel",
    },
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
  },
});
