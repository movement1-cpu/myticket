import { $, api, toast } from './core.js';

const q = new URLSearchParams(location.search);
$('#ref').textContent = q.get('group');
const finish = async approve => {
  try {
    await api('/payments/sandbox-card', { method: 'POST', body: { provider_ref: q.get('ref'), approve } });
    location.href = `/#/pay/${q.get('group')}`;
  } catch (e) { toast(e.message, true); }
};
$('#pay').addEventListener('click', () => finish(!$('#pan').value.replace(/\s/g, '').endsWith('0002')));
$('#cancel').addEventListener('click', () => finish(false));
