import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signIn } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/auth-form";
import { getUser, safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };

// BARE ON PURPOSE: see src/features/auth/auth-form.tsx.
// The whole form is in the static shell. The only request-time work is noticing that the
// visitor is already signed in, which streams in behind <Suspense> and renders nothing.
//
// Where to go after signing in (`?next=`) is NOT rendered here: the form reads it in the
// browser and the action falls back to the request's Referer, so it never depends on a streamed
// part of the page having arrived.
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <AuthForm action={signIn} mode="sign-in" />
      <p>
        New here?{" "}
        <Link href="/sign-up" className="underline">
          Create an account
        </Link>
      </p>
      <Suspense fallback={null}>
        <AlreadySignedIn searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** Someone who is already signed in is sent straight to where they were going. */
async function AlreadySignedIn({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { next } = await searchParams;
  if (await getUser()) redirect(safeNextPath(typeof next === "string" ? next : undefined) as Route);
  return null;
}
