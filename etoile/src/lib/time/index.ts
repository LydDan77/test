// The time library. Import from "@/lib/time".
//
// Rules (BUILD-SPEC 5.3):
//  - An instant is a UTC timestamp and always travels with an IANA zone.
//  - A local calendar date is a `YYYY-MM-DD` string.
//  - A time is shown in the local time of the place where it happens.
//  - Never call `new Date()` to mean "local time somewhere". Take `now` as an argument and
//    say which zone you mean: localDateOf(now, tz), formatClock(now, tz).
//  - No React in here. Components take the strings these functions return.

export * from "./symbols";
export * from "./zoned";
export * from "./clock";
export * from "./home";
export * from "./dates";
export * from "./sun";
