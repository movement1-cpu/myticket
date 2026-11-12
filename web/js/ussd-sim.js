// USSD simulator: replays the Africa's Talking request format (sessionId, phoneNumber, text = inputs joined by '*').
(() => {
  const $ = sel => document.querySelector(sel);
  let path = [], session = null;
  const show = (text, ended) => {
    $('#screen').textContent = text.replace(/^(CON|END) /, '');
    if (ended) $('#screen').insertAdjacentHTML('beforeend', '<div class="end">Session ended.</div>');
    $('#reply').disabled = $('#send').disabled = ended;
    if (!ended) $('#reply').focus();
  };
  async function send() {
    const body = new URLSearchParams({ sessionId: session, serviceCode: '*384*123#', phoneNumber: $('#msisdn').value, text: path.join('*') });
    const res = await fetch('/api/ussd', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const text = await res.text();
    show(text, !text.startsWith('CON'));
  }
  $('#dial').addEventListener('click', () => { path = []; session = 'sim-' + Date.now(); $('#screen').textContent = '…'; send(); });
  const reply = () => { const v = $('#reply').value.trim(); if (!v) return; path.push(v); $('#reply').value = ''; send(); };
  $('#send').addEventListener('click', reply);
  $('#reply').addEventListener('keydown', e => { if (e.key === 'Enter') reply(); });
})();
