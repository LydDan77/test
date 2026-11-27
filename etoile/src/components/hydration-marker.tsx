"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    /** Defined by the inline script in src/app/layout.tsx. */
    __etoileHydrated?: () => void;
  }
}

/**
 * Tells the form guard in src/app/layout.tsx that React is now running on this page, so forms
 * can be submitted. Rendered once, in the root layout. Renders nothing.
 */
export function HydrationMarker() {
  useEffect(() => {
    window.__etoileHydrated?.();
  }, []);
  return null;
}
