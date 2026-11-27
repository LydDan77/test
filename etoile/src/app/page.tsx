import { Suspense } from "react";
import { Home } from "@/features/home/home";
import { Landing } from "@/features/marketing/landing";
import { getUser } from "@/lib/auth";
import { requestNow } from "@/lib/request";

// "/" is one address with two faces: the landing page for a signed-out visitor, Home for a
// signed-in one. (Two route groups cannot both own "/", so the choice is made here.)
//
// The page function is synchronous and reads nothing at request time: it is the static shell.
// The session is read by a child inside <Suspense>, which streams in.
export default function RootPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <HomeOrLanding />
      </Suspense>
    </main>
  );
}

async function HomeOrLanding() {
  const user = await getUser();
  if (!user) return <Landing />;
  // The current time is request data too: read it here, pass it down.
  return <Home user={user} now={await requestNow()} />;
}
