import crypto from "node:crypto";
import { readJson, writeRaw } from "./_blob.js";

const INDEX = "caffeine-threads/_index.json";
const threadPath = (id) => `caffeine-threads/${id}.json`;

export function threadIdFor(customer, subject) {
  return crypto.createHash("sha256").update(String(customer || "").toLowerCase() + "|" + String(subject || "").trim()).digest("hex").slice(0, 24);
}

export async function loadIndex() {
  try { return await readJson(INDEX) || []; } catch { return []; }
}

export async function saveIndex(list) {
  try { await writeRaw(INDEX, list); } catch (e) { console.error("saveIndex", e?.message); }
}

export async function loadThread(id) {
  try { return await readJson(threadPath(id)); } catch { return null; }
}

export async function saveThread(thread) {
  try { await writeRaw(threadPath(thread.id), thread); } catch (e) { console.error("saveThread", e?.message); }
}

export async function upsertThread(customer, subject, fromKey, message) {
  const id = threadIdFor(customer, subject);
  let thread = await loadThread(id);
  if (!thread) {
    thread = { id, customer, subject, fromKey: fromKey || "", messages: [], status: "open", unread: 0, createdAt: new Date().toISOString() };
  }
  thread.messages.push(message);
  thread.lastAt = message.at || new Date().toISOString();
  if (message.dir === "in") thread.unread = (thread.unread || 0) + 1;
  if (fromKey) thread.fromKey = fromKey;
  await saveThread(thread);
  // update index
  const idx = await loadIndex();
  const i = idx.findIndex((t) => t.id === id);
  const summary = { id, customer, subject, fromKey: thread.fromKey, lastAt: thread.lastAt, unread: thread.unread, count: thread.messages.length, status: thread.status };
  if (i >= 0) idx[i] = summary; else idx.unshift(summary);
  // sort by lastAt desc
  idx.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  await saveIndex(idx);
  return thread;
}

export async function listThreads(q) {
  const idx = await loadIndex();
  const query = String(q || "").trim().toLowerCase();
  if (!query) return idx;
  return idx.filter((t) => (t.customer || "").toLowerCase().includes(query) || (t.subject || "").toLowerCase().includes(query));
}

export async function markRead(id) {
  const thread = await loadThread(id);
  if (!thread) return null;
  thread.unread = 0;
  await saveThread(thread);
  const idx = await loadIndex();
  const i = idx.findIndex((t) => t.id === id);
  if (i >= 0) { idx[i].unread = 0; await saveIndex(idx); }
  return thread;
}
