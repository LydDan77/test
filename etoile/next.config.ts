import type { NextConfig } from "next";

// DATABASE_URL set at build time (Vercel, CI against real Postgres) means PGlite is never opened.
const usesHostedPostgres = Boolean(process.env.DATABASE_URL);

const isDevelopment = process.env.NODE_ENV === "development";

// The Content-Security-Policy.
//
// What it cannot do yet: forbid inline scripts. The root layout has two (theme, form guard) and
// Next.js adds its own, different on every request, so hashes cannot cover them; a nonce would,
// but a nonce makes every page dynamic, and these pages are prerendered. So script-src keeps
// 'unsafe-inline' for now.
//
// What it does do, with no nonce needed: nothing loads from, posts to or is framed by another
// site. No plugins, no <base> pointing elsewhere, forms only submit here, scripts and styles
// only come from here. Images may come from any https address (covers, maps, favicons).
// `next dev` also needs eval (its error overlay and fast refresh) and a web socket.
//
// A feature that must load something from another site in the browser (map tiles, for one)
// adds that one origin to the matching line here, and says so in its report.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isDevelopment ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // Never let another site put these pages in a frame. (frame-ancestors says the same to
  // browsers that read the policy; this is for the ones that do not.)
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Guest links carry a secret token in the address. Other sites only ever learn the
  // origin, never the path.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // A window this app opens, or that opens it, on another site gets no handle on it.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // The app uses none of these; no script on its pages may either.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  // HTTPS only, for two years, once a browser has seen the site over HTTPS. Browsers ignore
  // this header on plain http, so it is harmless on localhost; it matters off Vercel, where no
  // platform adds it. Not in development, where the address is http://localhost.
  ...(isDevelopment ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

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

  // Do not announce the framework.
  poweredByHeader: false,

  // Headers every response carries.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
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
