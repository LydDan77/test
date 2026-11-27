// People logic: the arrivals board, who's coming, dietary and access needs, where everyone is
// sleeping, travel status per attendee, and "where is everybody" on the day of travel.
// Import from "@/lib/people". Pure: every function takes plan rows (a PlanData or the parts
// named in its input type) plus `now`, and returns plain data.

export * from "./arrivals";
export * from "./sleeping";
export * from "./summary";
export * from "./travel-status";
export * from "./whereabouts";
export { isExpected, hasReplied, flightEnds, flightPassengerIds, stayName, type FlightEnds } from "./shared";
export {
  clockText,
  count,
  dayText,
  durationWords,
  firstNameOf,
  firstNames,
  listOf,
  type Wording,
} from "./text";
