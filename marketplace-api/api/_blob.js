// Storage for the marketplace: small JSON files in a Vercel Blob store, written with an ETag check so two requests never overwrite each other.
// Needs BLOB_READ_WRITE_TOKEN. BLOB_ACCESS is "private" (default) or "public", and must match how the store was created.
import { put, get, head, BlobPreconditionFailedError } from "@vercel/blob";

const ACCESS = () => (process.env.BLOB_ACCESS === "public" ? "public" : "private");

export async function readVersioned(path) {
  try {
    const r = await get(path, { access: ACCESS(), useCache: false });
    if (!r || r.statusCode !== 200) return { data: null, etag: null };
    const data = JSON.parse(await new Response(r.stream).text());
    let etag = r.blob.etag;
    // A large file comes back compressed with a weak ETag (W/"..."), which ifMatch never accepts: ask for the real one.
    if (/^W\//.test(etag || "")) etag = (await head(path).catch(() => null))?.etag || etag.replace(/^W\//, "");
    return { data, etag };
  } catch (e) { console.error("blob read", path, e?.message); return { data: null, etag: null }; }
}
export const readJson = async (path) => (await readVersioned(path)).data;

/** Writes only if nobody else has since. False when someone got there first. */
export async function writeVersioned(path, data, etag) {
  try {
    await put(path, JSON.stringify(data), { access: ACCESS(), addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60, ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }) });
    return true;
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e?.message))) { console.error("blob write refused", path, "etag", etag, e?.name, String(e?.message).slice(0, 200)); return false; }
    throw e;
  }
}
export const writeRaw = (path, data) => put(path, JSON.stringify(data), { access: ACCESS(), allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60 });

/** Read, change and write a JSON file, trying again if someone else wrote in between. `change` gets the current value (or null) and returns the new one. */
export async function modify(path, change) {
  for (let i = 0; i < 12; i++) {
    if (i) await new Promise((r) => setTimeout(r, Math.random() * 120 * i));   // back off so competing writers stop colliding
    const { data, etag } = await readVersioned(path);
    const next = change(data);
    if (next === undefined) return data;   // nothing to change
    if (await writeVersioned(path, next, etag)) return next;
  }
  throw new Error("busy");
}

// ---- The products. One index file holds every product, whatever its status.
export const INDEX = "marketplace/index.json";
export const products = async () => (await readJson(INDEX)) || [];
export const addProduct = (p) => modify(INDEX, (all) => [...(all || []), p]);
/** Changes one product; `change` gets it and returns the new one (or undefined to leave it). Returns the stored product, or null if there is none. */
export async function updateProduct(id, change) {
  let out = null;
  await modify(INDEX, (all) => {
    const i = (all || []).findIndex((p) => p.id === id);
    if (i < 0) return undefined;
    const next = change(all[i]);
    if (next === undefined) { out = all[i]; return undefined; }
    out = next;
    return all.map((p, k) => (k === i ? next : p));
  });
  return out;
}
