// Relays website feedback to the Fider board. The Fider key lives only in the
// FIDER_API_KEY environment variable of this Vercel project, never in the site or the repo.
const FIDER = "https://thecaffeinemediacompany.fider.io";
// Each site posts to the same board; the origin decides which app tag its posts get.
const APP_TAGS = {
  "https://maestro-pro.app": "maestro-pro",
  "https://www.maestro-pro.app": "maestro-pro",
};
const ORIGINS = Object.keys(APP_TAGS);
const TYPE_TAGS = { bug: "bug-report", feature: "feature-suggestion", other: "other" };

const fider = (path, body) =>
  fetch(FIDER + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FIDER_API_KEY}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });

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

  const { type, title, description, website } = req.body || {};
  if (website) return res.status(200).json({ ok: true }); // honeypot: bots fill the hidden field
  const t = String(title ?? "").trim();
  const d = String(description ?? "").slice(0, 5000);
  if (!TYPE_TAGS[type]) return res.status(400).json({ error: "Choose a type." });
  if (t.length < 10 || t.length > 100) return res.status(400).json({ error: "The title must be 10 to 100 characters." });

  try {
    const r = await fider("/api/v1/posts", { title: t, description: d });
    const post = await r.json().catch(() => ({}));
    if (!r.ok || !post.number) return res.status(502).json({ error: post.errors?.[0]?.message || "The feedback board refused it." });
    // The post exists now, so a tagging failure doesn't fail the send.
    await Promise.allSettled([APP_TAGS[origin], TYPE_TAGS[type]].map((s) => fider(`/api/v1/posts/${post.number}/tags/${s}`)));
    res.status(200).json({ ok: true });
  } catch {
    res.status(502).json({ error: "Couldn't reach the feedback board." });
  }
}
