// The devices page on the website (maestro-pro.app/key/devices/), reached through student-check.js (Vercel's free plan allows only 12 functions,
// so this is a helper, not an endpoint of its own): lists the devices a licence key is being used on and removes them.
// Whoever holds the key can use the licence, so the key is what proves it is theirs. Removing a device frees its place straight away and
// signs that device out the next time it checks the licence.
import { parseStudentKey, gc } from "./_gc.js";
import { logActivity } from "./_activity.js";
import { keyHash, updateState, educationFlag, LIMIT } from "./_devices.js";

const ORIGINS = ["https://maestro-pro.app", "https://www.maestro-pro.app"];

const view = (state) => state.devices.filter((d) => !d.revoked).sort((a, b) => b.last - a.last).map((d) => ({ ref: d.pub, os: d.os || "", first: d.first, last: d.last, uses: d.uses || 0, confirmed: !!d.confirmed }));

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });
  if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "Not allowed." });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: "Devices can't be listed right now. Try again later." });

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const key = String(b.key ?? "").trim().toUpperCase(), customerId = parseStudentKey(key);
  if (!customerId) { await new Promise((r) => setTimeout(r, 400)); return res.status(400).json({ error: "That licence key isn't valid." }); }
  try {
    let snapshot = null, missing = false, removed = [];
    await updateState(keyHash(key), async (state) => {
      missing = false; removed = [];
      const edu = await educationFlag(state, customerId);
      let changed = edu.looked;
      if (!edu.value && b.action === "remove") {
        const d = state.devices.find((x) => x.pub === String(b.ref) && !x.revoked);
        if (d) { Object.assign(d, { revoked: true, revokedAt: Date.now(), notified: false }); changed = true; removed.push(d); } else missing = true;
      } else if (!edu.value && b.action === "remove-all") {
        for (const d of state.devices) if (!d.revoked) { Object.assign(d, { revoked: true, revokedAt: Date.now(), notified: false }); changed = true; removed.push(d); }
      }
      snapshot = { devices: view(state), unlimited: edu.value };
      return { changed };
    });
    if (removed.length) {
      // Logged against the customer's email for the escalations desk. A lookup failure only means no log line.
      const email = (await gc("GET", `/customers/${customerId}`).catch(() => null))?.data?.customers?.email;
      const names = removed.map((d) => `${d.os || "unknown device"} (ref ${d.pub})`);
      await logActivity(email, { type: "device_removed", status: "completed", summary: b.action === "remove-all" ? `Removed all devices (${removed.length} removed)` : `Removed a device: ${names[0]}`, ...(removed.length > 1 && { detail: names.join(", ") }), key });
    }
    if (missing) return res.status(404).json({ error: "That device was already removed.", limit: LIMIT, ...snapshot });
    return res.status(200).json({ ok: true, limit: LIMIT, ...snapshot });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Couldn't reach the licence service. Try again." });
  }
}
