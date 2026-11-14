// Parcel sticker printing. /label.html?ref=BAZ4521-K7Q2&size=100x50|60x40|4x6|58&auto=1
// Set the label printer as the default printer with the same label size in its driver settings.
// Tip: start Chrome with --kiosk-printing on the counter PC to print without the dialog.
import { $, html, raw, api, time, day } from './core.js';

const q = new URLSearchParams(location.search);
const SIZES = { '100x50': [100, 50], '60x40': [60, 40], '4x6': [101.6, 152.4], '58': [48, 0] };
const size = SIZES[q.get('size')] ? q.get('size') : '100x50';
const [w, h] = SIZES[size];
document.body.className = { '60x40': 's60', '4x6': 's4x6', '58': 's58' }[size] || '';
document.documentElement.style.setProperty('--w', `${w}mm`);
document.documentElement.style.setProperty('--h', h ? `${h}mm` : 'auto');
const page = document.createElement('style');
page.textContent = size === '58' ? '@page { size: 58mm auto; margin: 0 5mm; }' : `@page { size: ${w}mm ${h}mm; margin: 0; }`;
document.head.append(page);

const maskPhone = p => p ? `…${String(p).slice(-3)}` : '';
async function run() {
  try {
    const p = await api('/operator/parcels/' + encodeURIComponent(q.get('ref')) + '/label');
    const first = p.receiver_name.split(' ')[0];
    $('#labels').innerHTML = Array.from({ length: p.pieces }, (_, i) => html`<section class="label">
      <div class="top"><span>${p.operator_name}</span><span>PARCEL</span></div>
      <div class="qr">${raw(p.qr_svg)}</div>
      <div class="main">
        <div class="small">TO</div><div class="to">${p.to_city}</div>
        <div class="small">For ${first} (${maskPhone(p.receiver_phone)}) · from ${p.from_city}</div>
        <div class="code">${p.ref}</div>
      </div>
      <div class="bottom"><span>BUS ${p.plate || '—'}${p.depart_at ? ` · ${day(p.depart_at)} ${time(p.depart_at)}` : ''}</span><span class="piece">${i + 1}/${p.pieces}</span></div>
    </section>`).join('');
    if (q.get('auto') === '1') setTimeout(() => window.print(), 200);
  } catch (e) {
    $('#labels').innerHTML = html`<p class="screen-only">Could not load the labels: ${e.message}</p>`;
  }
}
$('#again').addEventListener('click', () => window.print());
$('#close').addEventListener('click', () => window.close());
run();
