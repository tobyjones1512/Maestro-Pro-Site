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

/** The price a visitor sees: with the tax built in where their country expects that. */
export const shown = (usd, d) => usd * (1 + (d.tax?.inclusive ? d.tax.rate : 0));
/** The checkout's breakdown, worked out exactly as the server does it. Returns amounts in the buyer's currency. */
export function breakdown(priceUSD, tipUSD, { currency, rate, cardFee }, tax) {
  const dec = currency === "JPY" || currency === "ISK" ? 0 : 2, k = 10 ** dec, r = tax?.rate || 0, up = (u) => (dec ? Math.ceil(u * rate * 4 - 1e-6) * 25 : Math.ceil(u * rate - 1e-6));
  const base = up(priceUSD * (1 + r)), tip = Math.round(tipUSD * rate * k), t = r ? Math.round((base * r) / (1 + r)) : 0;   // the tip is on the price before tax and never changes the tax
  // Mollie's card fee is built into the price (grossed up, then rounded to the nearest quarter), as the server does it
  const step = dec ? 25 : 1, price = cardFee ? Math.round((base + cardFee.fixed) / (1 - cardFee.pct) / step) * step : base;
  return { total: (price + tip) / k, tip: tip / k, tax: t / k, net: (price - t) / k };
}
export const money = (n, currency) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
/** US dollars -> the buyer's currency, rounded up the way the server rounds it. */
export function local(usd, { currency, rate }, base = 0) {
  const whole = currency === "JPY" || currency === "ISK", amt = (u) => (whole ? Math.ceil(u * rate - 1e-6) : Math.ceil(u * rate * 4 - 1e-6) / 4);   // rounded up to the next quarter (0.19 -> 0.25, 0.26 -> 0.50)
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amt(usd + base) - (base ? amt(base) : 0));   // base: the price the amount is added to, so a tip is shown as the total minus the price
}
export const dollars = (n) => "$" + Number(n).toFixed(2) + " USD";

/** True for $1.00 to $999.75 ending in .00, .25, .50 or .75 ("4", "4.5" and "4.25" pass; "4.10", "4.99" and "0.75" and "0.50" do not). Mirrors price() on the server. */
export function validPrice(v) {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(v ?? "").trim());
  if (!m) return false;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents >= 100 && cents % 25 === 0;
}
export const PRICE_RULE = "The price must be from $1.00 to $999.75 and end in .00, .25, .50 or .75. No other cent amount is allowed.";

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
export const GENRES = ["Ambient", "Blues", "Children's", "Classical", "Country", "Dance", "Electronic", "Film and TV", "Folk", "Gospel and Worship", "Hip-hop", "Holiday and Seasonal", "Indie", "Jazz", "Latin", "Metal", "Musical Theatre", "Pop", "Punk", "R&B and Soul", "Reggae", "Rock", "Video Games", "World", "Other"];
export const accept = { sheet: ".musicxml,.mxl,.xml,.pdf,.mid,.midi", karaoke: ".kar,.cdg", score: SCORE.map((e) => "." + e).join(","), audio: AUDIO.map((e) => "." + e).join(","), lyrics: ".lrc,.txt" };
const ext = (n) => n.split(".").pop().toLowerCase();
const uuid = () => crypto.randomUUID().toUpperCase();

