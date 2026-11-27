# Étoile

Étoile (ay-TWAHL) is a web app, used mostly on a phone, for an everyday person who plans family
get-togethers, trips and work travel. A plan holds its people, bookings, schedule, things to do,
money and a small public page to share; the booking tools open the provider with everything
filled in and record the confirmation back. "Heads up" turns weather, airport delays, holidays,
traffic and the plan's own deadlines into a short, calm list.

This repository currently holds the **platform foundation**: the project, the database, accounts,
the time library and the tooling. The features and the visual design are built on top of it.
If you are about to write code here, read [AGENTS.md](./AGENTS.md) first.

## Run it locally

You need Node 22.12 or newer and npm. Nothing else: with no configuration the app uses an
embedded Postgres (PGlite) stored in `./.data`.

```bash
npm install
npm run dev            # http://localhost:3000  (use localhost, not 127.0.0.1)
```

Create an account at `/sign-up` and you are in. The first request creates the database and
applies the migrations in `drizzle/`.

When several people or tools share one checkout, start the server with
`scripts/dev-ensure.sh` instead: it makes sure exactly one development server is running on
port 3000 and is safe to call as often as you like (`--status`, `--stop`, `--restart`).

| Command | What it does |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` / `npm run start` | production build, then serve it |
| `npm run typecheck` | generate route types, then `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | unit tests (Vitest) |
| `npm run e2e` | build, then end-to-end tests against the production server |
| `npm run e2e:dev` | end-to-end tests against the running development server |
| `npm run db:generate -- --name <what>` | write a new migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | apply migrations (to `DATABASE_URL`, or to the local database) |
| `npm run db:reset` | delete the local database (stop the server first) |

Optional settings are listed in [.env.example](./.env.example). To run against a real Postgres
locally, set `DATABASE_URL`; the same code and the same migrations are used.

## Test it

```bash
npm run typecheck
npm run lint
npm test                 # 235 unit tests: time, ids, slugs, passwords, sessions, cache,
                         # rate limiter, domain schemas, and every database table
npm run e2e              # builds, starts a production server on port 3411, runs Playwright
```

- Unit tests live next to the code (`src/**/*.test.ts`). Tests that need a database get a
  private in-memory one with the real migrations (`createTestDb()` in `src/db/testing.ts`); they
  never touch `./.data`.
- End-to-end tests are in `e2e/`. `npm run e2e` tests the production build with its own
  throwaway database (`./.data/pglite-e2e`). `npm run e2e:dev` tests the development server.
- Playwright needs a Chromium that matches `@playwright/test` (pinned in `package.json`). On a
  machine that does not have one yet, run `npx playwright install chromium` once. (The build
  machines this project was started on already have it; there, never run that command.)
- `node scripts/shot.mjs <path>` saves full-page screenshots of a page at desktop and phone
  widths, in light and dark, signed in as a fresh test account.

## Deploy it to Vercel

The app needs one thing from the host: a Postgres database.

1. **Create the project.** Import the repository into Vercel. The framework is detected as
   Next.js; if the app is in a subdirectory of the repository, set that as the Root Directory.
2. **Add a Postgres database** (Neon through the Vercel Marketplace, or any Postgres you can
   reach). You need:
   - `DATABASE_URL`: the connection string the app uses at run time. Use the provider's
     **pooled** string.
   - `DATABASE_URL_UNPOOLED` (optional, recommended): a **direct** connection, used only for
     migrations. If it is not set, migrations use `DATABASE_URL`.

   Set them for Production (and Preview, if previews should have a database) under
   Project → Settings → Environment Variables. Never commit them.
3. **Set the build command** to migrate, then build:

   ```
   npm run vercel-build
   ```

   which runs `drizzle-kit migrate && next build`. The migrations in `drizzle/` are applied to
   the database before the new code is built, so a deploy fails before it goes live if a
   migration fails. (Project → Settings → Build & Development Settings → Build Command.)
4. **Deploy.** `GET /api/health` answers `{"ok":true,"app":"etoile","driver":"node-postgres"}`
   when the app can reach the database.

Things to know:

- On Vercel the app never migrates at request time and refuses to start on the embedded
  database (a function's file system is read-only and per-instance). Both are deliberate.
- The session cookie is `__Host-etoile_session`: `Secure`, `HttpOnly`, `SameSite=Lax`. It needs
  HTTPS, which Vercel provides.
- Rate limiting is always on in production (`RATE_LIMIT_DISABLED` is ignored on Vercel). It
  keys on the visitor's address as Vercel reports it.
- Telemetry is off (`NEXT_TELEMETRY_DISABLED=1`); set the same variable in the Vercel project.
- Nothing has been deployed from this repository yet. The steps above follow the code paths
  that exist (`src/db/index.ts`, `drizzle.config.ts`, `next.config.ts`) and were exercised
  locally, including against a real Postgres during the stack research; the Vercel-specific
  parts (environment variable names from an integration, build settings) should be checked on
  the first deploy.

## What is here

```
src/app/            routes: /, /sign-in, /sign-up, /api/health (bare pages, no design yet)
src/features/       auth (sign up, sign in, sign out); placeholders for home, landing, example plan
src/lib/time/       time zones, clocks, sunrise and sunset, calendar dates
src/lib/domain/     Zod schemas and types for every JSON shape and fixed list in the data model
src/lib/auth/       password hashing, sessions, requireUser, requirePlan
src/lib/            ids, slugs, brand, read-through cache, rate limiter, action results
src/db/             schema (17 tables), database client, test helper
drizzle/            generated SQL migration
e2e/, scripts/      end-to-end tests; dev-ensure.sh and shot.mjs
```
