import { signOut } from "@/features/auth/actions";
import type { SessionUser } from "@/lib/auth";

// BARE ON PURPOSE. This is the placeholder Home for a signed-in person: it proves that the
// session works and nothing more. The real Home (world clock, next up, what's left, heads up)
// replaces it once the visual identity is chosen. Keep the "Home" heading and the "Sign out"
// button findable by role and name; e2e/auth.spec.ts and scripts/shot.mjs rely on them.

export function Home({ user }: { user: SessionUser }) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Home</h1>
      <p>
        Signed in as <strong>{user.name}</strong>.
      </p>
      <p className="text-sm">Home clock: {user.home.name}.</p>
      <form action={signOut}>
        <button type="submit" className="rounded border px-4 py-2 font-medium">
          Sign out
        </button>
      </form>
    </section>
  );
}
