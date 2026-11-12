import { $, $$, html, raw, api, toast, modal, busy, formData, kwacha, kw0, dayOf, today, pill, openBlob, bars, phoneFmt } from './core.js';

const SECTIONS = [
  ['overview', 'Overview'], ['operators', 'Bus companies'], ['disputes', 'Complaints & disputes'], ['payments', 'Payments & refunds'],
  ['settlements', 'Operator payouts'], ['fees', 'Fees & commission'], ['promos', 'Promo codes'], ['notify', 'Notifications'], ['audit', 'Audit log'],
];

export async function render(app, section) {
  if (!SECTIONS.some(s => s[0] === section)) { location.hash = '#/admin/overview'; return; }
  app.innerHTML = html`<div class="shell"><nav class="side" aria-label="Admin sections"><span class="label">Platform admin</span>
    ${SECTIONS.map(([k, l]) => html`<a href="#/admin/${k}" class="${k === section ? 'on' : ''}">${l}</a>`)}</nav><div class="main" id="main"><div class="empty"><span class="spinner"></span></div></div></div>`;
  const main = $('#main', app);
  try { await VIEWS[section](main); } catch (e) { main.innerHTML = html`<div class="notice bad">${e.message}</div>`; }
}

async function overview(main, days = 30) {
  const a = await api('/admin/analytics?days=' + days);
  const t = a.totals;
  main.innerHTML = html`<div class="head"><h1>Platform overview</h1><select id="days" style="width:auto">${[7, 30, 90, 365].map(d => html`<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`)}</select></div>
    ${a.pending_operators || a.open_disputes ? html`<div class="notice">${a.pending_operators ? html`<a href="#/admin/operators">${a.pending_operators} bus compan${a.pending_operators > 1 ? 'ies' : 'y'} waiting for approval</a>. ` : ''}${a.open_disputes ? html`<a href="#/admin/disputes">${a.open_disputes} open complaint${a.open_disputes > 1 ? 's' : ''}</a>.` : ''}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><span class="label">Gross merchandise value</span><b>${kw0(t.gmv)}</b><span class="small muted">paid by passengers</span></div>
      <div class="kpi"><span class="label">Platform revenue</span><b>${kw0(t.revenue)}</b><span class="small muted">commission + booking fees</span></div>
      <div class="kpi"><span class="label">Bookings</span><b>${t.bookings.toLocaleString()}</b><span class="small muted">${t.seats.toLocaleString()} seats</span></div>
      <div class="kpi"><span class="label">Registered passengers</span><b>${a.total_passengers.toLocaleString()}</b><span class="small muted">+${a.user_growth.reduce((x, d) => x + d.n, 0)} in period</span></div>
    </div>
    <div class="card"><h3>Daily GMV</h3>${raw(bars(a.daily.map(d => ({ label: dayOf(d.day), value: d.gmv })), { fmt: kw0 }))}</div>
    <div class="grid2">
      <div class="card"><h3>Top routes</h3><div class="tablewrap"><table><thead><tr><th>Route</th><th class="r">Bookings</th><th class="r">GMV</th></tr></thead><tbody>${a.routes.map(r => html`<tr><td>${r.route}</td><td class="r num">${r.bookings}</td><td class="r num">${kw0(r.gmv)}</td></tr>`)}</tbody></table></div></div>
      <div class="card"><h3>Bus companies</h3><div class="tablewrap"><table><thead><tr><th>Company</th><th class="r">Bookings</th><th class="r">GMV</th><th class="r">Our revenue</th></tr></thead><tbody>${a.operators.map(o => html`<tr><td>${o.name}</td><td class="r num">${o.bookings}</td><td class="r num">${kw0(o.gmv)}</td><td class="r num">${kw0(o.revenue)}</td></tr>`)}</tbody></table></div></div>
      <div class="card"><h3>Seasonality (by month)</h3>${raw(bars(a.monthly.map(m => ({ label: m.month, value: m.gmv })), { fmt: kw0 }))}</div>
      <div class="card"><h3>Sales channels & payment methods</h3><div class="tablewrap"><table><tbody>
        ${a.channels.map(c => html`<tr><td>${{ web: 'Online', counter: 'Station counter', agent: 'Conductor' }[c.channel]}</td><td class="r num">${c.n}</td></tr>`)}
        ${a.payment_methods.map(p => html`<tr><td>${p.provider.toUpperCase()}</td><td class="r num">${p.ok} ok${p.failed ? html` · <span style="color:var(--bad)">${p.failed} failed</span>` : ''}</td></tr>`)}</tbody></table></div></div>
    </div>`;
  $('#days', main).addEventListener('change', e => overview(main, Number(e.target.value)));
}

async function operators(main) {
  const list = await api('/admin/operators');
  main.innerHTML = html`<div class="head"><h1>Bus companies</h1></div>
    ${list.map(o => html`<div class="card">
      <div class="head"><div><h2>${o.name}</h2><span class="small muted">PACRA ${o.pacra_no || '—'} · TPIN ${o.tpin || '—'} · ${phoneFmt(o.contact_phone)} · ${o.buses} buses${o.rating ? ` · ${o.rating}★` : ''}</span></div>
        <div class="row">${pill(o.status)}${o.rtsa_verified ? raw('<span class="pill ok">RTSA verified</span>') : raw('<span class="pill warn">RTSA not verified</span>')}</div></div>
      ${o.status_note ? html`<div class="small muted">Note: ${o.status_note}</div>` : ''}
      <div class="tablewrap"><table><tbody>${o.documents.length ? o.documents.map(d => html`<tr><td>${d.kind.replace('_', ' ')}</td><td><a href="#" data-doc="${d.id}">${d.filename}</a></td><td class="small">${d.expires_on ? 'expires ' + dayOf(d.expires_on) : ''}</td><td>${pill(d.status)}</td>
        <td>${d.status === 'submitted' ? html`<button class="btn ghost sm" data-docst="${d.id}" data-to="verified">Verify</button> <button class="btn danger sm" data-docst="${d.id}" data-to="rejected">Reject</button>` : ''}</td></tr>`) : raw('<tr><td class="muted">No documents uploaded.</td></tr>')}</tbody></table></div>
      <div class="row">
        ${o.status !== 'approved' ? html`<button class="btn" data-st="${o.id}" data-to="approved">Approve</button>` : ''}
        ${o.status === 'approved' ? html`<button class="btn danger" data-st="${o.id}" data-to="suspended">Suspend</button>` : ''}
        ${o.status === 'pending' ? html`<button class="btn danger" data-st="${o.id}" data-to="rejected">Reject</button>` : ''}
        <button class="btn ghost" data-terms="${o.id}">Commission ${o.commission_pct ?? 'default'}${o.commission_pct != null ? '%' : ''} · fee ${o.booking_fee != null ? kwacha(o.booking_fee) : 'default'}</button>
      </div></div>`)}`;
  main.addEventListener('click', async e => {
    const doc = e.target.closest('[data-doc]');
    if (doc) { e.preventDefault(); openBlob('/documents/' + doc.dataset.doc).catch(err => toast(err.message, true)); }
    const ds = e.target.closest('[data-docst]');
    if (ds) busy(ds, async () => { await api('/admin/documents/' + ds.dataset.docst, { method: 'POST', body: { status: ds.dataset.to } }); operators(main); });
    const st = e.target.closest('[data-st]');
    if (st) {
      const o = list.find(x => x.id === Number(st.dataset.st)), to = st.dataset.to;
      const m = modal(html`<h2>${to === 'approved' ? 'Approve' : to === 'suspended' ? 'Suspend' : 'Reject'} ${o.name}</h2>
        <form id="sf" class="page" style="gap:10px">${to === 'approved' ? html`<p style="margin:0">Their buses become bookable immediately. Check that the PACRA, RTSA and tax documents are valid.</p><label class="chip" style="justify-self:start"><input type="checkbox" name="override">Approve even if a document is missing</label>`
          : html`<p style="margin:0">${to === 'suspended' ? 'Their buses disappear from search. Existing bookings stay valid.' : 'The company is told why.'}</p>`}
          <label class="field"><span>Note to the company${to === 'approved' ? ' (optional)' : ''}</span><textarea name="note" ${to === 'approved' ? '' : 'required'}></textarea></label>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn ${to === 'approved' ? '' : 'danger'}">Confirm</button></div></form>`);
      const f = $('#sf', m.el);
      f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { const v = formData(f); await api(`/admin/operators/${o.id}/status`, { method: 'POST', body: { status: to, note: v.note, override: !!v.override } }); m.close(); toast(`${o.name} ${to}.`); operators(main); }); });
    }
    const tm = e.target.closest('[data-terms]');
    if (tm) {
      const o = list.find(x => x.id === Number(tm.dataset.terms));
      const m = modal(html`<h2>Terms for ${o.name}</h2><p class="small muted" style="margin:0">Leave blank to use the platform defaults.</p><form id="tf" class="grid2">
        <label class="field"><span>Commission %</span><input name="commission_pct" type="number" step="0.1" min="0" max="30" value="${o.commission_pct ?? ''}"></label>
        <label class="field"><span>Booking fee (K, per booking)</span><input name="booking_fee" type="number" step="0.5" min="0" value="${o.booking_fee ?? ''}"></label>
        <div></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      const f = $('#tf', m.el);
      f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api(`/admin/operators/${o.id}/terms`, { method: 'PUT', body: formData(f) }); m.close(); toast('Terms saved.'); operators(main); }); });
    }
  });
}

async function disputes(main, status = 'open') {
  const list = await api('/admin/disputes?status=' + status);
  const cat = { payment_failed: 'Paid, no ticket', trip_cancelled: 'Trip did not run', refund: 'Refund missing', service: 'Service', other: 'Other' };
  main.innerHTML = html`<div class="head"><h1>Complaints & disputes</h1><select id="st" style="width:auto">${['open', 'resolved', 'rejected', 'all'].map(s => html`<option ${s === status ? 'selected' : ''}>${s}</option>`)}</select></div>
    ${list.length ? html`<div class="tablewrap"><table><thead><tr><th>#</th><th>Type</th><th>Booking</th><th>Description</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(d => html`<tr><td>${d.id}<br><span class="small muted">${d.created_at.slice(0, 10)}</span></td><td>${cat[d.category]}</td>
        <td class="small">${d.ref ? html`<span class="mono">${d.ref}</span><br>${d.operator} · ${kwacha(d.total)}<br>${d.contact_name} ${phoneFmt(d.contact_phone)}` : '—'}</td>
        <td style="max-width:380px">${d.description}${d.resolution ? html`<div class="small muted">→ ${d.resolution}${d.refund_amount ? ` (refund ${kwacha(d.refund_amount)})` : ''}</div>` : ''}</td><td>${pill(d.status)}</td>
        <td>${d.status === 'open' ? html`<button class="btn sm" data-resolve="${d.id}">Resolve</button>` : ''}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty">Nothing here.</div>')}`;
  $('#st', main).addEventListener('change', e => disputes(main, e.target.value));
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-resolve]'); if (!b) return;
    const d = list.find(x => x.id === Number(b.dataset.resolve));
    const m = modal(html`<h2>Case #${d.id}</h2><p style="margin:0">${d.description}</p><form id="rf" class="page" style="gap:10px">
      <label class="field"><span>Answer to the passenger (sent by SMS)</span><textarea name="resolution" required></textarea></label>
      <label class="field" style="max-width:220px"><span>Refund (K)${d.total ? ` · paid ${kwacha(d.total)}` : ''}</span><input name="refund_amount" type="number" min="0" step="0.01" ${d.ref ? '' : 'disabled'}></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn danger" id="rej">Reject</button><button class="btn">Resolve</button></div></form>`);
    const f = $('#rf', m.el);
    const send = (status, btn) => busy(btn, async () => { await api(`/admin/disputes/${d.id}/resolve`, { method: 'POST', body: { ...formData(f), status } }); m.close(); toast(`Case #${d.id} ${status}.`); disputes(main, status === 'rejected' ? 'open' : 'open'); });
    f.addEventListener('submit', ev => { ev.preventDefault(); send('resolved', f.querySelector('.btn:last-child')); });
    $('#rej', m.el).addEventListener('click', ev => { if (!f.reportValidity()) return; send('rejected', ev.target); });
  });
}

