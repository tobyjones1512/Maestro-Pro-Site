// One function for the Whiskers' Word Quest licence calls (Vercel's free plan allows only 12 functions). vercel.json rewrites the old URLs
// to here, so /api/licence-start, /api/licence-complete and /api/licence-check still work exactly as before, for the website and the app.
import start from "./_licence-start.js";
import complete from "./_licence-complete.js";
import check from "./_licence-check.js";

const routes = { start, complete, check };
export default function handler(req, res) {
  const fn = routes[req.query?.fn];
  return fn ? fn(req, res) : res.status(404).json({ error: "Not found." });
}
