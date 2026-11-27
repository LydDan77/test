import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAMES } from "@/lib/auth/cookie-names";

// Next.js 16: this file used to be middleware.ts. It always runs on the Node.js runtime.
// Keep it cheap: no database access here. It only checks that a session cookie is present,
// which saves rendering a page that would redirect anyway. The real check (cookie -> session
// row -> user) happens in getUser()/requireUser() next to the data. Never rely on this file
// for access control.

export function proxy(request: NextRequest) {
  if (SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) return NextResponse.next();
  const signIn = new URL("/sign-in", request.url);
  // The path only, never a full URL: sign-in validates it again with safeNextPath().
  signIn.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Only the routes that need an account. "/" (landing or Home), the auth pages, the public
  // share pages at /[slug] and static assets never reach the proxy.
  // Add a new signed-in top-level route here AND to RESERVED_SLUGS in src/lib/slugs.ts.
  matcher: ["/plans/:path*", "/heads-up/:path*", "/you/:path*"],
};
