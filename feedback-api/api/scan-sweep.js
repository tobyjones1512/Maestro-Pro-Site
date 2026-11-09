// A backstop run by a Vercel cron job (see vercel.json): moves the scan queue along and sends any escalation email that is being held for virus scans.
// Normally the queue is moved by new emails and by the desk being open; this covers a quiet inbox. Vercel sends "Authorization: Bearer <CRON_SECRET>".
import "./support-inbound.js";   // registers the function that emails the owner
import { processQueue, settleScans } from "./_attachments.js";
import { loadIndex } from "./_threads.js";

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "Not allowed." });
  try {
    const queue = await processQueue();
    const held = (await loadIndex()).filter((t) => t.pendingNotice).slice(0, 20);
    for (const t of held) await settleScans(t.id, 0);
    return res.status(200).json({ ok: true, queue, held: held.length });
  } catch (e) {
    console.error("scan-sweep", e?.message);
    return res.status(500).json({ error: "Sweep failed." });
  }
}
