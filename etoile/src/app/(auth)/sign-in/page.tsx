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
//
// The page function is the static shell. The form is rendered at request time, inside
// <Suspense>, because it needs request data: the `?next=` target, and whether the visitor is
// already signed in. The hidden `next` field is rendered by the form component itself, so it
// is always part of the form. (Do not stream a single field into a form that is already on the
// page: until React reveals the streamed part, the field is not in the form, and a quick
// submit goes without it.)
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <SignInForm searchParams={searchParams} />
      </Suspense>
      <p>
        New here?{" "}
        <Link href="/sign-up" className="underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}

async function SignInForm({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { next } = await searchParams;
  // Validated here and again in the action: it can only ever be a path on this site.
  const target = safeNextPath(typeof next === "string" ? next : undefined);
  // Someone who is already signed in is sent straight to where they were going.
  if (await getUser()) redirect(target as Route);
  return <AuthForm action={signIn} mode="sign-in" next={target} />;
}