/** score: the sheet music; karaoke: a karaoke file; lyrics: a .lrc/.txt; tracks: backing recordings (the first is the main one). A version has sheet music or a karaoke file (the main file), or lyrics alone. All are File or Blob with a name. */
export async function makeBundle({ title, score, karaoke, tracks = [], lyrics }) {
  if (score && karaoke) throw new Error("A version has sheet music or a karaoke file, not both. Add another version for the other.");
  const main = score || karaoke || lyrics;
  if (!main || !SCORE.includes(ext(main.name))) throw new Error("Choose the sheet music, a karaoke file or the lyrics.");
  const used = new Set(), parts = [];
  const add = (f) => {   // plain, unique names: the app only accepts file names with no folders
    let n = f.name.replace(/[\\/]/g, "-"), i = 1;
    while (used.has(n.toLowerCase())) n = n.replace(/(\.[^.]*)?$/, `-${++i}$1`);
    used.add(n.toLowerCase()); parts.push({ name: n, file: f }); return n;
  };
  const item = { id: uuid(), title, file: add(main), tempo: 100, offset: 0, beatsPerBar: 4, added: Date.now() / 1000 - 978307200 };
  for (const t of tracks) if (!AUDIO.includes(ext(t.name))) throw new Error(`${t.name} isn't a recording the app can play.`);
  tracks.forEach((t, i) => {
    const n = add(t);
    if (i === 0) { item.track = n; item.trackName = n.replace(/\.[^.]*$/, ""); }
    else (item.extraTracks ||= []).push({ id: uuid(), file: n, name: n.replace(/\.[^.]*$/, ""), enabled: true, gainDB: 0, offset: 0, reduceVocals: false });
  });
  if (lyrics && lyrics !== main) { if (!["lrc", "txt"].includes(ext(lyrics.name))) throw new Error("Lyrics must be a .lrc or .txt file."); item.lyrics = add(lyrics); }
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
  <label class="field">Sheet music (MusicXML, MIDI or PDF)<input name="vscore" type="file" accept="${accept.sheet}"></label>
  <label class="field">Karaoke file (.kar or .cdg), instead of sheet music<input name="vkaraoke" type="file" accept="${accept.karaoke}"></label>
  <label class="field">Backing tracks (optional, the first is the main one)<input name="vtracks" type="file" accept="${accept.audio}" multiple></label>
  <label class="field">Lyrics (.lrc or .txt, optional with either)<input name="vlyrics" type="file" accept="${accept.lyrics}"></label>
  <div class="mp-kept" data-kept="vx"></div>
  <label class="field">PDFs and other downloads for this version (optional, for buyers to use outside Maestro Pro)<input name="vextras" type="file" accept=".pdf,${accept.score},${accept.audio}" multiple></label>
  ${n ? '<button class="pay__btn pay__btn--ghost" type="button" data-rm>Remove this version</button>' : ""}</fieldset>`;
const keptBoxes = (box, files) => { box.innerHTML = files.length ? files.map((f) => `<label><input type="checkbox" checked value="${esc(f.path)}"> ${esc(f.name)}</label>`).join("") : ""; };
const keptPaths = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);

/** Returns { edit(product), clear() }. */
export function mountBuilder(form, { getKey, onDone }) {
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
    el.querySelector("[data-rm]")?.addEventListener("click", () => el.remove());
    vs.append(el);
  };
  $("[data-addv]", form).addEventListener("click", () => vs.children.length < 12 && addVersion());
  const musicBox = $(".mp-music", form), tracksEl = $(".mp-tracks", form), isMusic = () => form.elements.kind.value === "music";
  const syncKind = () => { const m = isMusic(); musicBox.hidden = !m; vs.hidden = m; $("[data-addv]", form).hidden = m; $(".mp-vernote", form).hidden = m; if (m && !tracksEl.children.length) addTrack(); };
  const addTrack = (keep) => {
    const d = document.createElement("div"); d.className = "mp-track";
    d.innerHTML = `<input name="ttitle" type="text" maxlength="100" placeholder="Track title" aria-label="Track title"><input name="tfile" type="file" accept=".mp3,.m4a,.wav,.flac,.aac,.aif,.aiff" aria-label="Audio file"><button class="pay__btn pay__btn--ghost" type="button" data-rm>Remove</button>`;
    if (keep) { d.dataset.keep = keep.path; $("[name=ttitle]", d).value = keep.title || ""; $("[name=tfile]", d).title = "Current file: " + keep.name; }
    $("[data-rm]", d).addEventListener("click", () => d.remove());
    tracksEl.append(d);
  };
  $("[data-addt]", form).addEventListener("click", () => tracksEl.children.length < 60 && addTrack());
  form.querySelectorAll("input[name=kind]").forEach((r) => r.addEventListener("change", syncKind));
  form.addEventListener("change", (e) => { if (e.target.name === "genre" && form.querySelectorAll("input[name=genre]:checked").length > 3) { e.target.checked = false; say("Choose up to 3 genres.", true); } });
  const syncDist = () => { $(".mp-dist__when", form).hidden = form.elements.dist.value !== "date"; };
  form.querySelectorAll("input[name=dist]").forEach((r) => r.addEventListener("change", syncDist));
  const clear = () => {
    editing = null; form.reset(); vs.innerHTML = ""; tracksEl.innerHTML = ""; addVersion(); setRegions([]); sync(); syncKind(); syncDist();
    keptBoxes($("[data-kept=proof]", form), []); keptBoxes($("[data-kept=cover]", form), []);
    submit.textContent = "Submit for review"; $("[data-cancel]", form).hidden = true; say("");
  };
  $("[data-cancel]", form).addEventListener("click", () => { clear(); onDone?.(); });
  const edit = (p) => {
    clear(); editing = { id: p.id };
    const f = form.elements;
    f.title.value = p.title; f.composer.value = p.composer || ""; f.description.value = p.edit.description || ""; f.price.value = Number(p.priceUSD).toFixed(2);
    some.value = p.regions.length ? "some" : "all"; setRegions(p.regions); sync();
    vs.innerHTML = ""; p.edit.variants.forEach((v) => addVersion(v));
    if (p.edit.kind === "music") {
      form.elements.kind.value = "music"; f.format.value = p.edit.format || "single"; tracksEl.innerHTML = "";
      p.edit.extras.filter((x) => !x.cover).forEach((x) => addTrack(x));
      keptBoxes($("[data-kept=cover]", form), p.edit.extras.filter((x) => x.cover));
    } else form.elements.kind.value = "score";
    form.querySelectorAll("input[name=genre]").forEach((i) => (i.checked = (p.edit.genres || []).includes(i.value)));
    syncKind();
    const rl = p.edit.release || { mode: "auto" };
    form.elements.dist.value = rl.mode; if (rl.mode === "date") { const d = new Date(rl.at).toISOString(); f.relDate.value = d.slice(0, 10); f.relTime.value = d.slice(11, 16); }
    syncDist();
    // each download stays with its own version (older items had them in one list: they go with the first version)
    [...vs.children].forEach((el, i) => keptBoxes($("[data-kept=vx]", el), p.edit.extras.filter((x) => (x.v ? x.v === el.dataset.keep : i === 0))));
    keptBoxes($("[data-kept=proof]", form), p.edit.proof.files || []);
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
    let release = { mode: form.elements.dist.value };
    if (release.mode === "date") {
      const at = Date.parse(`${form.relDate.value}T${form.relTime.value || "00:00"}:00Z`);   // the date and time are GMT
      if (!form.relDate.value || !Number.isFinite(at)) return say("Choose the release date (GMT).", true);
      if (at < Date.now()) return say("The release date must be in the future (GMT).", true);
      release.at = at;
    }
    const regions = some.value === "some" ? [...list.querySelectorAll("input[name=region]:checked")].map((i) => i.value) : [];
    if (some.value === "some" && !regions.length) return say("Tick at least one country, or sell worldwide.", true);
    submit.disabled = true;
    try {
      const f = form.elements, title = f.title.value.trim(), id = editing?.id || crypto.randomUUID();
      const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client");
      const up = (path, blob, what) => upload(path, blob, { access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify({ key }), multipart: blob.size > 8e6,
        contentType: blob.type || "application/octet-stream", onUploadProgress: (p) => say(`Uploading ${what}… ${Math.round(p.percentage)}%`) });
      const music = isMusic(), blocks = music ? [] : [...vs.children], variants = [], extras = [];
      for (const el of blocks) {
        const label = $("[name=vlabel]", el).value.trim(), score = $("[name=vscore]", el).files[0], karaoke = $("[name=vkaraoke]", el).files[0];
        const addExtras = async (vid) => {   // this version's downloads: the kept ones, then any new files
          for (const path of keptPaths($("[data-kept=vx]", el))) extras.push({ path, v: vid });
          for (const file of [...$("[name=vextras]", el).files]) { const path = `marketplace/extras/${id}/${crypto.randomUUID()}-${safe(file.name)}`; await up(path, file, file.name); extras.push({ path, v: vid }); }
        };
        if (!score && !karaoke && el.dataset.keep) { variants.push({ id: el.dataset.keep, label }); await addExtras(el.dataset.keep); continue; }
        if (blocks.length > 1 && !label) throw new Error("Name each version, for example the key or the instrument.");
        const tracks = [...$("[name=vtracks]", el).files], lyrics = $("[name=vlyrics]", el).files[0];
        const bundle = await makeBundle({ title: blocks.length > 1 && label ? `${title} (${label})` : title, score, karaoke, tracks, lyrics });
        const vid = crypto.randomUUID();
        await up(`marketplace/bundles/${vid}.maestropro`, bundle, label || "the music");
        variants.push({ id: vid, label });
        await addExtras(vid);
      }
      const proof = keptPaths($("[data-kept=proof]", form));
      for (const file of [...f.proofFiles.files]) { if (!/\.(pdf|png|jpe?g|txt)$/i.test(file.name)) throw new Error(`${file.name} isn't allowed as proof. Use PDF, PNG, JPG or TXT.`); const path = `marketplace/evidence/${id}/${crypto.randomUUID()}-${safe(file.name)}`; await up(path, file, file.name); proof.push(path); }
      let relBody = {};
      if (music) {
        const rows = [...tracksEl.children], tracks = [], range = { single: [1, 3], ep: [1, 60], album: [1, 60] }[f.format.value];
        if (rows.length < range[0] || rows.length > range[1]) throw new Error(f.format.value === "single" ? "A single has 1 to 3 tracks." : "Add at least one track.");
        for (const r of rows) {
          const t = $("[name=ttitle]", r).value.trim(), file = $("[name=tfile]", r).files[0];
          if (!t) throw new Error("Give every track a title.");
          if (!file && !r.dataset.keep) throw new Error(`Choose the audio file for "${t}".`);
          if (file && !AUDIO.includes(ext(file.name))) throw new Error(`${file.name} isn't an audio file we accept (MP3, M4A, WAV or FLAC).`);
          let path = r.dataset.keep;
          if (file) { path = `marketplace/extras/${id}/${crypto.randomUUID()}-${safe(file.name)}`; await up(path, file, t); }
          tracks.push({ path, title: t });
        }
        let cover = keptPaths($("[data-kept=cover]", form))[0] || "";
        const art = f.cover.files[0];
        if (art) { if (!/\.(png|jpe?g)$/i.test(art.name)) throw new Error("Cover art must be a PNG or JPG."); cover = `marketplace/extras/${id}/${crypto.randomUUID()}-${safe(art.name)}`; await up(cover, art, "the cover art"); }
        relBody = { kind: "music", format: f.format.value, tracks, cover };
      }
      const contents = [variants.length > 1 ? `${variants.length} versions` : "Score", extras.length && `${extras.length} download${extras.length > 1 ? "s" : ""}`].filter(Boolean).join(", ");
      await api(editing ? "edit" : "publish", { method: "POST", key, body: { id, title, composer: f.composer.value, description: f.description.value, priceUSD: f.price.value.trim(), contents, regions, rights: f.rights.checked, genres: [...form.querySelectorAll("input[name=genre]:checked")].map((i) => i.value), release: { ...release }, variants, extras, ...relBody, proof: { text: f.proofText.value, files: proof }, ...(f.debugCode?.value && { debugCode: f.debugCode.value }) } });
      clear(); say("Submitted for review. Every file is checked, then the whole product is reviewed against the guidelines. You will be emailed the result.");
      onDone?.();
    } catch (err) { say(err.message, true); }
    submit.disabled = false;
  });
  clear();
  return { edit, clear };
}

