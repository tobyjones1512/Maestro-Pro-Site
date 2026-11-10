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
const CONTINENTS = {"Africa":["AO","BF","BI","BJ","BW","CD","CF","CG","CI","CM","CV","DJ","DZ","EG","EH","ER","ET","GA","GH","GM","GN","GQ","GW","KE","KM","LR","LS","LY","MA","MG","ML","MR","MU","MW","MZ","NA","NE","NG","RE","RW","SC","SD","SH","SL","SN","SO","SS","ST","SZ","TD","TG","TN","TZ","UG","YT","ZA","ZM","ZW"],"Antarctica":["AQ","BV","GS","HM","TF"],"Asia":["AE","AF","AM","AZ","BD","BH","BN","BT","CC","CN","CX","CY","GE","HK","ID","IL","IN","IO","IQ","IR","JO","JP","KG","KH","KP","KR","KW","KZ","LA","LB","LK","MM","MN","MO","MV","MY","NP","OM","PH","PK","PS","QA","SA","SG","SY","TH","TJ","TL","TM","TR","TW","UZ","VN","YE"],"Europe":["AD","AL","AT","AX","BA","BE","BG","BY","CH","CZ","DE","DK","EE","ES","FI","FO","FR","GB","GG","GI","GR","HR","HU","IE","IM","IS","IT","JE","LI","LT","LU","LV","MC","MD","ME","MK","MT","NL","NO","PL","PT","RO","RS","RU","SE","SI","SJ","SK","SM","UA","VA"],"North America":["AG","AI","AW","BB","BL","BM","BQ","BS","BZ","CA","CR","CU","CW","DM","DO","GD","GL","GP","GT","HN","HT","JM","KN","KY","LC","MF","MQ","MS","MX","NI","PA","PM","PR","SV","SX","TC","TT","UM","US","VC","VG","VI"],"Oceania":["AS","AU","CK","FJ","FM","GU","KI","MH","MP","NC","NF","NR","NU","NZ","PF","PG","PN","PW","SB","TK","TO","TV","VU","WF","WS"],"South America":["AR","BO","BR","CL","CO","EC","FK","GF","GY","PE","PY","SR","UY","VE"]};
const regionBoxes = () => Object.entries(CONTINENTS).map(([name, codes]) => `<div class="mp-cont"><label class="mp-cont__all"><input type="checkbox" data-cont="${name}"> <b>${name}</b></label>
  <div class="mp-cont__list">${codes.map((c) => [c, countryName(c)]).sort((x, y) => x[1].localeCompare(y[1])).map(([c, n]) => `<label><input type="checkbox" name="region" value="${c}" data-in="${name}"> ${esc(n)}</label>`).join("")}</div></div>`).join("");

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

// ---- The upload form, shared by /marketplace/add (the site owner) and /marketplace/seller (connected sellers). Also edits an item that is already there.
const safe = (n) => n.replace(/[^\w.\- ()]+/g, "_").slice(-100);
const VER = (n) => `<fieldset class="mp-ver"><legend>${n ? "Another version" : "Main version"}</legend>
  <label class="field">Name of this version ${n ? "(for example the key or instrument: &ldquo;B&flat; trumpet&rdquo;)" : "(optional, for example &ldquo;Concert pitch&rdquo;)"}<input name="vlabel" type="text" maxlength="40"></label>
  <p class="mp-note mp-keep" hidden>Your current files are kept. Choose new files below only to replace them.</p>
  <label class="field">Sheet music, karaoke or lyrics file<input name="vscore" type="file" accept="${accept.score}"></label>
  <label class="field">Backing tracks (optional, the first is the main one)<input name="vtracks" type="file" accept="${accept.audio}" multiple></label>
  <label class="field">Lyrics (optional, .lrc or .txt)<input name="vlyrics" type="file" accept="${accept.lyrics}"></label>
  ${n ? '<button class="pay__btn pay__btn--ghost" type="button" data-rm>Remove this version</button>' : ""}</fieldset>`;
const keptBoxes = (box, files) => { box.innerHTML = files.length ? files.map((f) => `<label><input type="checkbox" checked value="${esc(f.path)}"> ${esc(f.name)}</label>`).join("") : ""; };
const keptPaths = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);

