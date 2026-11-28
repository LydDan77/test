import { afterEach, describe, expect, it, vi } from "vitest";

// headers() only works inside a request; clientIp() is tested through a stand-in.
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

import { UNKNOWN_ADDRESS, clientIp, clientIpFrom, normalizeAddress, platformTimeZone } from "./request";

const reader = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

afterEach(() => {
  requestHeaders.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clientIpFrom", () => {
  it("believes no header when it has not been told who is in front of the server", () => {
    // This is what a visitor can send straight to `next start`. None of it chooses the answer.
    const spoofed: Record<string, string>[] = [
      { "x-real-ip": "10.9.8.1" },
      { "x-forwarded-for": "10.7.7.7" },
      { "x-forwarded-for": "10.7.7.7, 198.51.100.4", "x-real-ip": "10.9.8.2" },
      {},
    ];
    for (const sent of spoofed) expect(clientIpFrom(reader(sent), {}), JSON.stringify(sent)).toBe(UNKNOWN_ADDRESS);
    expect(clientIpFrom(reader({ "x-forwarded-for": "10.7.7.7" }), { TRUSTED_PROXY_COUNT: "0" })).toBe(UNKNOWN_ADDRESS);
    expect(clientIpFrom(reader({ "x-forwarded-for": "10.7.7.7" }), { TRUSTED_PROXY_COUNT: "many" })).toBe(UNKNOWN_ADDRESS);
  });

  it("takes the entry written by our own outermost proxy, counted from the right", () => {
    const one = { TRUSTED_PROXY_COUNT: "1" };
    // One proxy: it appended the address it saw. Whatever the visitor put first is ignored.
    expect(clientIpFrom(reader({ "x-forwarded-for": "203.0.113.7" }), one)).toBe("203.0.113.7");
    expect(clientIpFrom(reader({ "x-forwarded-for": "10.7.7.7, 203.0.113.7" }), one)).toBe("203.0.113.7");
    expect(clientIpFrom(reader({ "x-forwarded-for": "1.1.1.1,2.2.2.2 , 203.0.113.7" }), one)).toBe("203.0.113.7");
    // x-real-ip is never read off a platform that does not own it.
    expect(clientIpFrom(reader({ "x-real-ip": "10.9.8.1", "x-forwarded-for": "203.0.113.7" }), one)).toBe("203.0.113.7");
    expect(clientIpFrom(reader({ "x-real-ip": "10.9.8.1" }), one)).toBe(UNKNOWN_ADDRESS);

    const two = { TRUSTED_PROXY_COUNT: "2" };
    // Two proxies (a CDN, then a load balancer): visitor, then the CDN's own address.
    expect(clientIpFrom(reader({ "x-forwarded-for": "203.0.113.7, 172.16.0.9" }), two)).toBe("203.0.113.7");
    expect(clientIpFrom(reader({ "x-forwarded-for": "10.7.7.7, 203.0.113.7, 172.16.0.9" }), two)).toBe("203.0.113.7");
    // Fewer entries than proxies: the request did not come the way we were told. Believe nothing.
    expect(clientIpFrom(reader({ "x-forwarded-for": "10.7.7.7" }), two)).toBe(UNKNOWN_ADDRESS);
    // An entry that is not an address at all.
    expect(clientIpFrom(reader({ "x-forwarded-for": "<script>" }), one)).toBe(UNKNOWN_ADDRESS);
    expect(clientIpFrom(reader({ "x-forwarded-for": "unknown" }), one)).toBe(UNKNOWN_ADDRESS);
  });

  it("uses the platform's own header on Vercel, whatever else is set", () => {
    const vercel = { VERCEL: "1", TRUSTED_PROXY_COUNT: "3" };
    expect(clientIpFrom(reader({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" }), vercel)).toBe("203.0.113.7");
    expect(clientIpFrom(reader({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), vercel)).toBe("198.51.100.4");
    expect(clientIpFrom(reader({}), vercel)).toBe(UNKNOWN_ADDRESS);
  });

  it("warns once, in production, when the address cannot be known", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientIpFrom(reader({}), { NODE_ENV: "development" });
    expect(warn).not.toHaveBeenCalled();
    clientIpFrom(reader({}), { NODE_ENV: "production" });
    clientIpFrom(reader({}), { NODE_ENV: "production" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("TRUSTED_PROXY_COUNT is not set");
  });
});

describe("normalizeAddress", () => {
  it("keeps an IPv4 address and counts IPv6 by /64", () => {
    expect(normalizeAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeAddress("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    // One home connection: any address in its /64 is the same visitor.
    const first = normalizeAddress("2001:db8:12:34:aaaa:bbbb:cccc:dddd");
    expect(first).toBe("2001:db8:12:34::/64");
    expect(normalizeAddress("2001:0db8:0012:0034:1::2")).toBe(first);
    expect(normalizeAddress("[2001:db8:12:34::1]:443")).toBe(first);
    expect(normalizeAddress("2001:DB8:12:34::1")).toBe(first);
    expect(normalizeAddress("2001:db8:12:35::1")).not.toBe(first);
    expect(normalizeAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeAddress("::1")).toBe("0:0:0:0::/64");
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeAddress("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("gives null for anything that is not an address", () => {
    for (const junk of ["", "   ", "unknown", "localhost", "999.1.1.1", "1.2.3", "2001:db8:::1", "203.0.113.7, 10.0.0.1", "<script>", null, undefined]) {
      expect(normalizeAddress(junk), String(junk)).toBeNull();
    }
  });
});

describe("clientIp", () => {
  it("reads the request's headers", async () => {
    requestHeaders.set("x-forwarded-for", "10.7.7.7, 203.0.113.7");
    expect(await clientIp()).toBe(UNKNOWN_ADDRESS);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    expect(await clientIp()).toBe("203.0.113.7");
  });

  it("platformTimeZone reads the platform's header", async () => {
    expect(await platformTimeZone()).toBeNull();
    requestHeaders.set("x-vercel-ip-timezone", " America/Denver ");
    expect(await platformTimeZone()).toBe("America/Denver");
  });
});
