import { afterEach, describe, expect, it, vi } from "vitest";

// How the session cookie is named and protected is decided once, when the module loads, from
// the environment. Each test sets the environment, then loads a fresh copy of the module.

const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
const sets: { name: string; value: string; options?: Record<string, unknown> }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      sets.push({ name, value, options });
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, { value, options });
    },
    delete: () => {
      throw new Error("cookies().delete() must not be used: it cannot remove a __Host- cookie");
    },
  }),
}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

async function load(env: Record<string, string>) {
  vi.resetModules();
  jar.clear();
  sets.length = 0;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("SESSION_COOKIE_INSECURE", "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { createTestDb } = await import("@/db/testing");
  const { schema } = await import("@/db");
  const t = await createTestDb();
  const [user] = await t.db
    .insert(schema.users)
    .values({ email: "prod@example.com", name: "Prod", passwordHash: "x", home: { kind: "home", name: "UTC", tz: "UTC" } })
    .returning();
  const session = await import("./session");
  const device = await import("./device");
  return { t, user, session, device };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the session cookie in a production build", () => {
  it("is __Host-, Secure, HttpOnly and SameSite=Lax, and is removed with the same attributes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t, user, session, device } = await load({});
    try {
      expect(session.SESSION_COOKIE).toBe("__Host-etoile_session");
      expect(session.SECURE_COOKIE).toBe(true);
      expect(device.DEVICE_COOKIE).toBe("__Host-etoile_device");

      await session.createSession(user.id);
      expect(sets[0]).toMatchObject({ name: "__Host-etoile_session", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/" } });
      expect(sets[0].options).not.toHaveProperty("domain"); // a __Host- cookie may not have one
      expect((await session.getUser())?.id).toBe(user.id);

      await session.destroySession();
      // This is the header a browser will actually act on: Secure is there.
      expect(sets[1]).toEqual({ name: "__Host-etoile_session", value: "", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 } });
      expect(jar.size).toBe(0);
      expect(await session.getUser()).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await t.close();
    }
  });

  it("honours SESSION_COOKIE_INSECURE=1 off Vercel (the end-to-end test server), and says so loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t, user, session } = await load({ SESSION_COOKIE_INSECURE: "1" });
    try {
      expect(session.SESSION_COOKIE).toBe("etoile_session");
      expect(session.SECURE_COOKIE).toBe(false);
      await session.createSession(user.id);
      expect(sets[0]).toMatchObject({ name: "etoile_session", options: { secure: false, httpOnly: true } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("SESSION_COOKIE_INSECURE=1 in a production build");
    } finally {
      await t.close();
    }
  });

  it("ignores SESSION_COOKIE_INSECURE=1 on Vercel: the cookie stays Secure and __Host-", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t, user, session } = await load({ SESSION_COOKIE_INSECURE: "1", VERCEL: "1" });
    try {
      expect(session.SESSION_COOKIE).toBe("__Host-etoile_session");
      expect(session.SECURE_COOKIE).toBe(true);
      await session.createSession(user.id);
      expect(sets[0]).toMatchObject({ name: "__Host-etoile_session", options: { secure: true } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await t.close();
    }
  });
});