async function payments(main) {
  const [failed, refunds] = await Promise.all([api('/admin/payments?status=failed'), api('/admin/refunds?status=pending')]);
  main.innerHTML = html`<div class="head"><h1>Payments & refunds</h1></div>
    <div class="card"><h3>Refunds to pay out (${refunds.length})</h3><p class="small muted" style="margin:0">Send the money from the mobile money or card merchant portal, then mark it paid here. The passenger is not told until you mark it.</p>
      ${refunds.length ? html`<div class="tablewrap"><table><thead><tr><th>Booking</th><th>Company</th><th>To</th><th class="r">Amount</th><th>Reason</th><th></th></tr></thead><tbody>
        ${refunds.map(r => html`<tr><td class="mono">${r.ref}</td><td>${r.operator}</td><td class="small">${r.payment_method || '—'} ${phoneFmt(r.contact_phone)}</td><td class="r num">${kwacha(r.amount)}</td><td class="small">${r.reason}</td>
          <td><div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn sm" data-ref="${r.id}" data-to="paid">Paid</button><button class="btn danger sm" data-ref="${r.id}" data-to="failed">Failed</button></div></td></tr>`)}</tbody></table></div>` : raw('<div class="empty small">No refunds waiting.</div>')}</div>
    <div class="card"><h3>Failed payments, most recent</h3>${failed.length ? html`<div class="tablewrap"><table><thead><tr><th>When</th><th>Method</th><th>Number</th><th class="r">Amount</th><th>Reason</th><th>Bookings</th></tr></thead><tbody>
      ${failed.map(p => html`<tr><td class="small">${p.created_at}</td><td>${p.provider.toUpperCase()}</td><td class="num">${phoneFmt(p.msisdn || p.phone)}</td><td class="r num">${kwacha(p.amount)}</td><td class="small">${p.failure_reason}</td><td class="mono small">${p.refs}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty small">No failed payments.</div>')}</div>`;
  main.addEventListener('click', e => { const b = e.target.closest('[data-ref]'); if (b) busy(b, async () => { await api('/admin/refunds/' + b.dataset.ref, { method: 'POST', body: { status: b.dataset.to } }); toast('Updated.'); payments(main); }); });
}

async function settlements(main) {
  const list = await api('/admin/settlements');
  main.innerHTML = html`<div class="head"><h1>Operator payouts</h1></div>
    ${list.length ? html`<div class="tablewrap"><table><thead><tr><th>Requested</th><th>Company</th><th class="r">Amount</th><th>Bank</th><th>Balance check</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(s => html`<tr><td class="small">${s.created_at.slice(0, 16)}</td><td>${s.operator}</td><td class="r num"><b>${kwacha(s.amount)}</b></td><td class="small">${s.bank_snapshot}</td>
        <td class="small">${s.balance ? html`Earned ${kw0(s.balance.earned)}, withdrawn ${kw0(s.balance.withdrawn)}${s.balance.available < 0 ? raw(' <span class="pill bad">overdrawn</span>') : ''}` : ''}</td><td>${pill(s.status)}</td>
        <td>${s.status === 'requested' ? html`<div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn sm" data-s="${s.id}" data-to="paid">Mark paid</button><button class="btn danger sm" data-s="${s.id}" data-to="rejected">Reject</button></div>` : html`<span class="small muted">${s.note || ''}</span>`}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty">No payout requests.</div>')}`;
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    const m = modal(html`<h2>${b.dataset.to === 'paid' ? 'Confirm bank transfer' : 'Reject payout'}</h2><form id="nf" class="page" style="gap:10px"><label class="field"><span>${b.dataset.to === 'paid' ? 'Bank transfer reference' : 'Reason'}</span><input name="note" required></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Confirm</button></div></form>`);
    const f = $('#nf', m.el);
    f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/admin/settlements/' + b.dataset.s, { method: 'POST', body: { status: b.dataset.to, note: f.note.value } }); m.close(); settlements(main); }); });
  });
}

async function fees(main) {
  const s = await api('/admin/settings');
  main.innerHTML = html`<div class="head"><h1>Fees & commission</h1></div>
    <form class="card" id="ff"><p class="small muted" style="margin:0">Platform defaults. Override them per company under Bus companies.</p><div class="grid2">
      <label class="field"><span>Booking fee charged to passengers (K per booking)</span><input name="booking_fee" type="number" step="0.5" min="0" value="${s.booking_fee}"></label>
      <label class="field"><span>Commission on fares (%)</span><input name="commission_pct" type="number" step="0.1" min="0" max="30" value="${s.commission_pct}"></label>
      <label class="field"><span>Seat lock during checkout (minutes, 5–15)</span><input name="hold_minutes" type="number" min="5" max="15" value="${s.hold_minutes}"></label>
      <label class="field"><span>Pay-at-station reservation (minutes)</span><input name="reserve_minutes" type="number" min="10" max="120" value="${s.reserve_minutes}"></label></div>
      <div class="small muted">Default refund policy: ${s.refund_policy.map(t => `${t.pct}% if ${t.hours}h+ before`).join(', ')}. Companies set their own.</div>
      <div><button class="btn">Save</button></div></form>`;
  const f = $('#ff', main);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => { await api('/admin/settings', { method: 'PUT', body: formData(f) }); toast('Saved. New bookings use these values.'); }); });
}

