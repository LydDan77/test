// "Things left": the progress score, its breakdown, the next action, the plain-language list
// of what is incomplete, and one line of state for each of a plan's ten tools.
// Import from "@/lib/readiness". Pure.

export * from "./types";
export { computeReadiness, toolStates, type ReadinessOptions } from "./readiness";