export const builderFields = `
  <fieldset class="field mp-kind"><legend>What are you selling?</legend>
    <label><input type="radio" name="kind" value="score" checked> Sheet music, karaoke or backing tracks for Maestro Pro</label>
    <label><input type="radio" name="kind" value="music"> Produced music: a single, EP or album</label></fieldset>
  <label class="field">Title<input name="title" type="text" required maxlength="100"></label>
  <label class="field">Composer, arranger or artist<input name="composer" type="text" maxlength="100"></label>
  <label class="field">Description<textarea name="description" rows="3" maxlength="600"></textarea></label>
  <label class="field">Price in US dollars (from 1.00, ending .00, .25, .50 or .75)<input name="price" type="number" inputmode="decimal" min="1" max="999.75" step="0.25" required></label>
  <div class="mp-music" hidden>
    <label class="field">Release type<select name="format"><option value="single">Single (1 to 3 tracks)</option><option value="ep">EP</option><option value="album">Album</option></select></label>
    <div class="mp-kept" data-kept="cover"></div>
    <label class="field">Cover art (optional, PNG or JPG)<input name="cover" type="file" accept=".png,.jpg,.jpeg"></label>
    <div class="mp-tracks"></div>
    <button class="pay__btn pay__btn--ghost" type="button" data-addt>Add a track</button>
    <p class="mp-note">MP3, M4A, WAV or FLAC. Buyers can download every track. MP3 tracks get a short preview on the item page. Only sell recordings you own (<a href="/marketplace/guidelines/#g3-5" target="_blank">guideline 3.5</a>).</p>
  </div>
  <div class="mp-vers"></div>
  <button class="pay__btn pay__btn--ghost" type="button" data-addv>Add another version (a different key or instrument)</button>
  <p class="mp-note mp-vernote">Buyers get every version. Put different keys or instruments of the same piece here, not in separate products. Add each version's PDFs to that version.</p>
  <fieldset class="field"><legend>Proof that you own the rights (optional)</legend>
    <p class="mp-note">A licence, a letter of permission, a copyright registration, or dated drafts or project files that show you wrote it. PDF, PNG, JPG or TXT, 25 MB each, up to 5 files.</p>
    <label class="field">How do you hold the rights?<textarea name="proofText" rows="2" maxlength="1500"></textarea></label>
    <div class="mp-kept" data-kept="proof"></div>
    <input name="proofFiles" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" multiple></fieldset>
  <fieldset class="field mp-genres"><legend>Genres (optional, up to 3)</legend>${GENRES.map((g) => `<label><input type="checkbox" name="genre" value="${esc(g)}"> ${esc(g)}</label>`).join("")}</fieldset>
  <fieldset class="field mp-dist"><legend>Distribution</legend>
    <label><input type="radio" name="dist" value="auto" checked> Automatically: on sale as soon as it is approved</label>
    <label><input type="radio" name="dist" value="manual"> Manually: I will release it myself once it is approved</label>
    <label><input type="radio" name="dist" value="date"> Automatically on a specific date (GMT)</label>
    <div class="mp-dist__when" hidden><label class="field">Date (GMT)<input name="relDate" type="date"></label><label class="field">Time (GMT)<input name="relTime" type="time" value="00:00"></label></div>
    <p class="mp-note">An approved item that has not been released yet shows as Awaiting Distribution.</p></fieldset>
  <fieldset class="field"><legend>Where is this sold?</legend>
    <label><input type="radio" name="where" value="all" checked> Worldwide</label>
    <label><input type="radio" name="where" value="some"> Only these countries (you must hold the rights there; see guideline 2.9)</label>
    <div class="mp-regions" hidden></div></fieldset>
  <details class="mp-note"><summary>Testing</summary><label class="field">Debug code<input name="debugCode" type="password" autocomplete="off"></label></details>
  <label class="field"><input name="rights" type="checkbox" required> I wrote this, or I own the rights to sell all of it, and I have read the <a href="/marketplace/guidelines/" target="_blank">Merchant Content Review Guidelines</a>.</label>
  <div class="row"><button class="pay__btn" type="submit">Submit for review</button><button class="pay__btn pay__btn--ghost" type="button" data-cancel hidden>Cancel</button></div>
  <p class="pay__msg" role="status"></p>`;

