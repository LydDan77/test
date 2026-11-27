import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (file: string) => fileURLToPath(new URL(`./tests/stubs/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Vite 8 reads the "paths" in tsconfig.json itself, so "@/..." works with no plugin.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Unit tests live next to the code they test: src/**/<name>.test.ts.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    alias: {
      // `import "server-only"` throws unless the bundler sets the "react-server" condition.
      // Under Vitest there is no such bundler, so point the marker packages at an empty module.
      "server-only": stub("empty.ts"),
      "client-only": stub("empty.ts"),
    },
    env: {
      // Safety net: even a test that forgets createTestDb() gets a private in-memory Postgres.
      // Nothing under Vitest can open ./.data, which belongs to the development server.
      PGLITE_DATA_DIR: "memory://",
      DATABASE_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    // scrypt at production cost takes ~0.4 s per hash; an in-memory database takes ~1-2 s to open.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