/** Returns { edit(product), clear() }. */
export function mountBuilder(form, { getKey, onDone }) {
  if (location.hash.includes("debug")) form.querySelector("#debugfield")?.removeAttribute("hidden");
  const msg = $(".pay__msg", form), submit = $("button[type=submit]", form), say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "#c0392b" : ""; };
  const some = form.elements.where, vs = $(".mp-vers", form), list = $(".mp-regions", form);
  let editing = null;
  list.innerHTML = regionBoxes();
  const sync = () => { list.hidden = some.value !== "some"; };
  form.querySelectorAll("input[name=where]").forEach((r) => r.addEventListener("change", sync));
  const tick = (cont) => {   // a continent box is ticked when all its countries are, and half-ticked when some are
    const own = [...list.querySelectorAll(`input[data-in="${cont}"]`)], all = $(`input[data-cont="${cont}"]`, list), n = own.filter((i) => i.checked).length;
    all.checked = n === own.length; all.indeterminate = n > 0 && n < own.length;
  };
  list.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.cont) { list.querySelectorAll(`input[data-in="${t.dataset.cont}"]`).forEach((i) => (i.checked = t.checked)); t.indeterminate = false; }
    else if (t.dataset.in) tick(t.dataset.in);
  });
  const setRegions = (codes) => { list.querySelectorAll("input[name=region]").forEach((i) => (i.checked = codes.includes(i.value))); Object.keys(CONTINENTS).forEach(tick); };
  const addVersion = (keep) => {
    const d = document.createElement("div"); d.innerHTML = VER(vs.children.length);
    const el = d.firstElementChild;
    if (keep) { el.dataset.keep = keep.id; el.querySelector("[name=vlabel]").value = keep.label || ""; el.querySelector(".mp-keep").hidden = false; }
    else el.querySelector("[name=vscore]").required = true;
    el.querySelector("[data-rm]")?.addEventListener("click", () => el.remove());
    vs.append(el);
  };
  $("[data-addv]", form).addEventListener("click", () => vs.children.length < 12 && addVersion());
  const clear = () => {
    editing = null; form.reset(); vs.innerHTML = ""; addVersion(); setRegions([]); sync();
    keptBoxes($("[data-kept=extras]", form), []); keptBoxes($("[data-kept=proof]", form), []);
    submit.textContent = "Submit for review"; $("[data-cancel]", form).hidden = true; say("");
  };
  $("[data-cancel]", form).addEventListener("click", () => { clear(); onDone?.(); });
  const edit = (p) => {
    clear(); editing = { id: p.id };
    const f = form.elements;
    f.title.value = p.title; f.composer.value = p.composer || ""; f.description.value = p.edit.description || ""; f.price.value = Number(p.priceUSD).toFixed(2);
    some.value = p.regions.length ? "some" : "all"; setRegions(p.regions); sync();
    vs.innerHTML = ""; p.edit.variants.forEach((v) => addVersion(v));
    keptBoxes($("[data-kept=extras]", form), p.edit.extras); keptBoxes($("[data-kept=proof]", form), p.edit.proof.files || []);
    f.proofText.value = p.edit.proof.text || "";
    submit.textContent = "Resubmit for review"; $("[data-cancel]", form).hidden = false;
    say("Saving sends the whole product back through review, and it is off sale until it is accepted.");
  };
  form.price.addEventListener("input", () => say(form.price.value && !validPrice(form.price.value) ? PRICE_RULE : "", true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = getKey();
    if (!key) return say("Sign in first.", true);
    if (!validPrice(form.price.value)) return say(PRICE_RULE, true);
    const regions = some.value === "some" ? [...list.querySelectorAll("input[name=region]:checked")].map((i) => i.value) : [];
    if (some.value === "some" && !regions.length) return say("Tick at least one country, or sell worldwide.", true);
    submit.disabled = true;
    try {
      const f = form.elements, title = f.title.value.trim(), id = editing?.id || crypto.randomUUID();
      const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client");
      const up = (path, blob, what) => upload(path, blob, { access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify({ key }), multipart: blob.size > 8e6,
        contentType: blob.type || "application/octet-stream", onUploadProgress: (p) => say(`Uploading ${what}… ${Math.round(p.percentage)}%`) });
      const blocks = [...vs.children], variants = [];
      for (const el of blocks) {
        const label = $("[name=vlabel]", el).value.trim(), score = $("[name=vscore]", el).files[0];
        if (!score && el.dataset.keep) { variants.push({ id: el.dataset.keep, label }); continue; }
        if (blocks.length > 1 && !label) throw new Error("Name each version, for example the key or the instrument.");
        const tracks = [...$("[name=vtracks]", el).files], lyrics = $("[name=vlyrics]", el).files[0];
        const bundle = await makeBundle({ title: blocks.length > 1 && label ? `${title} (${label})` : title, score, tracks, lyrics });
        const vid = crypto.randomUUID();
        await up(`marketplace/bundles/${vid}.maestropro`, bundle, label || "the music");
        variants.push({ id: vid, label });
      }
      const extras = keptPaths($("[data-kept=extras]", form)), proof = keptPaths($("[data-kept=proof]", form));
      for (const file of [...f.extras.files]) { const path = `marketplace/extras/${id}/${crypto.randomUUID()}-${safe(file.name)}`; await up(path, file, file.name); extras.push(path); }
      for (const file of [...f.proofFiles.files]) { if (!/\.(pdf|png|jpe?g|txt)$/i.test(file.name)) throw new Error(`${file.name} isn't allowed as proof. Use PDF, PNG, JPG or TXT.`); const path = `marketplace/evidence/${id}/${crypto.randomUUID()}-${safe(file.name)}`; await up(path, file, file.name); proof.push(path); }
      const contents = [variants.length > 1 ? `${variants.length} versions` : "Score", extras.length && `${extras.length} download${extras.length > 1 ? "s" : ""}`].filter(Boolean).join(", ");
      await api(editing ? "edit" : "publish", { method: "POST", key, body: { id, title, composer: f.composer.value, description: f.description.value, priceUSD: f.price.value.trim(), contents, regions, rights: f.rights.checked, variants, extras, proof: { text: f.proofText.value, files: proof }, ...(f.debugCode?.value && { debugCode: f.debugCode.value }) } });
      clear(); say("Submitted for review. Every file is checked, then the whole product is reviewed against the guidelines. You will be emailed the result.");
      onDone?.();
    } catch (err) { say(err.message, true); }
    submit.disabled = false;
  });
  clear();
  return { edit, clear };
}

