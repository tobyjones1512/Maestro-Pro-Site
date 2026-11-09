// Maestro Pro students: if GoCardless shows the email has paid, emails them their licence key (never returned to the page,
// so only the owner of the inbox gets it). Needs RESEND_API_KEY, GOCARDLESS_ACCESS_TOKEN, LICENCE_SECRET.
import { studentKey, studentHasPaid, studentPlans, customersByEmail, validEmail } from "./_gc.js";
import owns from "./_student-owns.js";
import { buildKeyEmail, KEY_FROM } from "./_key-email.js";
import { logActivity } from "./_activity.js";

const ORIGINS = ["https://maestro-pro.app", "https://www.maestro-pro.app", "https://thecaffeinemediacompany.com", "https://www.thecaffeinemediacompany.com"];

export default async function handler(req, res) {
  // /api/student-owns (the buy pages' "do you already have a licence?" check) is rewritten here by vercel.json, to stay within 12 functions.
  if (req.query?.fn === "owns") return owns(req, res);
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
    // Someone who has subscribed more than once has a key for each GoCardless customer record; find every active one.
    const found = [];
    for (const c of await customersByEmail(e)) if (await studentHasPaid(c)) found.push({ key: studentKey(c), plans: await studentPlans(c) });
    if (!found.length) return res.status(402).json({ error: "We can't find a payment for that email address. Use the email you paid with." });
    const mail = buildKeyEmail(found);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: KEY_FROM(), to: [e], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    // Logged for the escalations desk (only for emails that have paid, so strangers typing addresses leave no trace).
    await logActivity(e, { type: "key_resent", status: r.ok ? "completed" : "failed", summary: r.ok ? `Licence key emailed to the customer${found.length > 1 ? ` (${found.length} keys)` : ""}` : "Tried to email the licence key, but the email could not be sent", key: found[0].key });
    if (!r.ok) return res.status(502).json({ error: "The email couldn't be sent." });
    res.status(200).json({ ok: true, keys: found.length });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Couldn't reach the payment or email service. (" + String(err.message).slice(0, 200) + ")" });
  }
}
