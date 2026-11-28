// Accounts and access. Import from "@/lib/auth".
//
//   getUser()                  the signed-in user or null
//   requireUser()              the signed-in user, or a redirect to /sign-in
//   requirePlan(user, planId)  the plan if the user owns it, or the not-found page
//   requireParty(plan, id)     a party / person / booking if it is part of that plan, or the
//   requirePerson(plan, id)    not-found page. Every such id that comes from a browser goes
//   requireBooking(plan, id)   through one of these (or find…InPlan, peopleInPlan).
//
// All three read the session cookie, so in a page they must run inside <Suspense>.

export { getUser, type SessionUser } from "./session";
export {
  findBookingInPlan,
  findOwnedPlan,
  findPartyInPlan,
  findPersonInPlan,
  peopleInPlan,
  requireBooking,
  requireParty,
  requirePerson,
  requirePlan,
  requireUser,
} from "./require";
export { safeNextPath } from "./next-path";
