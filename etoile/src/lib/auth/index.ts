// Accounts and access. Import from "@/lib/auth".
//
//   getUser()                  the signed-in user or null
//   requireUser()              the signed-in user, or a redirect to /sign-in
//   requirePlan(user, planId)  the plan if the user owns it, or the not-found page
//
// All three read the session cookie, so in a page they must run inside <Suspense>.

export { getUser, type SessionUser } from "./session";
export { findOwnedPlan, requirePlan, requireUser } from "./require";
export { safeNextPath } from "./next-path";
