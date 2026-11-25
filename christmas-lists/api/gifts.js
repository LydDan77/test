// Shared state lives entirely in Vercel Blob path names, so every read is one
// consistent list() call and nothing depends on cached blob contents:
//   lock/<id>                               first-come lock; creating it fails if it exists
//   bought/<id>/<owner>/_                   a claim (owner = hash of the claimer's device key; no names are kept or shown)
//   added/<kid>/<id>/<base64url name>/<owner>   a gift someone added on the page
// Older markers without an owner (bought/<id>[/<buyer>], added/<kid>/<id>/<name>)
// are still read; only the organizer can change those.
import { list, put, del } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const KIDS = ["aria", "ella", "eyesie"];
const SEED = {
  ella: [
    "Game controller for TV", "Camera", "Laptop", "Paper", "Life-sized bunny plushy",
    "Lava lamp", "Phone", "Markers", "Tape", "Nano tape", "Scissors", "Storage bins",
    "Crayola", "Pencil sharpener", "Pencils", "Fidgets/squishys", "Color paper",
    "Robux", "Twix", "Gummy's", "Candy",
  ],
  eyesie: [
    "Eyesie-sized car", "Real karaoke machine", "Eyesie-sized TV for her room",
    "Taylor Swift twin-sized bed sheets", "Beagle dog stuffy", "Shelf for bedroom",
    "Game controller for her TV", "Side table and lamp for bedroom",
    "Notebook with new markers", "Robux", "Candy", "Razor scooter",
  ],
};
const STALE_LOCK_MS = 30000;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => { try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return ""; } };
const marker = { access: "public", addRandomSuffix: false, contentType: "text/plain" };

function deviceOf(req) {
  const t = String(req.headers["x-device"] || "");
  return /^[A-Za-z0-9_-]{16,64}$/.test(t) ? createHash("sha256").update(t).digest("hex").slice(0, 20) : "";
}
function isOrganizer(req) {
  const code = process.env.ADMIN_CODE || "";
  const got = String(req.headers["x-organizer"] || "");
  return !!code && got.length === code.length && timingSafeEqual(Buffer.from(got), Buffer.from(code));
}

async function listAll() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readState() {
  const blobs = await listAll();
  const claims = new Map(); // id -> { owner, buyer }
  const locks = new Map();  // id -> blob
  const gifts = [];
  for (const [kid, names] of Object.entries(SEED)) {
    names.forEach((name, i) => {
      gifts.push({ id: `${kid}-${String(i + 1).padStart(2, "0")}`, kid, name, order: i + 1 });
    });
  }
  for (const b of blobs) {
    const p = b.pathname.split("/");
    if (p[0] === "lock" && p.length === 2) locks.set(p[1], b);
    if (p[0] === "bought" && p.length === 4) claims.set(p[1], { owner: p[2], buyer: p[3] === "_" ? "" : unb64(p[3]) });
    if (p[0] === "bought" && (p.length === 2 || p.length === 3) && !claims.has(p[1])) {
      claims.set(p[1], { owner: "", buyer: p[2] ? unb64(p[2]) : "" });
    }
    if (p[0] === "added" && (p.length === 4 || p.length === 5) && KIDS.includes(p[1])) {
      const name = unb64(p[3]);
      if (name) {
        gifts.push({ id: p[2], kid: p[1], name, added: true, addedBy: p[4] && p[4] !== "_" ? p[4] : "",
          order: 1000 + new Date(b.uploadedAt).getTime() });
      }
    }
  }
  for (const g of gifts) {
    const c = claims.get(g.id);
    g.purchased = !!c; g.owner = c ? c.owner : ""; g.buyer = c ? c.buyer : "";
  }
  return { blobs, gifts, locks };
}

const urlsFor = (blobs, test) => blobs.filter((b) => test(b.pathname)).map((b) => b.url);
const claimPaths = (id) => (p) => p === `lock/${id}` || p === `bought/${id}` || p.startsWith(`bought/${id}/`);

function view(gifts, me, admin) {
  return {
    organizer: admin,
    gifts: gifts.map((g) => {
      const mine = g.purchased && !!me && g.owner === me;
      return {
        id: g.id, kid: g.kid, name: g.name, order: g.order, added: !!g.added,
        purchased: g.purchased, mine,
        canUndo: g.purchased && (mine || admin),
        canRemove: !!g.added && (admin || (!!me && g.addedBy === me && (!g.purchased || mine))),
      };
    }),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const me = deviceOf(req);
  const admin = isOrganizer(req);
  const fail = async (status, error) => {
    const { gifts } = await readState();
    return res.status(status).json({ error, ...view(gifts, me, admin) });
  };
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const id = String(body.id || "");
      if (body.action === "set") {
        const { blobs, gifts, locks } = await readState();
        const g = gifts.find((x) => x.id === id);
        if (!g) return fail(400, "That gift isn't on the list any more.");
        if (body.purchased) {
          if (!me) return fail(400, "This browser can't claim gifts. Try reloading the page.");
          if (g.purchased) return fail(409, "Someone already claimed that one.");
          const stale = locks.get(id);
          if (stale && Date.now() - new Date(stale.uploadedAt).getTime() > STALE_LOCK_MS) await del(stale.url);
          try {
            // Only one request can create the lock; everyone else gets an error here.
            await put(`lock/${id}`, "1", { ...marker, allowOverwrite: false });
          } catch {
            return fail(409, "Someone else just claimed that one.");
          }
          await put(`bought/${id}/${me}/_`, "1", { ...marker, allowOverwrite: true });
        } else if (g.purchased) {
          if (!(admin || (me && g.owner === me))) {
            return fail(403, "Only the person who claimed it can undo that.");
          }
          const urls = urlsFor(blobs, claimPaths(id));
          if (urls.length) await del(urls);
        }
      } else if (body.action === "remove") {
        const { blobs, gifts } = await readState();
        const g = gifts.find((x) => x.id === id && x.added);
        if (!g) return fail(400, "That gift isn't on the list any more.");
        const mineClaim = g.purchased && me && g.owner === me;
        if (!(admin || (me && g.addedBy === me && (!g.purchased || mineClaim)))) {
          return fail(403, g.purchased ? "That gift is already claimed, so it can't be removed." : "Only the person who added that gift can remove it.");
        }
        const test = claimPaths(id);
        const urls = urlsFor(blobs, (p) => test(p) || (p.startsWith("added/") && p.split("/")[2] === id));
        if (urls.length) await del(urls);
      } else if (body.action === "add") {
        const kid = String(body.kid || "");
        const name = String(body.name || "").trim().slice(0, 80);
        if (!KIDS.includes(kid) || !name) return fail(400, "Type a gift name first.");
        const newId = "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await put(`added/${kid}/${newId}/${b64(name)}/${me || "_"}`, "1", { ...marker, allowOverwrite: true });
      } else {
        return res.status(400).json({ error: "Unknown action" });
      }
    } else if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { gifts } = await readState();
    return res.status(200).json(view(gifts, me, admin));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "The lists can't be reached right now. Try again in a moment." });
  }
}
