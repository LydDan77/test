// Domain types: the Zod schemas and inferred TypeScript types for every JSON shape and every
// fixed list of values in the data model. Import from "@/lib/domain".
//
// Pure, with no server-only imports: usable in server code, client components and tests.
// The database schema (src/db/schema.ts) types its jsonb columns with the types exported here.

export * from "./enums";
export * from "./common";
export * from "./place";
export * from "./money";
export * from "./zoned-instant";
export * from "./booking-flight";
export * from "./booking-lodging";
export * from "./booking-car";
export * from "./booking-ride";
export * from "./booking-meal";
export * from "./booking-shipment";
export * from "./booking";
export * from "./plan";
export * from "./expense";
export * from "./site";
export * from "./locale";
