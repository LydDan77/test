import "server-only";

import { and, eq, or } from "drizzle-orm";
import type { BookingDetails } from "@/lib/domain";
import { getDb, schema } from "./index";

// Removing a person from a plan, properly.
//
// The database clears the columns that point at a person (a task's assignee, an arrival's
// driver, a booking's payer). It cannot do the two things that matter most:
//  - Money. A person who paid for something, shares a cost or has a payment recorded cannot
//    disappear without changing what everyone else owes. So that is refused, with the counts,
//    and the screen says "Carol has payments recorded" instead. (For settlements the database
//    refuses too; for expenses only this function does.)
//  - The ids kept inside jsonb: who a booking covers, who is in which room or seat, who rides,
//    who is on an arrival, who a schedule item is for, who was at a meal. Nothing ties those to
//    the people table, so they would stay behind, naming nobody. They are taken out here.

export type RemovePersonResult =
  | {
      ok: true;
      /**
       * Schedule items that were for this person alone. An empty list of people means "everyone",
       * so each of these now reads as being for everyone; they were made private (organizer
       * only) so that nothing new appears on the share page. Tell the organizer.
       */
      itemsLeftWithNobody: string[];
    }
  | { ok: false; reason: "not_found" }
  | {
      ok: false;
      /** They paid for something, share a cost, or have a payment to or from them. */
      reason: "has_money";
      /** Payments recorded to or from them. */
      settlements: number;
      /** Expenses they paid for. */
      expensesPaid: number;
      /** Expenses they share the cost of. */
      expensesShared: number;
    };

const without = (ids: readonly string[] | null | undefined, personId: string): string[] | null => {
  if (!ids || !ids.includes(personId)) return null;
  return ids.filter((id) => id !== personId);
};

/** The details of a booking with one person taken out, or null when they are not in it. */
export function bookingDetailsWithoutPerson(details: BookingDetails, personId: string): BookingDetails | null {
  switch (details.kind) {
    case "flight": {
      if (!details.segments.some((segment) => segment.seats && personId in segment.seats)) return null;
      return {
        ...details,
        segments: details.segments.map((segment) => {
          if (!segment.seats || !(personId in segment.seats)) return segment;
          const seats = Object.fromEntries(Object.entries(segment.seats).filter(([id]) => id !== personId));
          return { ...segment, seats };
        }),
      };
    }
    case "lodging": {
      if (!details.rooms.some((room) => room.personIds.includes(personId))) return null;
      return { ...details, rooms: details.rooms.map((room) => ({ ...room, personIds: room.personIds.filter((id) => id !== personId) })) };
    }
    case "car": {
      const drivers = without(details.driverPersonIds, personId);
      return drivers ? { ...details, driverPersonIds: drivers } : null;
    }
    case "ride": {
      const passengers = without(details.passengerIds, personId);
      if (!passengers && details.driverPersonId !== personId) return null;
      const next = { ...details, passengerIds: passengers ?? details.passengerIds };
      if (next.driverPersonId === personId) delete next.driverPersonId;
      return next;
    }
    case "meal":
    case "shipment":
      return null;
  }
}

/**
 * Removes a person from a plan and every mention of them in it, in one transaction.
 *
 * The caller has already checked that the plan is the user's (requirePlan). Returns
 * `{ ok: false, reason: "has_money", … }` and changes nothing when the person paid for an
 * expense, shares one, or has a settlement: say so to the organizer, who can remove those first.
 * Their party is left in place even if it is now empty.
 */
export async function removePerson(planId: string, personId: string): Promise<RemovePersonResult> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(eq(schema.people.id, personId), eq(schema.people.planId, planId)))
      .limit(1);
    if (!person) return { ok: false, reason: "not_found" } as const;

    const settlements = await tx
      .select({ id: schema.settlements.id })
      .from(schema.settlements)
      .where(and(eq(schema.settlements.planId, planId), or(eq(schema.settlements.fromPersonId, personId), eq(schema.settlements.toPersonId, personId))));
    const expenses = await tx
      .select({ id: schema.expenses.id, paidByPersonId: schema.expenses.paidByPersonId, split: schema.expenses.split, attendeeIds: schema.expenses.attendeeIds })
      .from(schema.expenses)
      .where(eq(schema.expenses.planId, planId));
    const expensesPaid = expenses.filter((expense) => expense.paidByPersonId === personId).length;
    const expensesShared = expenses.filter((expense) => expense.split.parts.some((part) => part.personId === personId)).length;
    if (settlements.length > 0 || expensesPaid > 0 || expensesShared > 0) {
      return { ok: false, reason: "has_money", settlements: settlements.length, expensesPaid, expensesShared } as const;
    }

    // Who was at a meal has no bearing on who owes what.
    for (const expense of expenses) {
      const attendeeIds = without(expense.attendeeIds, personId);
      if (attendeeIds) await tx.update(schema.expenses).set({ attendeeIds }).where(eq(schema.expenses.id, expense.id));
    }

    const bookings = await tx
      .select({ id: schema.bookings.id, personIds: schema.bookings.personIds, details: schema.bookings.details })
      .from(schema.bookings)
      .where(eq(schema.bookings.planId, planId));
    for (const booking of bookings) {
      const personIds = without(booking.personIds, personId);
      const details = bookingDetailsWithoutPerson(booking.details, personId);
      if (personIds || details) {
        await tx
          .update(schema.bookings)
          .set({ ...(personIds ? { personIds } : {}), ...(details ? { details } : {}) })
          .where(eq(schema.bookings.id, booking.id));
      }
    }

    const arrivals = await tx
      .select({ id: schema.arrivals.id, personIds: schema.arrivals.personIds })
      .from(schema.arrivals)
      .where(eq(schema.arrivals.planId, planId));
    for (const arrival of arrivals) {
      const personIds = without(arrival.personIds, personId);
      if (personIds) await tx.update(schema.arrivals).set({ personIds }).where(eq(schema.arrivals.id, arrival.id));
    }

    const items = await tx
      .select({ id: schema.itineraryItems.id, personIds: schema.itineraryItems.personIds })
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.planId, planId));
    const itemsLeftWithNobody: string[] = [];
    for (const item of items) {
      const personIds = without(item.personIds, personId);
      if (!personIds) continue;
      if (personIds.length > 0) {
        await tx.update(schema.itineraryItems).set({ personIds }).where(eq(schema.itineraryItems.id, item.id));
      } else {
        // It was theirs alone, and an empty list means "everyone". Nothing is deleted behind
        // the organizer's back, but nothing new may show up for guests either: make it private.
        await tx.update(schema.itineraryItems).set({ personIds, visibility: "private" }).where(eq(schema.itineraryItems.id, item.id));
        itemsLeftWithNobody.push(item.id);
      }
    }

    // The columns that point at the person (assignee, claimed-by, driver, payer of a booking)
    // are cleared by the database as the row goes.
    await tx.delete(schema.people).where(and(eq(schema.people.id, personId), eq(schema.people.planId, planId)));
    return { ok: true, itemsLeftWithNobody } as const;
  });
}
