// Front end for the Maestro Pro marketplace: API calls, prices, and the .maestropro bundle builder.
export const API = "https://fider-feedback-api.vercel.app/api/marketplace-";
const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function api(fn, { method = "GET", body, query = {}, key } = {}) {
  const q = new URLSearchParams(query).toString();
  const r = await fetch(API + fn + (q ? "?" + q : ""), {
    method, headers: { ...(body && { "Content-Type": "application/json" }), ...(key && { "X-MP-Key": key }) }, body: body && JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
  return d;
}

/** Whole dollars -> the buyer's currency, rounded up the way the server rounds it. */
export function local(usd, { currency, rate }) {
  const dec = currency === "JPY" || currency === "ISK" ? 0 : 2;
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Math.ceil(usd * rate * 10 ** dec - 1e-6) / 10 ** dec);
}
export const dollars = (n) => "$" + n + " USD";

/** True for "4" or "12"; false for "4.50", "4.0", "-1", "1e1" or "". Sellers may only price in whole dollars. */
export const wholeDollars = (v) => /^\d{1,3}$/.test(String(v).trim()) && Number(v) >= 1;

// ---- The bundle: a .maestropro file, the same one the app makes with "Share with Another Player".
// Layout: "PLAYALONG1", a 4-byte little-endian header length, the JSON header (the item and the names and sizes of its files), then the files.
const AUDIO = ["mp3", "m4a", "wav", "aif", "aiff", "caf", "aac", "flac"];
const SCORE = ["musicxml", "mxl", "xml", "pdf", "mid", "midi", "kar", "cdg", "lrc", "txt"];
export const accept = { score: SCORE.map((e) => "." + e).join(","), audio: AUDIO.map((e) => "." + e).join(","), lyrics: ".lrc,.txt" };
const ext = (n) => n.split(".").pop().toLowerCase();
const uuid = () => crypto.randomUUID().toUpperCase();

/** score: the sheet music (or karaoke / lyrics) file; tracks: backing recordings (the first is the main one); lyrics: an optional .lrc/.txt. All are File or Blob with a name. */
export async function makeBundle({ title, score, tracks = [], lyrics }) {
  if (!score || !SCORE.includes(ext(score.name))) throw new Error("Choose the sheet music, karaoke or lyrics file.");
  const used = new Set(), parts = [];
  const add = (f) => {   // plain, unique names: the app only accepts file names with no folders
    let n = f.name.replace(/[\\/]/g, "-"), i = 1;
    while (used.has(n.toLowerCase())) n = n.replace(/(\.[^.]*)?$/, `-${++i}$1`);
    used.add(n.toLowerCase()); parts.push({ name: n, file: f }); return n;
  };
  const item = { id: uuid(), title, file: add(score), tempo: 100, offset: 0, beatsPerBar: 4, added: Date.now() / 1000 - 978307200 };
  for (const t of tracks) if (!AUDIO.includes(ext(t.name))) throw new Error(`${t.name} isn't a recording the app can play.`);
  tracks.forEach((t, i) => {
    const n = add(t);
    if (i === 0) { item.track = n; item.trackName = n.replace(/\.[^.]*$/, ""); }
    else (item.extraTracks ||= []).push({ id: uuid(), file: n, name: n.replace(/\.[^.]*$/, ""), enabled: true, gainDB: 0, offset: 0, reduceVocals: false });
  });
  if (lyrics) { if (!["lrc", "txt"].includes(ext(lyrics.name))) throw new Error("Lyrics must be a .lrc or .txt file."); item.lyrics = add(lyrics); }
  const files = [];
  for (const p of parts) files.push({ name: p.name, size: p.file.size });
  const head = new TextEncoder().encode(JSON.stringify({ item, files }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([new TextEncoder().encode("PLAYALONG1"), len, head, ...parts.map((p) => p.file)], { type: "application/octet-stream" });
}

// ---- The upload form, shared by /marketplace/add (the site owner) and /marketplace/seller (connected sellers).
export function mountBuilder(form, { getKey, onDone }) {
  const msg = $(".pay__msg", form), btn = $(".pay__btn", form), say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "#c0392b" : ""; };
  form.price.addEventListener("input", () => say(form.price.value && !wholeDollars(form.price.value) ? "The price must be a whole number of US dollars. Cents are not allowed." : "", true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = getKey();
    if (!key) return say("Sign in first.", true);
    if (!wholeDollars(form.price.value)) return say("The price must be a whole number of US dollars, from 1 to 999. Cents are not allowed.", true);
    btn.disabled = true;
    try {
      const f = form.elements, title = f.title.value.trim();
      const tracks = [...f.tracks.files], bundle = await makeBundle({ title, score: f.score.files[0], tracks, lyrics: f.lyrics.files[0] });
      const id = crypto.randomUUID();
      say("Uploading…");
      const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client");
      await upload(`marketplace/bundles/${id}.maestropro`, bundle, {
        access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify({ key }), multipart: bundle.size > 8e6, contentType: "application/octet-stream",
        onUploadProgress: (p) => say(`Uploading… ${Math.round(p.percentage)}%`),
      });
      const contents = ["Score", tracks.length && `${tracks.length} backing track${tracks.length > 1 ? "s" : ""}`, f.lyrics.files[0] && "Lyrics"].filter(Boolean).join(", ");
      const { listing } = await api("publish", { method: "POST", key, body: { id, title, composer: f.composer.value, description: f.description.value, priceUSD: f.price.value.trim(), contents } });
      say(`Published “${listing.title}” at ${dollars(listing.priceUSD)}.`);
      form.reset(); onDone?.(listing);
    } catch (err) { say(err.message, true); }
    btn.disabled = false;
  });
}

export const builderFields = `
  <label class="field">Title<input name="title" type="text" required maxlength="100"></label>
  <label class="field">Composer or arranger<input name="composer" type="text" maxlength="100"></label>
  <label class="field">Description<textarea name="description" rows="3" maxlength="600"></textarea></label>
  <label class="field">Price in US dollars (whole dollars only)<input name="price" type="number" inputmode="numeric" min="1" max="999" step="1" required></label>
  <label class="field">Sheet music, karaoke or lyrics file<input name="score" type="file" accept="${accept.score}" required></label>
  <label class="field">Backing tracks (optional, the first is the main one)<input name="tracks" type="file" accept="${accept.audio}" multiple></label>
  <label class="field">Lyrics (optional, .lrc or .txt)<input name="lyrics" type="file" accept="${accept.lyrics}"></label>
  <label class="field"><input name="rights" type="checkbox" required> I wrote this, or I own the rights to sell all of it.</label>
  <button class="pay__btn" type="submit">Publish to the marketplace</button>
  <p class="pay__msg" role="status"></p>`;
