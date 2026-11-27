import type { Metadata, Viewport } from "next";
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

// The root layout is part of every page's static shell: it must stay synchronous and read
// nothing at request time (no cookies, no session, no database).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the inline script may add data-theme before React hydrates.
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
