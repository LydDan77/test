<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Étoile: working rules

Read this before you write anything. It is the short version of the build spec. The foundation
(project, database, accounts, time library, tooling) exists; everything else is being built by
several engineers at the same time, in this one tree.

**There is no visual identity yet.** The pages that exist are bare on purpose. Do not add design
tokens, a component library or styled screens until the build spec's section 2 says the look is
chosen. Until then a page is semantic HTML, real labels, a few plain utility classes.

## Commands

```bash
scripts/dev-ensure.sh                      # make sure THE development server is up on :3000 (safe to repeat)
npm run typecheck                          # route types, then tsc --noEmit
npx vitest run src/lib/time/dates.test.ts  # one unit-test file
E2E_MODE=dev npx playwright test e2e/auth.spec.ts   # one end-to-end spec, against the dev server
node scripts/shot.mjs /plans --name plans  # four screenshots: desktop + phone, light + dark
npx eslint src/features/people             # lint your own files
```

- **One development server, on port 3000.** `scripts/dev-ensure.sh` starts it if needed and never
  starts a second one. Never run `next dev` yourself. It owns the local database in `.data/`:
  no other process may open that directory. Its output is in `.dev.log`.
  `scripts/dev-ensure.sh --restart` restarts it; `--status` and `--stop` do what they say.
- **Type-check with `npm run typecheck`**, not bare `npx tsc --noEmit`: it regenerates the route
  types first. Without that, a route someone added or removed since the last run shows up as
  errors in `.next/types/validator.ts`. Other people's unfinished files may show errors: fix only
  the ones in files you own, and run it again before you finish.
- **Screenshots** land in the session's `shots/` folder as
  `<name>-{desktop,phone}-{light,dark}.png`. `shot.mjs` signs up a fresh test account through the
  real form (add `--user <email>` to reuse one it printed earlier, `--signed-out` for a visitor).
  Open the files with the Read tool and fix what looks wrong, at both widths, in both themes.
- **Do not run** `npm install`, `next build`, `drizzle-kit generate`, `npm run e2e`, or a
  formatter over the whole tree. Dependencies and the database schema are frozen. If you need a
  package or a column, say so in your report.
- **Never `npx playwright install`.** The browser is already on the machine and
  `@playwright/test` is pinned to match it.

## Where things go, and who owns what

```
src/app/                 routes only: page.tsx, layout.tsx, route.ts. Thin. No logic.
  page.tsx               "/": landing when signed out, Home when signed in
  (auth)/sign-in, sign-up
  (app)/                 signed-in app: plans/, plans/[planId]/{flights,stay,car,…}, heads-up/, you/
  (site)/[slug]/         public share pages
  api/                   route handlers: health, typeahead, exports
src/features/<feature>/  one folder per feature: components, actions.ts, queries.ts
src/components/          shared React pieces (ui/ belongs to the design-system task)
src/lib/                 pure logic, no React: time/, domain/, auth/, cache.ts, rate-limit.ts, …
src/db/                  schema.ts (frozen), index.ts (getDb), testing.ts (createTestDb)
drizzle/                 generated migrations (frozen)
e2e/                     Playwright specs, one file per feature; shared steps in e2e/support/
scripts/                 dev-ensure.sh, shot.mjs
```

- **Ownership is strict.** Your task lists the paths you own. Do not edit files outside them. If
  you need a change elsewhere, first try to solve it inside your own paths; if you cannot, make
  the smallest possible change and list it under "changes outside my paths" in your report.
  Never reformat or reorganise files you do not own.
- A new top-level route needs two more edits (both are "outside your paths": list them): the
  word goes into `RESERVED_SLUGS` in `src/lib/slugs.ts` (a test fails until it does), and, if the
  route needs an account, into the `matcher` in `src/proxy.ts`.
- If the development server shows an error from a file you do not own, wait a minute and try
  again: someone is in the middle of an edit.

