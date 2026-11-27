import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signUp } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/auth-form";
import { getUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Create an account" };

// BARE ON PURPOSE: see src/features/auth/auth-form.tsx.
// The form is rendered at request time, inside <Suspense>, because whether to show it depends
// on the session: someone who is already signed in is sent to Home instead.
export default function SignUpPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <SignUpForm />
      </Suspense>
      <p>
        Already have an account?{" "}
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}

async function SignUpForm() {
  // Someone who is already signed in has no use for this page.
  if (await getUser()) redirect("/");
  return <AuthForm action={signUp} mode="sign-up" />;
}
