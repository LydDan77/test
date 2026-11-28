import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Party, Person, Plan, Site } from "@/db/schema";
import { isToken } from "@/lib/ids";
import { isValidSlug } from "@/lib/slugs";
import { isSiteUnlocked } from "./passcode";

// Who is looking at a share page.
//
//   findGuestByToken(slug, token)   the household (and person) a personal link belongs to
//   visitorFor(slug, token?)        what this visitor may see: nothing, the page, or the page as a guest
//
// A guest link is /[slug]/g/[guestToken]. The token is the permission, and it only works on
// the page of the plan it belongs to: it is looked up together with the slug, in one query, so
// a token from one plan can never open another plan's page.

/** A share page without the one field no page code should ever hold. */
export type SiteWithoutSecret = Omit<Site, "passcodeHash">;

export type Guest = {
  site: SiteWithoutSecret;
  plan: Plan;
  /** The household the link belongs to. */
  party: Party;
  /** Set when the link is one person's own, not the household's. */
  person: Person | null;
};

function withoutSecret(site: Site): SiteWithoutSecret {
  const { passcodeHash: _passcodeHash, ...rest } = site;
  void _passcodeHash;
  return rest;
}

async function findPublishedSite(slug: string): Promise<{ site: Site; plan: Plan } | null> {
  if (typeof slug !== "string" || !isValidSlug(slug)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ site: schema.sites, plan: schema.plans })
    .from(schema.sites)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.sites.planId))
    .where(and(eq(schema.sites.slug, slug), eq(schema.sites.status, "published")))
    .limit(1);
  return row ?? null;
}

async function findGuest(site: Site, plan: Plan, token: unknown): Promise<Guest | null> {
  // Shape first: junk never reaches the database, and never appears in a query error.
  if (!isToken(token)) return null;
  const db = await getDb();

  // The household's link. The party must belong to this page's plan.
  const [party] = await db
    .select()
    .from(schema.parties)
    .where(and(eq(schema.parties.guestToken, token), eq(schema.parties.planId, plan.id)))
    .limit(1);
  if (party) return { site: withoutSecret(site), plan, party, person: null };

  // One person's own link.
  const [own] = await db
    .select({ person: schema.people, party: schema.parties })
    .from(schema.people)
    .innerJoin(schema.parties, and(eq(schema.parties.id, schema.people.partyId), eq(schema.parties.planId, schema.people.planId)))
    .where(and(eq(schema.people.guestToken, token), eq(schema.people.planId, plan.id)))
    .limit(1);
  return own ? { site: withoutSecret(site), plan, party: own.party, person: own.person } : null;
}

/**
 * The guest a personal link belongs to, or null. Null covers every miss alike: no such page,
 * a page that is not published, a token that is not one, a token of another plan.
 *
 * Call rateLimit() first in a guest action. Guessing a token is hopeless (256 random bits);
 * the limit is there for the work each try costs.
 */
export async function findGuestByToken(slug: string, token: unknown): Promise<Guest | null> {
  const found = await findPublishedSite(slug);
  if (!found) return null;
  return findGuest(found.site, found.plan, token);
}

export type SiteVisitor =
  /** No such page, or it is not published. Render the not-found page. */
  | { state: "not_found" }
  /** The page asks for its passcode and this browser has not entered it. Show only the passcode form. */
  | { state: "locked"; title: string }
  | {
      state: "open";
      /**
       * "guest": opened a personal link, or entered the passcode. Sees guests-only sections.
       * "everyone": has only the address. Decide what they see with sectionIsVisibleTo().
       */
      viewer: "everyone" | "guest";
      site: SiteWithoutSecret;
      plan: Plan;
      /** Whose link it is, when it is a personal link. */
      party: Party | null;
      person: Person | null;
    };

/**
 * What the visitor of /[slug] (or /[slug]/g/[guestToken]) may see, per product spec 9.3:
 *  - a personal link always opens its own page, as a guest;
 *  - a page with a passcode is locked until this browser has entered it, then open as a guest;
 *  - a page without one is open to anyone with the address, as "everyone".
 * Reads cookies, so call it inside <Suspense> or in an action.
 */
export async function visitorFor(slug: string, guestToken?: unknown): Promise<SiteVisitor> {
  const found = await findPublishedSite(slug);
  if (!found) return { state: "not_found" };
  const { site, plan } = found;

  if (guestToken !== undefined) {
    const guest = await findGuest(site, plan, guestToken);
    // A wrong token is not a reason to show the ordinary page: the address was wrong.
    if (!guest) return { state: "not_found" };
    return { state: "open", viewer: "guest", site: guest.site, plan, party: guest.party, person: guest.person };
  }

  if (site.access === "passcode") {
    // A page set to "passcode" with none stored stays shut: nobody can have entered it.
    if (!(await isSiteUnlocked(site))) return { state: "locked", title: site.title };
    return { state: "open", viewer: "guest", site: withoutSecret(site), plan, party: null, person: null };
  }
  return { state: "open", viewer: "everyone", site: withoutSecret(site), plan, party: null, person: null };
}