## Pages: static shell, then `<Suspense>`

This Next.js prerenders every page into a static shell (Cache Components). The page function
must be **synchronous** and read nothing at request time. Everything that reads `params`,
`searchParams`, the session or the database goes in an async child inside `<Suspense>`.
Reading them outside a boundary is a build error.

```tsx
// src/app/(app)/plans/[planId]/people/page.tsx
import { Suspense } from "react";
import { AddPersonForm } from "@/features/people/add-person-form";
import { listParties, listPeople } from "@/features/people/queries";
import { requirePlan, requireUser } from "@/lib/auth";

// 1. Synchronous: this is the static shell. No await, no session, no database.
export default function PeoplePage({ params }: PageProps<"/plans/[planId]/people">) {
  return (
    <main>
      <h1>Who&apos;s coming</h1>
      {/* 2. Anything that reads params, the session or the database goes inside <Suspense>. */}
      <Suspense fallback={<p>Loading…</p>}>
        <People params={params} />
      </Suspense>
    </main>
  );
}

// 3. The async child: await params, check the user, check the plan, then load.
async function People({ params }: Pick<PageProps<"/plans/[planId]/people">, "params">) {
  const { planId } = await params;
  const user = await requireUser(`/plans/${planId}/people`); // signed out: to /sign-in, and back after
  const plan = await requirePlan(user, planId);               // not theirs, or not there: not-found page
  const [people, parties] = await Promise.all([listPeople(plan.id), listParties(plan.id)]);
  return (
    <>
      {people.length === 0 ? <p>Nobody yet. Add the first person below.</p> : (
        <ul>{people.map((person) => <li key={person.id}>{person.name}</li>)}</ul>
      )}
      <AddPersonForm planId={plan.id} parties={parties} />
    </>
  );
}
```

- `PageProps<"/route">` and `LayoutProps<"/route">` are global types, generated for routes that
  exist. `params` and `searchParams` are promises: pass them down, await them inside the boundary.
- `getUser()`, `requireUser()` and `requirePlan()` come from `@/lib/auth`. All three read the
  session, so they only work inside `<Suspense>` (or in an action or route handler).
- Layouts are part of the shell too: never read the session in a layout body. Put a
  `<Suspense>` around the part that needs it.
- The current time is request data as well. On the server get it with `await requestNow()`
  (`@/lib/request`), inside the boundary, and pass it down as `now`; a bare `new Date()` in a
  component can be frozen into the shell. A clock that ticks is a client component that renders
  a placeholder on the server (`useSyncExternalStore` with a server snapshot of `null`).
- `<Link href>` is type-checked against real routes. For a path built from a variable, write
  ``href={`/plans/${plan.id}` as Route}`` (`import type { Route } from "next"`).
- Read the bundled guide before anything unusual: `node_modules/next/dist/docs/01-app/`.

## Server actions

Every mutation is a server action in `src/features/<feature>/actions.ts`. An action is a public
POST endpoint: it checks the user and the plan itself, every time.

