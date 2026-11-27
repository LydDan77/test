import type { NextConfig } from "next";

// DATABASE_URL set at build time (Vercel, CI against real Postgres) means PGlite is never opened.
const usesHostedPostgres = Boolean(process.env.DATABASE_URL);

const nextConfig: NextConfig = {
  // Component/function-level caching ("use cache"), Partial Prerendering and the Suspense rules
  // that come with them. create-next-app 16.4 scaffolds both flags on.
  cacheComponents: true,
  partialPrefetching: true,

  // <Link href> and router.push() are type-checked against the routes that exist.
  typedRoutes: true,

  // Hide the floating development badge so scripts/shot.mjs screenshots show only the app.
  // Compile and runtime errors are still shown.
  devIndicators: false,

  // Load PGlite with Node's own module loader instead of bundling it: it reads pglite.wasm and
  // pglite.data from its package directory. (`pg` is already on Next's built-in external list.)
  serverExternalPackages: ["@electric-sql/pglite"],

  // The migrations folder is read at runtime with fs. Next's tracer already finds it through
  // path.join(process.cwd(), "drizzle"); listing it makes that explicit and refactor-proof.
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*"],
  },
  // PGlite is 27 MB of WebAssembly and extension archives. Keep it out of the deployed
  // functions when the build targets hosted Postgres.
  outputFileTracingExcludes: usesHostedPostgres
    ? { "/*": ["./node_modules/@electric-sql/pglite/**/*"] }
    : undefined,

  // Headers every response carries. (A Content-Security-Policy is not set yet: the inline
  // scripts in the root layout would need a nonce, and a nonce makes every page dynamic.)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Never let another site put these pages in a frame.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Guest links carry a secret token in the address. Other sites only ever learn the
          // origin, never the path.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },

  turbopack: {
    rules: {
      // Tailwind CSS 4 runs as a Turbopack loader; there is no postcss.config.
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
