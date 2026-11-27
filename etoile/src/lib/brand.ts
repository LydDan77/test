// Every brand string in the app comes from here. Never write the name inline.

export const BRAND = {
  /** Display name. Use wherever a person reads it. */
  name: "Étoile",
  /** ASCII form, for anything that cannot carry the accent: package name, slugs, cookie names. */
  ascii: "etoile",
  tagline: "Plan it. Share it. Know before you go.",
  /** Public host of the hosted app. Share pages read as `etoile.app/hartley-christmas`. */
  domain: "etoile.app",
} as const;

export type Brand = typeof BRAND;

/** `etoile.app/hartley-christmas`: how a share page's address is written for people. */
export function sitePublicAddress(slug: string): string {
  return `${BRAND.domain}/${slug}`;
}