async function promos(main) {
  const list = await api('/admin/promos');
  main.innerHTML = html`<div class="head"><h1>Promo codes</h1><button class="btn" id="add">New platform promo</button></div>
    <p class="small muted" style="margin:0">Platform promos work on every company and the discount comes out of the fare. Company promos are listed for reference.</p>
    <div class="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Company</th><th class="r">% off</th><th>Valid</th><th>Used</th><th></th></tr></thead><tbody>
      ${list.map(p => html`<tr style="${p.active ? '' : 'opacity:.55'}"><td class="mono"><b>${p.code}</b></td><td>${p.name}</td><td>${p.operator || 'All companies'}</td><td class="r num">${p.pct}</td>
        <td class="small">${p.start_date || p.end_date ? `${p.start_date ? dayOf(p.start_date) : '…'} – ${p.end_date ? dayOf(p.end_date) : '…'}` : 'Always'}</td><td class="num">${p.used}${p.max_uses ? ' / ' + p.max_uses : ''}</td>
        <td>${p.operator ? '' : html`<button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Turn off' : 'Turn on'}</button>`}</td></tr>`)}</tbody></table></div>`;
  $('#add', main).addEventListener('click', () => {
    const m = modal(html`<h2>New promo code</h2><form id="pf" class="grid2">
      <label class="field"><span>Code</span><input name="code" style="text-transform:uppercase" required></label><label class="field"><span>Name</span><input name="name" placeholder="Independence Day" required></label>
      <label class="field"><span>% off fares</span><input name="pct" type="number" min="1" max="50" required></label><label class="field"><span>Maximum uses</span><input name="max_uses" type="number" min="1"></label>
      <label class="field"><span>From</span><input name="start_date" type="date" min="${today()}"></label><label class="field"><span>To</span><input name="end_date" type="date" min="${today()}"></label>
      <div class="row" style="justify-content:flex-end;grid-column:1/-1"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Create</button></div></form>`);
    const f = $('#pf', m.el);
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/admin/promos', { method: 'POST', body: formData(f) }); m.close(); toast('Promo created.'); promos(main); }); });
  });
  main.addEventListener('click', e => { const b = e.target.closest('[data-toggle]'); if (b) busy(b, async () => { await api('/admin/promos/' + b.dataset.toggle, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); promos(main); }); });
}

