import { bad } from '../util.js';

/** Luggage is recorded per passenger as counts of each kind. Zero everywhere = no luggage. */
export const LUGGAGE_KINDS = [
  ['bags', 'bag', 'bags'],
  ['sacks', 'sack', 'sacks'],
  ['containers', 'container', 'containers'],
  ['boxes', 'box', 'boxes'],
  ['crates', 'crate', 'crates'],
  ['other', 'other item', 'other items'],
];
export const LUGGAGE_COLUMNS = LUGGAGE_KINDS.map(([k]) => `lug_${k}`);
export const LUGGAGE_SQL = [...LUGGAGE_COLUMNS, 'lug_note'].join(', ');
const MAX_EACH = 50;

/**
 * Accepts { has: bool, bags, sacks, containers, boxes, crates, other, note } (counts may be strings).
 * Returns column values in LUGGAGE_COLUMNS order followed by the note.
 */
export function normLuggage(l, label = 'this passenger') {
  if (!l || l.has === false || l.has === 'no') return [...LUGGAGE_COLUMNS.map(() => 0), null];
  const counts = LUGGAGE_KINDS.map(([k]) => {
    const raw = l[k] ?? 0;
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_EACH) throw bad(`Luggage for ${label}: enter a whole number from 0 to ${MAX_EACH} for ${k}.`);
    return n;
  });
  const note = String(l.note || '').trim().slice(0, 120) || null;
  if (l.has === true || l.has === 'yes') {
    if (counts.every(n => n === 0)) throw bad(`Luggage for ${label}: you said yes, so enter how many bags, sacks, containers, boxes, crates or other items.`);
  }
  if (counts[5] > 0 && !note) throw bad(`Luggage for ${label}: describe the "other" items (for example: bicycle, mattress).`);
  return [...counts, note];
}

/** Row (with lug_* columns) → { has, total, items: {bags:2,...}, note, text: "2 bags, 1 sack" } */
export function luggageOf(row) {
  const items = Object.fromEntries(LUGGAGE_KINDS.map(([k]) => [k, row[`lug_${k}`] || 0]));
  const total = Object.values(items).reduce((a, b) => a + b, 0);
  const parts = LUGGAGE_KINDS.filter(([k]) => items[k]).map(([k, one, many]) => `${items[k]} ${items[k] === 1 ? one : many}`);
  const text = total ? parts.join(', ') + (row.lug_note ? ` (${row.lug_note})` : '') : 'No luggage';
  return { has: total > 0, total, items, note: row.lug_note || null, text };
}
