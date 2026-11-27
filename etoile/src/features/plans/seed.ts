import "server-only";

import type { SessionUser } from "@/lib/auth";

// ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
// │ NOT BUILT YET. This is a deliberate no-op left by the foundation.                              │
// │                                                                                                │
// │ Sign-up calls seedExamplePlan(user) right after the account and its home clock exist.         │
// │ Whoever builds plans fills this in: create the example plan "Hartley Family Christmas"         │
// │ exactly as in product spec 11.5 with the corrections of 15.1 (BUILD-SPEC section 3, item 7):   │
// │  - dates relative to today in the user's home zone, so it always starts 23 days out;           │
// │  - plans.isExample = true, clearly labelled "Example", removable in one action                 │
// │    (set users.exampleState to "removed" when it is removed);                                   │
// │  - it must compute to 68% ready.                                                               │
// │                                                                                                │
// │ Contract: reach the database with getDb(); do not throw for expected problems. Sign-up         │
// │ catches and logs anything thrown here and carries on, so a broken seed never blocks an         │
// │ account from being created.                                                                    │
// └──────────────────────────────────────────────────────────────────────────────────────────────┘

/** Creates the example plan for a brand-new account. Currently does nothing. */
export async function seedExamplePlan(user: SessionUser): Promise<void> {
  void user;
}
