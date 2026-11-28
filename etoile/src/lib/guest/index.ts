// Everything a share page needs to decide who is looking and what they may hold.
// Import from "@/lib/guest". Read AGENTS.md, "Share pages", before building one.
//
//   visitorFor(slug, guestToken?)        not found / locked / open as "everyone" or "guest"
//   findGuestByToken(slug, token)        whose personal link this is (for guest actions)
//   checkSitePasscode(slug, passcode)    a visitor enters the passcode; rate-limited; remembers the browser
//   setSitePasscode(planId, passcode)    the organizer sets, changes or removes it
//   toPublicPlanData(planData, viewer)   the only form of a plan a share page ever holds

export { findGuestByToken, visitorFor, type Guest, type SiteVisitor, type SiteWithoutSecret } from "./visitor";
export {
  PASSCODE_MAX_LENGTH,
  PASSCODE_MIN_LENGTH,
  checkSitePasscode,
  isSiteUnlocked,
  rememberSiteUnlocked,
  setSitePasscode,
  type CheckPasscodeResult,
  type SetPasscodeResult,
} from "./passcode";
export {
  toPublicBookingDetails,
  toPublicPlace,
  toPublicPlanData,
  type PublicArrival,
  type PublicBooking,
  type PublicItem,
  type PublicParty,
  type PublicPerson,
  type PublicPlan,
  type PublicPlanData,
  type PublicSite,
  type PublicTask,
  type Viewer,
} from "./public-data";
