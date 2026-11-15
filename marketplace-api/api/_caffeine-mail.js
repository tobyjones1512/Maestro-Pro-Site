import crypto from "node:crypto";
import { readJson, writeRaw } from "./_blob.js";
import { del } from "@vercel/blob";

const INBOX = "caffeine-mail/_inbox.json";
const SENT = "caffeine-mail/_sent.json";
const msgPath = (id) => `caffeine-mail/${id}.json`;

function newId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"); }

async function loadIndex(folder) {
  const path = folder === "sent" ? SENT : INBOX;
  try { return (await readJson(path)) || []; } catch { return []; }
}
async function saveIndex(folder, list) {
  const path = folder === "sent" ? SENT : INBOX;
  try { await writeRaw(path, list); } catch (e) { console.error("saveIndex", e?.message); }
}

export async function saveMessage(msg) {
  const folder = msg.folder || "inbox";
  await writeRaw(msgPath(msg.id), msg);
  const idx = await loadIndex(folder);
  const summary = {
    id: msg.id, folder, from: msg.from, to: msg.to, subject: msg.subject,
    date: msg.date, read: !!msg.read, hasAttachments: !!(msg.attachments && msg.attachments.length), resendId: msg.resendId || "",
    preview: String(msg.text || (msg.html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120)
  };
  const i = idx.findIndex((m) => m.id === msg.id);
  if (i >= 0) idx[i] = summary; else idx.unshift(summary);
  idx.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  await saveIndex(folder, idx);
  return msg;
}

export async function loadMessage(id) {
  try { return await readJson(msgPath(id)); } catch { return null; }
}

export async function listMessages(folder, q) {
  const idx = await loadIndex(folder);
  let out = idx;
  const query = String(q || "").trim().toLowerCase();
  if (query) out = out.filter((m) => [m.from, m.to, m.subject, m.preview].join(" ").toLowerCase().includes(query));
  return out;
}

export async function markRead(id, read) {
  const msg = await loadMessage(id);
  if (!msg) return null;
  msg.read = !!read;
  await writeRaw(msgPath(id), msg);
  for (const folder of ["inbox", "sent"]) {
    const idx = await loadIndex(folder);
    const i = idx.findIndex((m) => m.id === id);
    if (i >= 0) { idx[i].read = !!read; await saveIndex(folder, idx); }
  }
  return msg;
}

export async function deleteMessage(id) {
  try { await del(msgPath(id)); } catch (e) { console.error("del msg", e?.message); }
  for (const folder of ["inbox", "sent"]) {
    const idx = await loadIndex(folder);
    const next = idx.filter((m) => m.id !== id);
    if (next.length !== idx.length) await saveIndex(folder, next);
  }
  return true;
}

export { newId };
