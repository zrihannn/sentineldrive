const CACHE_KEY = 'sentineldrive.os3.cache';
const OUTBOX_KEY = 'sentineldrive.os3.outbox';
const PREFS_KEY = 'sentineldrive.os3.preferences';

export function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

export function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* Browser cache is best-effort; SQLite remains primary. */ }
}

export function readPreferences(fallback = {}) {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')) }; }
  catch { return { ...fallback }; }
}

export function writePreferences(value) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(value)); } catch { /* Keep the in-memory settings active. */ }
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeOutbox(queue) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(queue)); } catch { /* Outbox is bounded below. */ }
}

export function queueSize() { return readOutbox().length; }

export async function apiGet(path, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${path}`);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function apiWrite(method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`API ${response.status}: ${message}`);
    }
    return await response.json().catch(() => ({}));
  } catch (error) {
    if (error instanceof TypeError || !navigator.onLine) {
      const queue = readOutbox();
      queue.push({ id: crypto.randomUUID(), method, path, body, queuedAt: new Date().toISOString() });
      writeOutbox(queue.slice(-5000));
      window.dispatchEvent(new CustomEvent('sentinel:queued', { detail: { count: queueSize() } }));
      return { queued: true };
    }
    throw error;
  }
}

export async function flushOutbox() {
  const queue = readOutbox();
  if (!queue.length) return { sent: 0, remaining: 0 };
  const remaining = [];
  let sent = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);
      let response;
      try {
        response = await fetch(item.path, {
          method: item.method,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: item.body === undefined ? undefined : JSON.stringify(item.body),
          signal: controller.signal,
          cache: 'no-store'
        });
      } finally { window.clearTimeout(timeout); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      sent += 1;
    } catch {
      remaining.push(item, ...queue.slice(index + 1));
      break;
    }
  }
  writeOutbox(remaining);
  window.dispatchEvent(new CustomEvent('sentinel:queue-flushed', { detail: { sent, remaining: remaining.length } }));
  return { sent, remaining: remaining.length };
}

export function downloadBlob(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const preferenceKey = PREFS_KEY;