```ts
// src/features/people/actions.ts
"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { fail, formText, invalid, ok, type ActionResult } from "@/lib/action";
import { requirePlan, requireUser } from "@/lib/auth";

const addPersonSchema = z.object({
  partyId: z.string().min(1, "Choose a household"),
  name: z.string().min(1, "Enter a name").max(120, "Use a shorter name"),
});

export type AddPersonResult = ActionResult<{ personId: string }>;

export async function addPerson(_prev: AddPersonResult | null, formData: FormData): Promise<AddPersonResult> {
  // 1. Who is asking.
  const user = await requireUser();
  // 2. The plan, only if this user owns it. Anything else ends in the not-found page.
  const plan = await requirePlan(user, formText(formData, "planId"));

  // 3. Validate what was sent. Never throw for something a person can cause.
  const values = { partyId: formText(formData, "partyId"), name: formText(formData, "name") };
  const parsed = addPersonSchema.safeParse(values);
  if (!parsed.success) return invalid(parsed.error, values);

  // 4. Write. An id that came from the browser is checked against the plan in the WHERE clause.
  const db = await getDb();
  const [party] = await db
    .select({ id: schema.parties.id })
    .from(schema.parties)
    .where(and(eq(schema.parties.id, parsed.data.partyId), eq(schema.parties.planId, plan.id)))
    .limit(1);
  if (!party) return fail("That household is no longer part of this plan.", { values });

  const [person] = await db
    .insert(schema.people)
    .values({ planId: plan.id, partyId: party.id, name: parsed.data.name })
    .returning({ id: schema.people.id });

  // 5. Show the change. Pages read their data uncached at request time, so there is no cache
  //    to expire: refresh() re-renders the current route in the same response.
  refresh();
  return ok({ personId: person.id });
}
```

```tsx
// src/features/people/add-person-form.tsx
"use client";

import { useActionState } from "react";
import { addPerson, type AddPersonResult } from "./actions";

export function AddPersonForm({ planId, parties }: { planId: string; parties: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<AddPersonResult | null, FormData>(addPerson, null);
  const failed = state && !state.ok ? state : null;
  return (
    <form action={formAction}>
      <input type="hidden" name="planId" value={planId} />
      <label>
        Name
        <input name="name" required defaultValue={failed?.values?.name} />
      </label>
      <label>
        Household
        <select name="partyId" defaultValue={failed?.values?.partyId}>
          {parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
        </select>
      </label>
      {failed && <p role="alert">{failed.error}</p>}
      <button type="submit" disabled={pending}>Add person</button>
    </form>
  );
}
```

- The result is always `{ ok: true, … } | { ok: false, error, fieldErrors?, values? }`
  (`src/lib/action.ts`: `ok()`, `fail()`, `invalid(zodError, values)`). Return failures; throw
  only for bugs. `redirect()` and `notFound()` also throw: keep them outside `try`.
- React clears a form after its action runs. Send back what was typed in `values` and put it in
  `defaultValue`, as above. Never send a password back.
- After a write call `refresh()` (from `next/cache`). `revalidatePath` and `updateTag` are only
  for data you cached yourself with `"use cache"`.
- Render every field of a form with the form. Never stream one field into a form that is
  already on the page (a server component in its own `<Suspense>` inside the form): until React
  reveals it, the field is not in the form and a quick submit goes without it.
- A form submitted before the page's scripts have loaded is held and sent once React is ready.
  The guard is in `src/app/layout.tsx`; you get it for free. Do not remove it: without it a
  failed action answers with a blank page in a production build.
- **Public (guest) actions** take a slug and, where needed, a guest token. They never trust an id
  from the browser without checking it belongs to that page's plan, and they start with
  `rateLimit()`:
  ```ts
  const limit = await rateLimit(rateLimitKey("rsvp", slug, await clientIp()), { limit: 10, windowMs: 10 * 60_000 });
  if (!limit.ok) return fail(`Too many tries. Wait ${describeWait(limit.retryAfterMs)} and try again.`);
  ```
  (`@/lib/rate-limit`, `@/lib/request`. Limits are off under `next dev`, on in unit tests and in production.)
- **Never show private fields on a share page:** confirmation codes, prices, emails, phone
  numbers, private notes, lodging access notes, door codes, guest tokens. Public pages build
  their data through dedicated `public*` query functions that select only public columns.

## The database

- `const db = await getDb()` from `@/db` is the only way in. Tables are `schema.users`,
  `schema.plans`, … (`src/db/schema.ts`; row types `Plan`, `NewPlan`, `Booking`, … are exported
  there). It works the same on the embedded local database and on hosted Postgres.
