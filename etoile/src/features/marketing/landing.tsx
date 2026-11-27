import Link from "next/link";
import { BRAND } from "@/lib/brand";

// BARE ON PURPOSE. The landing page for signed-out visitors: the name, the tagline and the two
// ways in. It is replaced when the visual identity is chosen. Keep the two links findable by
// role and name ("Create an account", "Sign in").

export function Landing() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{BRAND.name}</h1>
      <p>{BRAND.tagline}</p>
      <nav aria-label="Account" className="flex flex-wrap gap-4">
        <Link href="/sign-up" className="rounded border px-4 py-2 font-medium">
          Create an account
        </Link>
        <Link href="/sign-in" className="rounded border px-4 py-2 font-medium">
          Sign in
        </Link>
      </nav>
    </section>
  );
}
