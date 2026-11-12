import { api, esc, toast } from './core.js';

/**
 * Live seat picker. Every click re-holds the whole selection on the server (so the lock is real),
 * and a server-sent event stream refreshes the map when anyone else holds, books or releases a seat.
 *   el        container
 *   tripId
 *   hold      { token, seats } to resume
 *   max       seat limit
 *   onChange  ({ token, seats, expires_at }) after each successful hold
 */
export function seatPicker(el, { tripId, hold = null, max = 6, onChange }) {
  let token = hold?.token || null;
  let selected = new Set(hold?.seats || []);
  let map = null, alive = true, pending = false;

  async function load() {
    map = await api(`/trips/${tripId}/seats`, { headers: token ? { 'x-hold-token': token } : {} });
    // If our hold lapsed, forget the seats the server no longer shows as ours.
    const mine = new Set(map.decks.flatMap(d => d.rows.flat()).filter(s => s?.status === 'mine').map(s => s.no));
    if (selected.size && [...selected].some(s => !mine.has(s))) {
      selected = new Set([...selected].filter(s => mine.has(s)));
      onChange?.({ token, seats: [...selected], expires_at: map.my_hold_expires });
      if (alive) toast('Some of your seats were released because the hold expired. Pick them again.', true);
    }
    render();
  }

  function render() {
    if (!alive) return;
    el.innerHTML = `<div class="decks">${map.decks.map(d => `
      <div class="deck"><div class="row" style="justify-content:space-between"><span class="label">${esc(d.name)}</span>${d.name.startsWith('Main') || d.name.startsWith('Lower') ? '<span class="label">Front ▲</span>' : ''}</div>
        <div class="deck-grid" style="grid-template-columns:repeat(${d.cols}, 38px)">${d.rows.map(r => r.map(s => !s ? '<span></span>' : `
          <button type="button" class="seat ${s.kind === 'berth' ? 'berth' : ''} ${s.female ? 'female' : ''} ${s.status}" data-seat="${esc(s.no)}"
            ${s.status === 'booked' || s.status === 'locked' ? 'disabled' : ''} aria-pressed="${s.status === 'mine'}"
            aria-label="Seat ${esc(s.no)}${s.female ? ', women only' : ''}, ${s.status === 'mine' ? 'selected' : s.status}">${esc(s.no)}</button>`).join('')).join('')}
        </div></div>`).join('')}</div>
      <div class="legend" style="margin-top:10px">
        <span><i></i>Available</span><span><i style="background:var(--seat-mine);border-color:var(--seat-mine)"></i>Your pick</span>
        <span><i style="background:var(--seat-lock);border-color:var(--seat-lock)"></i>Someone is paying</span>
        <span><i style="background:var(--seat-taken);border-color:var(--seat-taken)"></i>Booked</span>
        <span><i style="border-color:var(--seat-female)"></i>Women only</span>
      </div>`;
  }

  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-seat]');
    if (!b || b.disabled || pending) return;
    const no = b.dataset.seat;
    const next = new Set(selected);
    next.has(no) ? next.delete(no) : next.add(no);
    if (next.size > max) return toast(`You can pick up to ${max} seats.`, true);
    pending = true;
    try {
      if (next.size === 0) {
        if (token) await api(`/holds/${token}`, { method: 'DELETE' });
        selected = next;
        onChange?.({ token, seats: [], expires_at: null });
      } else {
        const r = await api(`/trips/${tripId}/holds`, { method: 'POST', body: { seats: [...next], hold_token: token } });
        token = r.hold_token; selected = next;
        onChange?.({ token, seats: r.seats, expires_at: r.expires_at });
      }
    } catch (err) {
      toast(err.message, true);
      // Our previous selection was dropped by the failed replace; re-hold what we still can.
      if (token && selected.size) {
        try { const r = await api(`/trips/${tripId}/holds`, { method: 'POST', body: { seats: [...selected], hold_token: token } }); onChange?.({ token, seats: r.seats, expires_at: r.expires_at }); }
        catch { selected = new Set(); onChange?.({ token, seats: [], expires_at: null }); }
      }
    } finally { pending = false; await load(); }
  });

  const es = new EventSource(`/api/trips/${tripId}/seats/stream`);
  let t = null;
  es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => !pending && load(), 150); });
  const poll = setInterval(() => !pending && load(), 30000); // fallback if the stream drops

  load().catch(e => { el.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
  return {
    get token() { return token; },
    get seats() { return [...selected]; },
    destroy() { alive = false; es.close(); clearInterval(poll); },
  };
}

/** mm:ss countdown into el until iso; calls onExpire once. */
export function countdown(el, iso, onExpire) {
  const tick = () => {
    if (!iso) { el.textContent = ''; return; }
    const s = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (s === 0) { clearInterval(h); onExpire?.(); }
  };
  const h = setInterval(tick, 1000); tick();
  return { set(v) { iso = v; tick(); }, stop() { clearInterval(h); } };
}
