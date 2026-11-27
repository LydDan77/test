import { signOut } from "@/features/auth/actions";
import type { SessionUser } from "@/lib/auth";
import { formatClock, formatDate, localDateOf } from "@/lib/time";

// BARE ON PURPOSE. This is the placeholder Home for a signed-in person: it proves that the
// session works and nothing more. The real Home (world clock, next up, what's left, heads up)
// replaces it once the visual identity is chosen. Keep the "Home" heading and the "Sign out"
// button findable by role and name; e2e/auth.spec.ts and scripts/shot.mjs rely on them.

export function Home({ user, now }: { user: SessionUser; now: Date }) {
  // The time as it was when the page was rendered, in the person's home zone and their style.
  // (A clock that ticks is a client component; that belongs to the real Home.)
  const tz = user.home.tz;
  const clock = formatClock(now, tz, { style: user.timeStyle, militaryStyle: user.militaryStyle });
  const today = formatDate(localDateOf(now, tz), { weekday: "long", month: "long" });
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Home</h1>
      <p>
        Signed in as <strong>{user.name}</strong>.
      </p>
      <p className="text-sm">Home clock: {user.home.name}.</p>
      <p className="text-sm">
        {today}. Opened at <time dateTime={now.toISOString()}>{clock.primary}</time>
        {clock.secondary ? ` (${clock.secondary})` : ""}.
      </p>
      <form action={signOut}>
        <button type="submit" className="rounded border px-4 py-2 font-medium">
          Sign out
        </button>
      </form>
    </section>
  );
}