- `getDb()` is request-time: a component that calls it must be inside `<Suspense>`.
- Put queries in `src/features/<feature>/queries.ts`, starting with `import "server-only"`:
  ```ts
  // src/features/people/queries.ts
  import "server-only";

  import { asc, eq } from "drizzle-orm";
  import { getDb, schema } from "@/db";

  /** Everyone in a plan, by name. The caller has already checked the plan with requirePlan(). */
  export async function listPeople(planId: string) {
    const db = await getDb();
    return db.select().from(schema.people).where(eq(schema.people.planId, planId)).orderBy(asc(schema.people.name));
  }

  export async function listParties(planId: string) {
    const db = await getDb();
    return db
      .select({ id: schema.parties.id, name: schema.parties.name })
      .from(schema.parties)
      .where(eq(schema.parties.planId, planId))
      .orderBy(asc(schema.parties.sortOrder));
  }
  ```
- Ids are `newId()`, secrets are `newToken()` (`@/lib/ids`). Rows get their id by default.
- jsonb columns are typed with the domain types in `@/lib/domain` (`PlaceRef`, `Money`,
  `ZonedInstant`, `BookingDetails`, `ExpenseSplit`, `SiteSection`, `RsvpQuestion`, …), each with
  a Zod schema. TypeScript only checks the shape you claim: validate with the schema before
  writing anything a person or a provider sent.
- A booking's kind-specific fields are in `bookings.details`. Write them through
  `parseBookingDetails(kind, input)`; read them with `switch (booking.details.kind)` or
  `isBookingOf(booking, "flight")`.
- `isUniqueViolation(error)` (`@/db/errors`) tells a taken slug or email from a real failure.
- External feeds go through `cached(key, lifetimeMs, fetcher)` (`@/lib/cache`): one shared copy,
  the last good value when the source is down, never a throw.

### Testing with a database

Unit tests sit next to the code (`*.test.ts`) and never touch the development database.
`createTestDb()` gives the test file a private in-memory Postgres with the real migrations, and
makes `getDb()` return it, so the code under test needs no special wiring:

```ts
// src/features/people/actions.test.ts
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// A signed-in user, and Next's request-only functions stubbed. vi.mock calls go before imports.
const currentUser = { id: "" };
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: async () => currentUser,
}));
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/cache")>()), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));

import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { addPerson } from "./actions";

let t: TestDb;
let planId: string;
let partyId: string;

beforeAll(async () => {
  t = await createTestDb();
  const home = { kind: "home" as const, name: "Chicago", tz: "America/Chicago" };
  const [user] = await t.db.insert(schema.users).values({ email: "lydia@example.com", name: "Lydia", passwordHash: "x", home }).returning();
  currentUser.id = user.id;
  const [plan] = await t.db.insert(schema.plans).values({ ownerId: user.id, template: "trip", title: "Trip", origin: home, tz: home.tz }).returning();
  planId = plan.id;
  const [party] = await t.db.insert(schema.parties).values({ planId, name: "The Hartleys" }).returning();
  partyId = party.id;
});
afterAll(() => t.close());

it("adds a person to the plan", async () => {
  const form = new FormData();
  form.set("planId", planId); form.set("partyId", partyId); form.set("name", "Theo");
  expect(await addPerson(null, form)).toMatchObject({ ok: true });
  expect((await t.db.select().from(schema.people)).map((p) => p.name)).toEqual(["Theo"]);
});
```

Pure logic (anything under `src/lib/` that takes plain data) needs none of this: call it.
Async Server Components cannot be rendered by Vitest; cover them with Playwright.

### End-to-end specs

One spec per feature in `e2e/`, walking its main flow. Start each test with
`const account = await signUpFreshAccount(page)` from `e2e/support/account.ts` (a brand-new
account through the real form). Do not share an account between tests through a variable at the
top of the file. Find controls with `getByRole`; scope `getByRole("alert")` to a form
(`formAlert(page, "Save")`), because Next adds an alert node of its own to every page.

## Time

