// Encrypted storage for the field app. Manifests (names, masked IDs, QR payloads) and the offline scan queue
// are encrypted with AES-GCM using a key derived from the staff member's PIN (PBKDF2, 200,000 rounds).
// The key only lives in memory while the app is unlocked. 5 wrong PINs erase everything on the phone.
const PREFIX = 'mt.agent.';
const MAX_TRIES = 5, MANIFEST_TTL = 24 * 3600 * 1000;
const te = new TextEncoder(), td = new TextDecoder();
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(PREFIX + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch {} },
  keys() { try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)); } catch { return []; } },
};
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

let key = null, mem = {};

async function derive(pin, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj, k = key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(blob, k = key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, k, unb64(blob.ct));
  return JSON.parse(td.decode(pt));
}

function wipe() {
  key = null; mem = {};
  for (const n of ls.keys()) if (n === 'vault' || n === 'fails' || n.startsWith('enc.') || n.startsWith('manifest.') || n === 'queue' || n === 'trips') ls.del(n);
}
function purgeOld() {
  for (const k of Object.keys(mem)) if (k.startsWith('manifest.') && Date.now() - new Date(mem[k]?.downloaded_at || 0) > MANIFEST_TTL) vault.del(k);
}

export const vault = {
  exists: () => !!ls.get('vault'),
  ownerId: () => ls.get('vault')?.owner ?? null,
  unlocked: () => !!key,
  triesLeft: () => MAX_TRIES - (ls.get('fails') || 0),

  /** New PIN for this phone and user. Brings over any unencrypted data from older app versions (so no scans are lost). */
  async create(pin, ownerId) {
    const legacy = {};
    for (const n of ls.keys()) if (n === 'queue' || n === 'trips' || n.startsWith('manifest.')) legacy[n] = ls.get(n);
    const sameOwner = ls.get('vault')?.owner === ownerId;
    wipe();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    key = await derive(pin, salt);
    ls.set('vault', { salt: b64(salt), owner: ownerId, check: await seal({ ok: true }) });
    ls.set('fails', 0);
    mem = {};
    if (sameOwner || !Object.keys(legacy).length) for (const [k, v] of Object.entries(legacy)) await this.setNow(k, v);
  },

  async unlock(pin) {
    const v = ls.get('vault');
    if (!v) return { ok: false, missing: true };
    const k = await derive(pin, unb64(v.salt));
    try { await unseal(v.check, k); }
    catch {
      const fails = (ls.get('fails') || 0) + 1;
      ls.set('fails', fails);
      if (fails >= MAX_TRIES) { wipe(); return { ok: false, wiped: true }; }
      return { ok: false, left: MAX_TRIES - fails };
    }
    key = k; ls.set('fails', 0); mem = {};
    for (const n of ls.keys().filter(x => x.startsWith('enc.'))) { try { mem[n.slice(4)] = await unseal(ls.get(n)); } catch { ls.del(n); } }
    purgeOld();
    return { ok: true };
  },

  lock() { key = null; mem = {}; },
  get(k, d = null) { return mem[k] ?? d; },
  /** Updates memory now; the encrypted copy is written in the background. */
  set(k, v) { mem[k] = v; if (key) seal(v).then(b => ls.set('enc.' + k, b) || console.warn('Phone storage is full')); },
  async setNow(k, v) { mem[k] = v; if (key) ls.set('enc.' + k, await seal(v)); },
  del(k) { delete mem[k]; ls.del('enc.' + k); },
  keys() { return Object.keys(mem); },
  wipe,
};
