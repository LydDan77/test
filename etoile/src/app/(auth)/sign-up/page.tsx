import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signUp } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/auth-form";
import { getUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Create an account" };

// BARE ON PURPOSE: see src/features/auth/auth-form.tsx.
export default function SignUpPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <AuthForm action={signUp} mode="sign-up" />
      <p>
        Already have an account?{" "}
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
      <Suspense fallback={null}>
        <AlreadySignedIn />
      </Suspense>
    </main>
  );
}

/** Someone who is already signed in has no use for this page. */
async function AlreadySignedIn() {
  if (await getUser()) redirect("/");
  return null;
}