All of it is in `@/lib/time` (pure, no React). Rules:

- An **instant** is a UTC timestamp (`timestamptz`, a `Date`, or an ISO string ending in `Z`) and
  always travels with an IANA zone: `{ at, tz }` (`ZonedInstant`), or two columns side by side.
- A **local date** is a `YYYY-MM-DD` string; a local time is `HH:mm`.
- A time is shown in the local time of the place where it happens. The zone comes from the
  place (`PlaceRef.tz`); the app never asks a person to choose a time zone.
- **Never call `new Date()` to mean "local time somewhere".** Take `now` as an argument and say
  which zone: `localDateOf(now, plan.tz)`, `formatClock(now, place.tz)`. The server's own zone is
  UTC; formatting without a zone is always wrong. (`now` comes from `await requestNow()` in a
  page, `new Date()` in an action, a fixed date in a test.)
- Never do date arithmetic with `Date` methods or by adding 86,400,000. Use the helpers.

| Need | Use |
| --- | --- |
| Local date-time in a zone to an instant (DST gaps and overlaps handled) | `zonedToUtc("2026-12-19T08:10", tz)` |
| What the clocks show somewhere at an instant | `utcToZoned(instant, tz)` gives `{ date, time, hour, …, weekday, offsetMinutes }` |
| A time for people | `formatClock(instant, tz, { style: user.timeStyle, militaryStyle: user.militaryStyle })` gives `.primary` ("2:41 PM"), `.secondary` ("1441 PST" or null), plus `.h12`, `.h24.compact` ("1441"), `.h24.colon` ("14:41"), `.zone` |
| "+3h", "+5h 30m" beside a clock | `offsetFromHome(tz, user.home.tz, now).label` (a real minus sign, `MINUS`, when behind) |
| "Tomorrow" / "Yesterday" beside a clock | `dayRelation(tz, user.home.tz, now)` (null when the day is the same) |
| Sunrise and sunset | `sunTimes(lat, lon, date, tz)` gives `{ kind: "normal" \| "polar_day" \| "polar_night", sunrise, sunset, … }` |
| Today somewhere; days until a date | `localDateOf(now, tz)`; `daysUntil(date, tz, now)` |
| Date arithmetic | `addDays`, `diffDays`, `compareDates`, `nightsBetween` |
| Business days (ship-by) | `addBusinessDays(date, -5, holidays)`, `businessDaysBetween`, `nextBusinessDay` |
| "Dec 19–26" (en dash) | `formatDateRange(start, end)`; one date: `formatDate(date, { weekday: true })` |
| "+1" beside an arrival time | `calendarDayDifference(departs, originTz, arrives, destinationTz)` |
| A zone fit to store | `isIanaTimeZone(tz)` ("EST" is refused: it has no daylight saving) |

## House rules

- Brand strings come from `BRAND` in `src/lib/brand.ts`. Never write the name inline.
- Words people see follow the build spec's vocabulary table: Heads up, Stay, Car, Rides, Food,
  Send ahead, Who's coming, Schedule, Money, Share page. Plain, warm, specific. Sentence case.
  No exclamation marks.
- Every control works by keyboard and has a visible focus. Every input has a label. Status is
  never shown by colour alone. Messages that appear use `role="alert"` or `role="status"`.
- Theme: `data-theme="light" | "dark"` on `<html>` overrides the system setting; absent means
  follow the system. It is kept in `localStorage` under `theme` and applied before first paint by
  the script in `src/app/layout.tsx`. The `dark:` variant in `globals.css` follows the same rule.
- Third-party CSS goes into the `vendor` cascade layer
  (`@import "pkg/style.css" layer(vendor);`), or it overrides every utility class.
- No secrets in files. No telemetry. No new dependencies.
- Your report says plainly what works, what you ran and saw, what is missing or stubbed, and
  every change outside your paths. Do not claim something works unless you ran it.
