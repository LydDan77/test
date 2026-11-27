// The booking logic. Import from "@/lib/booking".
//
// The flow a booking tool walks (build spec 3.5, product spec 6.2):
//
//   1. proposeSearch(kind, ctx)         what to look for, filled in from the plan, as editable lines
//      reviseProposal(proposal, {...})  after the person changes a line
//   2. handoffLinks(proposal, ctx)      the provider buttons, each with what it could not prefill
//   3. parseConfirmation(text, hint)    when they come back and paste the confirmation
//   4. suggestNextSteps(planData, now)  what to offer once it is saved
//
// Alongside: actByFor (when to book by), flightStatusLinks and mapsLinks (trackers, directions),
// bookingDetailsFromQuery (a proposal as the details of a "planned" booking).
//
// Everything is pure: plan data and `now` are arguments. No database, no network, no clock.

export * from "./types";
export { PROVIDERS, PROVIDER_IDS, providerInfo, providerName, providerHomeUrl, FOOD_ORDER_WINDOW_DAYS, RIDE_RESERVATION_WINDOW_DAYS } from "./providers";
export type { ProviderId, ProviderInfo } from "./providers";
export { proposeSearch, orderWindowNote, orderOpensOn, estimateDriveMinutes } from "./propose";
export { reviseProposal, fieldsForQuery, summaryForQuery } from "./fields";
export { handoffLinks, providerOrder, proposalForBooking, flightStatusLinks, mapsLinks, hasHandoff } from "./links";
export { bookingDetailsFromQuery } from "./details";
export { parseConfirmation, toFlightSegments } from "./parse";
export type {
  ParsedConfirmation,
  ParsedFields,
  ParsedFlightSegment,
  ParseHint,
  ParsedKind,
  FlightFields,
  StayFields,
  CarFields,
  RideFields,
  FoodFields,
} from "./parse";
export { suggestNextSteps } from "./next-steps";
export type { NextStep, NextStepOptions, SuggestedTask } from "./next-steps";
export { actByFor } from "./act-by";
export type { ActByDates, ActByLevel, ActByOptions, ShipByLookup } from "./act-by";
export { holidayPeriodTouching, holidayPeriodsForYear } from "./holiday-periods";
export type { HolidayPeriod } from "./holiday-periods";
export { TIMINGS, airportRuns, headCount, headCountText, groupText, dietarySummary, comingPeople } from "./context";
export type { AirportRun, HeadCount } from "./context";