// ---- Merchant pages: the product list with each review result, shared by /marketplace/seller and /marketplace/add.
const LABEL = { scanning: "In review: checking files", reviewing: "In review", ready: "Ready For Distribution", refused: "Refused", escalated: "Final review by Maestro Pro" };
export const inReview = (p) => p.status === "scanning" || p.status === "reviewing";
const gl = (g) => `<li><a href="/marketplace/guidelines/#g${esc(g.id).replace(".", "-")}" target="_blank" rel="noopener">Guideline ${esc(g.id)}: ${esc(g.title)}</a></li>`;

/** Fills `table` (a <tbody>) with the products. `act(id, withdrawn)` is called by the withdraw / put back on sale button. */
export const gmt = (t) => new Date(t).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " GMT";
export function renderProducts(table, products, act, onAppeal, onEdit, onRemove, onRelease) {
  table.innerHTML = products.map((p) => `<tr><td><b>${esc(p.title)}</b><br><small>ID ${esc(p.code)} &middot; ${dollars(p.priceUSD)} &middot; ${esc(where(p.regions))}${p.versions?.length ? ` &middot; ${p.versions.length} versions` : ""}</small></td>
    <td><span class="mp-status mp-status--${p.withdrawn ? "refused" : p.awaiting ? "dist" : p.status === "ready" ? "ready" : p.status === "refused" ? "refused" : "wait"}">${p.withdrawn ? "Withdrawn from sale" : p.awaiting ? "Awaiting Distribution" : LABEL[p.status] || esc(p.status)}</span>${p.awaiting ? `<br><small>${p.release.mode === "date" ? "Goes on sale " + gmt(p.release.at) : "Release it when you are ready."}</small>` : ""}${p.files && inReview(p) ? `<br><small>${p.files.done} of ${p.files.total} files scanned</small>` : ""}
      ${p.status === "refused" || p.status === "escalated" ? `<div class="mp-reason">${esc(p.reason)}<ul>${(p.guidelines || []).map(gl).join("")}</ul>${p.final ? "<small>Final decision. This can't be appealed.</small>" : p.canAppeal ? `<button class="pay__btn pay__btn--ghost" data-appeal="${esc(p.id)}">Appeal with evidence</button>` : p.status === "escalated" ? "<small>Waiting for a final decision from a person at Maestro Pro.</small>" : ""}</div>` : ""}</td>
    <td>${p.sold}</td><td>${dollars(p.earnedUSD)}</td>
    <td>${p.editable ? `<button class="pay__btn pay__btn--ghost" data-edit="${esc(p.id)}">Edit</button> ` : ""}${p.removable ? `<button class="pay__btn pay__btn--ghost" data-remove="${esc(p.id)}">${inReview(p) ? "Cancel" : "Remove"}</button> ` : ""}${p.awaiting ? `<button class="pay__btn" data-release="${esc(p.id)}">Release now</button>` : p.status === "ready" ? `<button class="pay__btn pay__btn--ghost" data-id="${esc(p.id)}" data-w="${p.withdrawn ? "" : "1"}">${p.withdrawn ? "Put back on sale" : "Withdraw from sale"}</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5">Nothing yet.</td></tr>`;
  table.querySelectorAll("button[data-release]").forEach((b) => b.addEventListener("click", () => onRelease?.(products.find((p) => p.id === b.dataset.release))));
  table.querySelectorAll("button[data-remove]").forEach((b) => b.addEventListener("click", () => onRemove?.(products.find((p) => p.id === b.dataset.remove))));
  table.querySelectorAll("button[data-edit]").forEach((b) => b.addEventListener("click", () => onEdit?.(products.find((p) => p.id === b.dataset.edit))));
  table.querySelectorAll("button[data-appeal]").forEach((b) => b.addEventListener("click", () => onAppeal?.(products.find((p) => p.id === b.dataset.appeal))));
  table.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => act(b.dataset.id, Boolean(b.dataset.w))));
}
export const productsTable = `<table class="mp-table"><thead><tr><th>Product</th><th>Status</th><th>Sold</th><th>Proceeds</th><th></th></tr></thead><tbody></tbody></table>`;

