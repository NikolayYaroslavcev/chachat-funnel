import path from "node:path";
import { defineConfig } from "vitest/config";

// Focused tests for identity/session/attribution logic (see AGENTS.md 10)
// run against a real Postgres so the DB-level invariants they depend on
// (case-insensitive email index, visitor.user_id immutability trigger) are
// actually exercised, not mocked. Point this at the docker-compose Postgres
// via its host-mapped port (the "db" hostname in .env only resolves inside
// the compose network): `docker compose up -d db`, then `npm test`.
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
    // All suites share one real Postgres database and each truncates the
    // same tables in beforeEach; running test files in parallel races those
    // truncations against another file's in-flight transactions. Serialize
    // file execution rather than mocking the DB away.
    fileParallelism: false,
  },
});
