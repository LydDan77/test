// Send ahead: shipping luggage, boxes, gifts, gear or mail to the destination before arriving.
// Import from "@/lib/shipping". Pure logic, no React, no database, no clock: usable on the
// server, in client components and in tests.
//
// The flow, and the function for each step:
//
//   What are you sending?          suggestContentFlags(), contentsWarnings(), customsNotes()
//   Where is it going?             sendAheadDefaultsFromStay(), destinationLabel(), pickupPointOptions()
//   When to ship                   shipByPlan(), shipByOptions(), shipByFieldsToStore(), returnPlan()
//   The label                      labelBlock()
//   The note to the hotel or host  propertyMessage(), mailtoUrl(), questionsToAsk(), PROPERTY_CHECKLIST
//   Who to ship with               recommendProviders(), copyTripDetails()
//   Tracking                       detectCarrier(), trackingUrl(), trackingLink(), findTrackingNumbers()
//   Where it stands                shipmentStatus(), withParcelStatus(), withTrackingNumber()
//   Her own mail while away        mailOptions()
//
// Every number (carrier holidays, transit days, hold windows, fees, tracking links) is in
// ./config, with its source. Transit times are planning estimates, not carrier quotes, and the
// app cannot read where a parcel is: she sets "shipped" and "arrived" herself.

export * from "./config";
export {
  DESTINATION_WORDS,
  PROVIDER_NAMES,
  carrierName,
  destinationLabel,
  isPickupPoint,
  isStaffedProperty,
  parcelNoun,
} from "./words";
export * from "./calendar";
export * from "./zones";
export * from "./ship-by";
export * from "./tracking";
export * from "./label";
export * from "./message";
export * from "./contents";
export * from "./providers";
export * from "./pickup";
export * from "./status";
export * from "./from-stay";