export const builderFields = `
  <label class="field">Title<input name="title" type="text" required maxlength="100"></label>
  <label class="field">Composer or arranger<input name="composer" type="text" maxlength="100"></label>
  <label class="field">Description<textarea name="description" rows="3" maxlength="600"></textarea></label>
  <label class="field">Price in US dollars (.00, .25, .50 or .75)<input name="price" type="number" inputmode="decimal" min="0.25" max="999.75" step="0.25" required></label>
  <div class="mp-vers"></div>
  <button class="pay__btn pay__btn--ghost" type="button" data-addv>Add another version (a different key or instrument)</button>
  <p class="mp-note">Buyers get every version. Put different keys or instruments of the same piece here, not in separate products.</p>
  <fieldset class="field"><legend>Downloads for use outside Maestro Pro (optional)</legend>
    <p class="mp-note">Printable PDFs or other files buyers can download and use for themselves. Buyers can also download every file in each version.</p>
    <div class="mp-kept" data-kept="extras"></div>
    <input name="extras" type="file" accept=".pdf,${accept.score},${accept.audio}" multiple></fieldset>
  <fieldset class="field"><legend>Proof that you own the rights (optional)</legend>
    <p class="mp-note">A licence, a letter of permission, a copyright registration, or dated drafts or project files that show you wrote it. PDF, PNG, JPG or TXT, 25 MB each, up to 5 files.</p>
    <label class="field">How do you hold the rights?<textarea name="proofText" rows="2" maxlength="1500"></textarea></label>
    <div class="mp-kept" data-kept="proof"></div>
    <input name="proofFiles" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" multiple></fieldset>
  <fieldset class="field"><legend>Where is this sold?</legend>
    <label><input type="radio" name="where" value="all" checked> Worldwide</label>
    <label><input type="radio" name="where" value="some"> Only these countries (you must hold the rights there; see guideline 2.9)</label>
    <div class="mp-regions" hidden></div></fieldset>
  <label class="field" id="debugfield" hidden>Debug code (testing only)<input name="debugCode" type="password" autocomplete="off"></label>
  <label class="field"><input name="rights" type="checkbox" required> I wrote this, or I own the rights to sell all of it, and I have read the <a href="/marketplace/guidelines/" target="_blank">Merchant Content Review Guidelines</a>.</label>
  <div class="row"><button class="pay__btn" type="submit">Submit for review</button><button class="pay__btn pay__btn--ghost" type="button" data-cancel hidden>Cancel</button></div>
  <p class="pay__msg" role="status"></p>`;

// ---- Merchant pages: the product list with each review result, shared by /marketplace/seller and /marketplace/add.
const LABEL = { scanning: "In review: checking files", reviewing: "In review", ready: "Ready For Distribution", refused: "Refused", escalated: "Final review by Maestro Pro" };
export const inReview = (p) => p.status === "scanning" || p.status === "reviewing";
const gl = (g) => `<li><a href="/marketplace/guidelines/#g${esc(g.id).replace(".", "-")}" target="_blank" rel="noopener">Guideline ${esc(g.id)}: ${esc(g.title)}</a></li>`;

