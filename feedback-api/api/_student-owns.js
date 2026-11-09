// Buy pages ask this before sending someone to pay: does this email already have an active Maestro Pro licence?
// Answers yes or no only. It never returns or emails a key (student-key.js does that, to the inbox owner).
import { studentHasPaid, customersByEmail, validEmail } from "./_gc.js";

const ORIGINS = ["https://maestro-pro.app", "https://www.maestro-pro.app"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });
  if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "Not allowed." });

  const e = String(req.body?.email ?? "").trim();
  if (!validEmail(e)) return res.status(400).json({ error: "Enter a valid email address." });
  try {
    for (const c of await customersByEmail(e)) if (await studentHasPaid(c)) return res.status(200).json({ ok: true, owned: true });
    res.status(200).json({ ok: true, owned: false });
  } catch {
    res.status(502).json({ error: "Couldn't check." });
  }
}
