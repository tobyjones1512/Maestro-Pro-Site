// Front end for the Maestro Pro marketplace: API calls, prices, and the .maestropro bundle builder.
export const API = "https://maestro-marketplace-api.vercel.app/api/marketplace-";
const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function api(fn, { method = "GET", body, query = {}, key, header = "X-MP-Key" } = {}) {
  const q = new URLSearchParams(query).toString();
  const r = await fetch(API + fn + (q ? "?" + q : ""), {
    method, headers: { ...(body && { "Content-Type": "application/json" }), ...(key && { [header]: key }) }, body: body && JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
  return d;
}

/** US dollars -> the buyer's currency, rounded up the way the server rounds it. */
export function local(usd, { currency, rate }) {
  const dec = currency === "JPY" || currency === "ISK" ? 0 : 2;
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Math.ceil(usd * rate * 10 ** dec - 1e-6) / 10 ** dec);
}
export const dollars = (n) => "$" + Number(n).toFixed(2) + " USD";

/** True for $0.25 to $999.75 ending in .00, .25, .50 or .75 ("4", "4.5" and "4.25" pass; "4.10", "4.99" and "0.75" do not). Mirrors price() on the server. */
export function validPrice(v) {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(v ?? "").trim());
  if (!m) return false;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents >= 25 && cents % 25 === 0;
}
export const PRICE_RULE = "The price must be from $0.25 to $999.75 and end in .00, .25, .50 or .75. No other cent amount is allowed.";

// ---- Where an item is sold: worldwide, or only the countries the merchant picks (ISO codes; names come from the browser).
const COUNTRIES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
export const countryName = (c) => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(c) || c; } catch { return c; } };
export const where = (regions) => (regions?.length ? regions.map(countryName).join(", ") : "Worldwide");
const countryOptions = () => COUNTRIES.map((c) => [c, countryName(c)]).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("");

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
  const some = form.elements.where, list = form.elements.regions;
  list.innerHTML = countryOptions();
  const sync = () => { list.hidden = some.value !== "some"; };
  form.querySelectorAll("input[name=where]").forEach((r) => r.addEventListener("change", sync)); sync();
  form.price.addEventListener("input", () => say(form.price.value && !validPrice(form.price.value) ? PRICE_RULE : "", true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = getKey();
    if (!key) return say("Sign in first.", true);
    if (!validPrice(form.price.value)) return say(PRICE_RULE, true);
    const regions = some.value === "some" ? [...list.selectedOptions].map((o) => o.value) : [];
    if (some.value === "some" && !regions.length) return say("Choose at least one country, or sell worldwide.", true);
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
      await api("publish", { method: "POST", key, body: { id, title, composer: f.composer.value, description: f.description.value, priceUSD: f.price.value.trim(), contents, regions, rights: f.rights.checked } });
      say("Submitted for review. Every file is checked with VirusTotal, then the item is reviewed against the guidelines. You will be emailed the result.");
      form.reset(); onDone?.();
    } catch (err) { say(err.message, true); }
    btn.disabled = false;
  });
}

export const builderFields = `
  <label class="field">Title<input name="title" type="text" required maxlength="100"></label>
  <label class="field">Composer or arranger<input name="composer" type="text" maxlength="100"></label>
  <label class="field">Description<textarea name="description" rows="3" maxlength="600"></textarea></label>
  <label class="field">Price in US dollars (.00, .25, .50 or .75)<input name="price" type="number" inputmode="decimal" min="0.25" max="999.75" step="0.25" required></label>
  <label class="field">Sheet music, karaoke or lyrics file<input name="score" type="file" accept="${accept.score}" required></label>
  <label class="field">Backing tracks (optional, the first is the main one)<input name="tracks" type="file" accept="${accept.audio}" multiple></label>
  <label class="field">Lyrics (optional, .lrc or .txt)<input name="lyrics" type="file" accept="${accept.lyrics}"></label>
  <fieldset class="field"><legend>Where is this sold?</legend>
    <label><input type="radio" name="where" value="all" checked> Worldwide</label>
    <label><input type="radio" name="where" value="some"> Only these countries (you must hold the rights there; see guideline 2.9)</label>
    <select name="regions" multiple size="8" hidden aria-label="Countries"></select></fieldset>
  <label class="field"><input name="rights" type="checkbox" required> I wrote this, or I own the rights to sell all of it, and I have read the <a href="/marketplace/guidelines/" target="_blank">Merchant Content Review Guidelines</a>.</label>
  <button class="pay__btn" type="submit">Submit for review</button>
  <p class="pay__msg" role="status"></p>`;