/** Fills `table` (a <tbody>) with the products. `act(id, withdrawn)` is called by the withdraw / put back on sale button. */
export function renderProducts(table, products, act, onAppeal, onEdit) {
  table.innerHTML = products.map((p) => `<tr><td><b>${esc(p.title)}</b><br><small>ID ${esc(p.code)} &middot; ${dollars(p.priceUSD)} &middot; ${esc(where(p.regions))}${p.versions?.length ? ` &middot; ${p.versions.length} versions` : ""}</small></td>
    <td><span class="mp-status mp-status--${p.status === "ready" ? "ready" : p.status === "refused" ? "refused" : "wait"}">${p.withdrawn ? "Withdrawn from sale" : LABEL[p.status] || esc(p.status)}</span>${p.files && inReview(p) ? `<br><small>${p.files.done} of ${p.files.total} files scanned</small>` : ""}
      ${p.status === "refused" || p.status === "escalated" ? `<div class="mp-reason">${esc(p.reason)}<ul>${(p.guidelines || []).map(gl).join("")}</ul>${p.final ? "<small>Final decision. This can't be appealed.</small>" : p.canAppeal ? `<button class="pay__btn pay__btn--ghost" data-appeal="${esc(p.id)}">Appeal with evidence</button>` : p.status === "escalated" ? "<small>Waiting for a final decision from a person at Maestro Pro.</small>" : ""}</div>` : ""}</td>
    <td>${p.sold}</td><td>${dollars(p.earnedUSD)}</td>
    <td>${p.editable ? `<button class="pay__btn pay__btn--ghost" data-edit="${esc(p.id)}">Edit</button> ` : ""}${p.status === "ready" ? `<button class="pay__btn pay__btn--ghost" data-id="${esc(p.id)}" data-w="${p.withdrawn ? "" : "1"}">${p.withdrawn ? "Put back on sale" : "Withdraw from sale"}</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5">Nothing yet.</td></tr>`;
  table.querySelectorAll("button[data-edit]").forEach((b) => b.addEventListener("click", () => onEdit?.(products.find((p) => p.id === b.dataset.edit))));
  table.querySelectorAll("button[data-appeal]").forEach((b) => b.addEventListener("click", () => onAppeal?.(products.find((p) => p.id === b.dataset.appeal))));
  table.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => act(b.dataset.id, Boolean(b.dataset.w))));
}
export const productsTable = `<table class="mp-table"><thead><tr><th>Product</th><th>Status</th><th>Sold</th><th>Proceeds</th><th></th></tr></thead><tbody></tbody></table>`;

/** Uploads the evidence files, then sends the appeal. Throws with a message the merchant can read. */
export async function sendAppeal({ key, id, text, files, say = () => {} }) {
  const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client");
  const paths = [];
  for (const f of files) {
    if (!/\.(pdf|png|jpe?g|txt)$/i.test(f.name)) throw new Error(`${f.name} isn't allowed. Use PDF, PNG, JPG or TXT.`);
    const path = `marketplace/evidence/${id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\- ()]+/g, "_").slice(-100)}`;
    say(`Uploading ${f.name}…`);
    await upload(path, f, { access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify({ key }), contentType: f.type || "application/octet-stream" });
    paths.push(path);
  }
  await api("appeal", { method: "POST", key, body: { id, text, files: paths } });
}

const size = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
/** The downloads of a paid order (from the "order" call): the bundles for Maestro Pro, then every plain file for use anywhere. */
export function downloadsHtml(o) {
  const v = o.variants || [], label = (x) => (x.label ? ` (${esc(x.label)})` : "");
  return `<h2>For Maestro Pro</h2>
    <p>${v.map((x) => `<a class="pay__btn" href="${esc(x.url)}">Download ${esc(o.title)}${label(x)}</a>`).join(" ")}</p>
    <p class="mp-note">Open the downloaded file in Maestro Pro. It is added to your library, and so is every version.</p>
    <h2>For use outside Maestro Pro</h2>
    ${(o.extras || []).length ? `<ul>${o.extras.map((x) => `<li><a href="${esc(x.url)}">${esc(x.name)}</a> <small>${size(x.size)}</small></li>`).join("")}</ul>` : ""}
    ${v.map((x) => `<details><summary>Every file in ${esc(o.title)}${label(x)}</summary><ul>${x.files.map((f) => `<li><a href="${esc(f.url)}">${esc(f.name)}</a> <small>${size(f.size)}</small></li>`).join("")}</ul></details>`).join("")}
    <p class="mp-note">You may use these files for yourself: to play, practise and print a copy. You may not resell or share them (<a href="/marketplace/guidelines/#g6-3">guideline 6.3</a>).</p>`;
}
