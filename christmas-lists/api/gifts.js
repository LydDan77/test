// Shared state lives entirely in Vercel Blob path names, so every read is one
// consistent list() call: "bought/<id>" or "bought/<id>/<base64url buyer>" marks
// a gift purchased, and "added/<kid>/<id>/<base64url name>" is a gift someone
// added on the page.
import { list, put, del } from "@vercel/blob";

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
  const bought = new Map();
  const gifts = [];
  for (const [kid, names] of Object.entries(SEED)) {
    names.forEach((name, i) => {
      gifts.push({ id: `${kid}-${String(i + 1).padStart(2, "0")}`, kid, name, order: i + 1 });
    });
  }
  for (const b of blobs) {
    const parts = b.pathname.split("/");
    if (parts[0] === "bought" && (parts.length === 2 || parts.length === 3)) {
      let who = "";
      if (parts[2]) { try { who = Buffer.from(parts[2], "base64url").toString("utf8"); } catch {} }
      bought.set(parts[1], who);
    }
    if (parts[0] === "added" && parts.length === 4 && KIDS.includes(parts[1])) {
      let name = "";
      try { name = Buffer.from(parts[3], "base64url").toString("utf8"); } catch {}
      if (name) gifts.push({ id: parts[2], kid: parts[1], name, added: true, order: 1000 + new Date(b.uploadedAt).getTime() });
    }
  }
  return { blobs, gifts: gifts.map((g) => ({ ...g, purchased: bought.has(g.id), buyer: bought.get(g.id) || "" })) };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const isMarkerFor = (b, id) => b.pathname === `bought/${id}` || b.pathname.startsWith(`bought/${id}/`);
const marker = { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (body.action === "set") {
        const id = String(body.id || "");
        const { blobs, gifts } = await readState();
        if (!gifts.some((g) => g.id === id)) return res.status(400).json({ error: "Unknown gift" });
        const old = blobs.filter((b) => isMarkerFor(b, id)).map((b) => b.url);
        if (old.length) await del(old);
        if (body.purchased) {
          const who = String(body.buyer || "").trim().slice(0, 30);
          await put(who ? `bought/${id}/${b64(who)}` : `bought/${id}`, "1", marker);
        }
      } else if (body.action === "remove") {
        const id = String(body.id || "");
        const { blobs } = await readState();
        const urls = blobs
          .filter((b) => (b.pathname.startsWith("added/") && b.pathname.split("/")[2] === id) || isMarkerFor(b, id))
          .map((b) => b.url);
        if (!id.startsWith("x") || !urls.length) return res.status(400).json({ error: "Unknown gift" });
        await del(urls);
      } else if (body.action === "add") {
        const kid = String(body.kid || "");
        const name = String(body.name || "").trim().slice(0, 80);
        if (!KIDS.includes(kid) || !name) return res.status(400).json({ error: "Bad gift" });
        const id = "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await put(`added/${kid}/${id}/${b64(name)}`, "1", marker);
      } else {
        return res.status(400).json({ error: "Unknown action" });
      }
    } else if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { gifts } = await readState();
    return res.status(200).json({ gifts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Storage unavailable" });
  }
}
