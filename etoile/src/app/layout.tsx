import type { Metadata, Viewport } from "next";
import { HydrationMarker } from "@/components/hydration-marker";
import { BRAND } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
  // Nothing in this app is meant for search engines yet; share pages never are.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Runs while the HTML is parsed, before first paint, so there is no light/dark flash.
// Stored value: "light" | "dark". Absent means "follow the system".
// Do not read a theme cookie here with cookies(): that would make every route wait on the request.
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

// The form guard. Until React is running on the page, a submitted form would go to the server
// as a plain browser POST. In this version of Next.js that is broken for partially prerendered
// pages: when the action returns a value instead of redirecting (a wrong password, a field
// error), the response has no document around it and the person sees a blank page. It only
// happens in a production build, on a slow connection, so tests against `next dev` never see it.
//
// So: a form submitted before the page is interactive is held, and sent the moment React is
// ready (HydrationMarker calls window.__etoileHydrated). Nothing is lost; the person just waits
// for the scripts they were already waiting for. Only POST forms are held (Server Actions);
// GET forms, such as a search box, are ordinary navigations and go through untouched.
// e2e/auth.spec.ts ("a form sent before the page's scripts have loaded") covers this.
const formGuardScript = `(function(){var ready=false,held=null;function hydrated(f){for(var k in f)if(k.lastIndexOf("__reactProps$",0)===0)return true;return false}function send(){var h=held;held=null;if(!h||!h.form.isConnected)return;var tries=0;(function go(){if(hydrated(h.form)||tries++>40){h.form.requestSubmit(h.submitter&&h.submitter.isConnected?h.submitter:undefined)}else{setTimeout(go,50)}})()}document.addEventListener("submit",function(e){var f=e.target;if(ready||!(f instanceof HTMLFormElement))return;if((f.getAttribute("method")||"get").toLowerCase()!=="post")return;e.preventDefault();e.stopPropagation();held={form:f,submitter:e.submitter}},true);window.__etoileHydrated=function(){ready=true;send()}})()`;

// The root layout is part of every page's static shell: it must stay synchronous and read
// nothing at request time (no cookies, no session, no database).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the inline script may add data-theme before React hydrates.
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: formGuardScript }} />
      </head>
      <body className="min-h-full">
        <noscript>
          <p className="p-6">{BRAND.name} needs JavaScript to work. Please turn it on in your browser and reload this page.</p>
        </noscript>
        {children}
        <HydrationMarker />
      </body>
    </html>
  );
}