/** Uploads evidence files (PDF, PNG, JPG or TXT, 15 MB each, up to 5) into a folder of the Marketplace's storage and returns their paths. */
export async function uploadEvidence(folder, id, list, payload, say = () => {}) {
  if (list.length > 5) throw new Error("Attach up to 5 files.");
  const { upload } = await import("https://esm.sh/@vercel/blob@2.8.2/client"), paths = [];
  for (const file of list) {
    if (!/\.(pdf|png|jpe?g|txt)$/i.test(file.name)) throw new Error(`${file.name} isn't allowed. Use PDF, PNG, JPG or TXT.`);
    if (file.size > 15e6) throw new Error(`${file.name} is too big. The limit is 15 MB.`);
    say(`Uploading ${file.name}…`);
    const path = `marketplace/${folder}/${id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\- ()]+/g, "_").slice(-100)}`;
    await upload(path, file, { access: "private", handleUploadUrl: API + "upload", clientPayload: JSON.stringify(payload), contentType: file.type || "application/octet-stream" });
    paths.push(path);
  }
  return paths;
}

/** Shows a file (PDF, image or text) in a window on the page instead of opening it in a new tab. */
export async function showFile(blob, name) {
  const e = name.split(".").pop().toLowerCase(), type = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain" }[e];
  let dlg = document.getElementById("mp-file");
  if (!dlg) {
    dlg = document.createElement("dialog"); dlg.id = "mp-file"; dlg.className = "mp-viewer"; dlg.setAttribute("aria-label", "File preview"); document.body.append(dlg);
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg || ev.target.closest("[data-x]")) dlg.close(); });
    dlg.addEventListener("close", () => { if (dlg.dataset.url) URL.revokeObjectURL(dlg.dataset.url); dlg.dataset.url = ""; dlg.replaceChildren(); });
  }
  let body;
  if (!type) body = "<p>There's no preview for this kind of file.</p>";
  else if (type === "text/plain") { const t = await blob.text(); body = `<pre>${esc(t.length > 200000 ? t.slice(0, 200000) + "\n\n[Shortened]" : t)}</pre>`; }
  else {
    const url = URL.createObjectURL(new Blob([blob], { type })); dlg.dataset.url = url;
    body = type.startsWith("image/") ? `<img alt="${esc(name)}" src="${url}">` : `<iframe title="${esc(name)}" src="${url}#toolbar=0&navpanes=0"></iframe>`;
  }
  dlg.innerHTML = `<div class="mp-viewer__bar"><b>${esc(name)}</b><button type="button" class="pay__btn pay__btn--ghost" data-x>Close</button></div><div class="mp-viewer__body">${body}</div>`;
  dlg.showModal();
}

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
  if (o.kind === "music") return `<h2>Your music</h2><ul>${(o.extras || []).map((x) => `<li><a href="${esc(x.url)}">${esc(x.title || x.name)}</a> <small>${size(x.size)}</small></li>`).join("")}</ul><p class="mp-note">These are yours to keep and listen to. You may not resell or share them (<a href="/marketplace/guidelines/#g6-3">guideline 6.3</a>).</p>`;
  const v = o.variants || [], label = (x) => (x.label ? ` (${esc(x.label)})` : "");
  return `<h2>For Maestro Pro</h2>
    <p>${v.map((x) => `<a class="pay__btn" href="${esc(x.url)}">Download ${esc(o.title)}${label(x)}</a>`).join(" ")}</p>
    <p class="mp-note">Open the downloaded file in Maestro Pro. It is added to your library, and so is every version.</p>
    <h2>For use outside Maestro Pro</h2>
    ${(o.extras || []).length ? `<ul>${o.extras.map((x) => `<li><a href="${esc(x.url)}">${esc(x.name)}</a> <small>${size(x.size)}</small></li>`).join("")}</ul>` : ""}
    ${v.map((x) => `${v.length > 1 ? `<h3>${esc(x.label || "Main version")}</h3>` : ""}${(x.extras || []).length ? `<ul>${x.extras.map((e) => `<li><a href="${esc(e.url)}">${esc(e.name)}</a> <small>${size(e.size)}</small></li>`).join("")}</ul>` : ""}<details><summary>Every file in ${esc(o.title)}${label(x)}</summary><ul>${x.files.map((f) => `<li><a href="${esc(f.url)}">${esc(f.name)}</a> <small>${size(f.size)}</small></li>`).join("")}</ul></details>`).join("")}
    <p class="mp-note">You may use these files for yourself: to play, practise and print a copy. You may not resell or share them (<a href="/marketplace/guidelines/#g6-3">guideline 6.3</a>).</p>`;
}
