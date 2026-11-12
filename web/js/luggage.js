import { html, $$ } from './core.js';

export const KINDS = [['bags', 'Bags'], ['sacks', 'Sacks'], ['containers', 'Containers'], ['boxes', 'Boxes'], ['crates', 'Crates'], ['other', 'Other']];

/** Luggage yes/no with +/− counters per kind. Field names: lug{i} (yes|no), lug{i}_{kind}, lug{i}_note. */
export function luggageFields(i, prev = {}) {
  const has = prev['lug' + i] === 'yes';
  return html`<div class="lug" data-lug="${i}">
    <div class="row" style="align-items:center;gap:8px"><span class="small" style="font-weight:600">Luggage?</span>
      <label class="chip"><input type="radio" name="lug${i}" value="no" ${has ? '' : 'checked'}>No</label>
      <label class="chip"><input type="radio" name="lug${i}" value="yes" ${has ? 'checked' : ''}>Yes</label></div>
    <div class="lug-counts" ${has ? '' : 'hidden'}>
      ${KINDS.map(([k, label]) => html`<div class="stepper"><span>${label}</span>
        <button type="button" data-step="-1" aria-label="One fewer ${label.toLowerCase()}">−</button>
        <input type="number" inputmode="numeric" min="0" max="50" name="lug${i}_${k}" value="${prev[`lug${i}_${k}`] || 0}" aria-label="${label}">
        <button type="button" data-step="1" aria-label="One more ${label.toLowerCase()}">+</button></div>`)}
      <input name="lug${i}_note" placeholder="Describe other items (e.g. bicycle, mattress)" value="${prev[`lug${i}_note`] || ''}" maxlength="120" style="grid-column:1/-1">
    </div></div>`;
}

/** Wire up yes/no toggles and +/− buttons inside root (event delegation, call once per root). */
export function bindLuggage(root, onChange) {
  root.addEventListener('change', e => {
    const r = e.target.closest('input[type=radio][name^=lug]');
    if (!r) return;
    const box = r.closest('.lug');
    box.querySelector('.lug-counts').hidden = r.value !== 'yes';
    if (r.value === 'yes' && $$('.lug-counts input[type=number]', box).every(i => !Number(i.value))) {
      const bags = box.querySelector('input[name$=_bags]'); bags.value = 1; // most people carry at least one bag
    }
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const input = b.parentElement.querySelector('input');
    input.value = Math.max(0, Math.min(50, (Number(input.value) || 0) + Number(b.dataset.step)));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onChange?.();
  });
}

/** Read one passenger's luggage from formData values. */
export function readLuggage(v, i) {
  if (v['lug' + i] !== 'yes') return { has: false };
  return { has: true, ...Object.fromEntries(KINDS.map(([k]) => [k, Number(v[`lug${i}_${k}`]) || 0])), note: v[`lug${i}_note`] || '' };
}