// ---- Merchant pages: the product list with each review result, shared by /marketplace/seller and /marketplace/add.
const LABEL = { scanning: "In review: checking files", reviewing: "In review", ready: "Ready For Distribution", refused: "Refused", escalated: "Final review by Maestro Pro" };
export const inReview = (p) => p.status === "scanning" || p.status === "reviewing";
const gl = (g) => `<li><a href="/marketplace/guidelines/#g${esc(g.id).replace(".", "-")}" target="_blank" rel="noopener">Guideline ${esc(g.id)}: ${esc(g.title)}</a></li>`;

/** Fills `table` (a <tbody>) with the products. `act(id, withdrawn)` is called by the withdraw / put back on sale button. */
export function renderProducts(table, products, act, onAppeal) {
  table.innerHTML = products.map((p) => `<tr><td><b>${esc(p.title)}</b><br><small>${dollars(p.priceUSD)} &middot; ${esc(where(p.regions))}</small></td>
    <td><span class="mp-status mp-status--${p.status === "ready" ? "ready" : p.status === "refused" ? "refused" : "wait"}">${p.withdrawn ? "Withdrawn from sale" : LABEL[p.status] || esc(p.status)}</span>${p.files && inReview(p) ? `<br><small>${p.files.done} of ${p.files.total} files scanned</small>` : ""}
      ${p.status === "refused" || p.status === "escalated" ? `<div class="mp-reason">${esc(p.reason)}<ul>${(p.guidelines || []).map(gl).join("")}</ul>${p.final ? "<small>Final decision. This can't be appealed.</small>" : p.canAppeal ? `<button class="pay__btn pay__btn--ghost" data-appeal="${esc(p.id)}">Appeal with evidence</button> <small>Refused ${p.refusals} of 3 times</small>` : p.status === "escalated" ? "<small>Waiting for a final decision from a person at Maestro Pro.</small>" : ""}</div>` : ""}</td>
    <td>${p.sold}</td><td>${dollars(p.earnedUSD)}</td>
    <td>${p.status === "ready" ? `<button class="pay__btn pay__btn--ghost" data-id="${esc(p.id)}" data-w="${p.withdrawn ? "" : "1"}">${p.withdrawn ? "Put back on sale" : "Withdraw from sale"}</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5">Nothing yet.</td></tr>`;
  table.querySelectorAll("button[data-appeal]").forEach((b) => b.addEventListener("click", () => onAppeal?.(products.find((p) => p.id === b.dataset.appeal))));
  table.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => act(b.dataset.id, Boolean(b.dataset.w))));
}
export const productsTable = `<table class="mp-table"><thead><tr><th>Product</th><th>Status</th><th>Sold</th><th>Your share</th><th></th></tr></thead><tbody></tbody></table>`;

/** Uploads the evidence files, then sends the appeal. Throws with a message the merchant can read. */
export async function sendAppeal({ key, id, text, files, say = () => {} }) {
  const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client");
  const paths = [];
  for (const f of files) {
    const path = `marketplace/evidence/${id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\- ()]+/g, "_").slice(-100)}`;
    say(`Uploading ${f.name}…`);
    await upload(path, f, { access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify({ key }), contentType: f.type || "application/octet-stream" });
    paths.push(path);
  }
  await api("appeal", { method: "POST", key, body: { id, text, files: paths } });
}