async function notify(main) {
  const [log, cities] = await Promise.all([api('/admin/notifications'), api('/cities')]);
  main.innerHTML = html`<div class="head"><h1>Notifications</h1></div>
    <form class="card" id="bf"><h3>Send a broadcast</h3><div class="grid2">
      <label class="field"><span>Who</span><select name="audience" id="aud"><option value="all_passengers">All registered passengers</option><option value="route_city">Passengers with upcoming trips through a town</option><option value="trip">Passengers on one trip (trip ID)</option><option value="operators">All approved bus companies</option></select></label>
      <label class="field" id="city" hidden><span>Town</span><select name="city">${cities.map(c => html`<option>${c}</option>`)}</select></label>
      <label class="field" id="trip" hidden><span>Trip ID</span><input name="trip_id" type="number"></label></div>
      <label class="field"><span>Message (max 320 characters, sent as "MyTicket: …")</span><textarea name="message" maxlength="320" required placeholder="Kafue bridge is closed until 14:00. Buses to Livingstone will leave about 2 hours late."></textarea></label>
      <div class="chips"><label class="chip"><input type="checkbox" name="sms" checked>SMS</label><label class="chip"><input type="checkbox" name="whatsapp">WhatsApp</label></div>
      <div><button class="btn">Send</button></div></form>
    <div class="card"><h3>Outbox (latest 100)</h3><div class="tablewrap"><table><thead><tr><th>When</th><th>Channel</th><th>To</th><th>Type</th><th>Status</th><th>Message</th></tr></thead><tbody>
      ${log.map(n => html`<tr><td class="small">${n.created_at.slice(5, 16)}</td><td>${n.channel}</td><td class="small">${n.channel === 'email' ? n.recipient : phoneFmt(n.recipient)}</td><td class="small">${n.kind}</td>
        <td>${pill(n.status)}${n.last_error ? html`<div class="small muted">${n.last_error}</div>` : ''}</td><td class="small" style="max-width:360px">${n.body}</td></tr>`)}</tbody></table></div></div>`;
  const f = $('#bf', main);
  const sync = () => { $('#city', main).hidden = f.audience.value !== 'route_city'; $('#trip', main).hidden = f.audience.value !== 'trip'; };
  f.audience.addEventListener('change', sync);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn'), async () => {
    const v = formData(f);
    const r = await api('/admin/broadcast', { method: 'POST', body: { ...v, trip_id: Number(v.trip_id) || undefined, channels: ['sms', 'whatsapp'].filter(c => v[c]) } });
    toast(`Queued ${r.messages} message${r.messages === 1 ? '' : 's'} to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}.`); notify(main);
  }); });
}

async function audit(main) {
  const list = await api('/admin/audit');
  main.innerHTML = html`<div class="head"><h1>Audit log</h1></div><div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Detail</th></tr></thead><tbody>
    ${list.map(a => html`<tr><td class="small">${a.at}</td><td>${a.name || 'system'}</td><td>${a.action}</td><td class="small">${a.entity} ${a.entity_id}</td><td class="small" style="max-width:420px">${a.detail || ''}</td></tr>`)}</tbody></table></div>`;
}

const VIEWS = { overview, operators, disputes, payments, settlements, fees, promos, notify, audit };
