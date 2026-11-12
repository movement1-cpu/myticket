import crypto from 'node:crypto';
import { config } from '../../config.js';

/**
 * Each provider exposes:
 *   initiate({ amount, currency, msisdn, reference }) -> { providerRef, status: 'initiated'|'success'|'failed', redirectUrl?, reason? }
 *   check(providerRef) -> { status, reason? }
 * Never trust a callback body: always confirm with check().
 */

/* ---------- Sandbox (used whenever a provider has no credentials) ---------- */
const sandboxState = new Map(); // providerRef -> { status, at, msisdn, reason }
export const sandbox = name => ({
  name, sandbox: true,
  async initiate({ msisdn, cardOutcome }) {
    const providerRef = `SBX-${name}-${crypto.randomUUID().slice(0, 8)}`;
    // Test numbers: ending 0000 = insufficient funds, ending 1111 = customer declined the prompt.
    const reason = msisdn?.endsWith('0000') ? 'Insufficient balance' : msisdn?.endsWith('1111') ? 'Customer declined the payment prompt' : cardOutcome === 'decline' ? 'Card declined by issuer' : null;
    sandboxState.set(providerRef, { at: Date.now(), reason });
    return { providerRef, status: 'initiated', redirectUrl: name === 'card' ? `/pay-card.html?ref=${providerRef}` : undefined };
  },
  async check(providerRef) {
    const s = sandboxState.get(providerRef);
    if (!s) return { status: 'failed', reason: 'Unknown transaction' };
    if (s.forced) return s.forced;
    if (Date.now() - s.at < 3000) return { status: 'initiated' }; // the customer is entering their PIN
    return s.reason ? { status: 'failed', reason: s.reason } : { status: 'success' };
  },
  /** Sandbox card page outcome. */
  complete(providerRef, ok) { const s = sandboxState.get(providerRef); if (s) s.forced = ok ? { status: 'success' } : { status: 'failed', reason: 'Card declined by issuer' }; },
});

/* ---------- MTN MoMo Collection API (request-to-pay) ---------- */
function mtn(c) {
  let token = null, tokenExp = 0;
  const auth = async () => {
    if (token && Date.now() < tokenExp) return token;
    const res = await fetch(`${c.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.apiUser}:${c.apiKey}`).toString('base64'), 'Ocp-Apim-Subscription-Key': c.subscriptionKey },
    });
    if (!res.ok) throw new Error(`MTN token HTTP ${res.status}`);
    const j = await res.json();
    token = j.access_token; tokenExp = Date.now() + (j.expires_in - 60) * 1000;
    return token;
  };
  const headers = async () => ({ Authorization: `Bearer ${await auth()}`, 'X-Target-Environment': c.targetEnv, 'Ocp-Apim-Subscription-Key': c.subscriptionKey });
  return {
    name: 'mtn', sandbox: false,
    async initiate({ amount, currency, msisdn, reference }) {
      const providerRef = crypto.randomUUID();
      const res = await fetch(`${c.baseUrl}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: { ...(await headers()), 'X-Reference-Id': providerRef, 'Content-Type': 'application/json', 'X-Callback-Url': `${config.baseUrl}/api/payments/callback/mtn` },
        body: JSON.stringify({ amount: amount.toFixed(2), currency: c.targetEnv === 'sandbox' ? 'EUR' : currency, externalId: reference,
          payer: { partyIdType: 'MSISDN', partyId: msisdn }, payerMessage: `Bus ticket ${reference}`, payeeNote: reference }),
      });
      if (res.status !== 202) return { providerRef, status: 'failed', reason: `MTN rejected the request (HTTP ${res.status})` };
      return { providerRef, status: 'initiated' };
    },
    async check(providerRef) {
      const res = await fetch(`${c.baseUrl}/collection/v1_0/requesttopay/${providerRef}`, { headers: await headers() });
      if (!res.ok) return { status: 'initiated' };
      const j = await res.json();
      if (j.status === 'SUCCESSFUL') return { status: 'success' };
      if (j.status === 'FAILED' || j.status === 'REJECTED' || j.status === 'TIMEOUT') return { status: 'failed', reason: j.reason || j.status };
      return { status: 'initiated' };
    },
  };
}

/* ---------- Airtel Money Collections (USSD push) ---------- */
function airtel(c) {
  let token = null, tokenExp = 0;
  const auth = async () => {
    if (token && Date.now() < tokenExp) return token;
    const res = await fetch(`${c.baseUrl}/auth/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`Airtel token HTTP ${res.status}`);
    const j = await res.json();
    token = j.access_token; tokenExp = Date.now() + (Number(j.expires_in) - 60) * 1000;
    return token;
  };
  const headers = async () => ({ Authorization: `Bearer ${await auth()}`, 'X-Country': c.country, 'X-Currency': 'ZMW', 'Content-Type': 'application/json' });
  return {
    name: 'airtel', sandbox: false,
    async initiate({ amount, msisdn, reference }) {
      const providerRef = reference + '-' + crypto.randomBytes(3).toString('hex');
      const res = await fetch(`${c.baseUrl}/merchant/v1/payments/`, {
        method: 'POST', headers: await headers(),
        body: JSON.stringify({ reference, subscriber: { country: 'ZM', currency: 'ZMW', msisdn: msisdn.slice(3) }, transaction: { amount, country: 'ZM', currency: 'ZMW', id: providerRef } }),
      });
      if (!res.ok) return { providerRef, status: 'failed', reason: `Airtel rejected the request (HTTP ${res.status})` };
      return { providerRef, status: 'initiated' };
    },
    async check(providerRef) {
      const res = await fetch(`${c.baseUrl}/standard/v1/payments/${providerRef}`, { headers: await headers() });
      if (!res.ok) return { status: 'initiated' };
      const j = await res.json();
      const s = j?.data?.transaction?.status;
      if (s === 'TS') return { status: 'success' };
      if (s === 'TF' || s === 'TE') return { status: 'failed', reason: j?.data?.transaction?.message || 'Transaction failed' };
      return { status: 'initiated' };
    },
  };
}

/**
 * Zamtel Kwacha and Visa/Mastercard are normally reached through a licensed aggregator
 * (e.g. a hosted-checkout gateway) so card numbers never touch this server. They run in sandbox
 * until an aggregator adapter with the same initiate/check interface is added here.
 */
export const providers = {
  mtn: config.payments.mtn ? mtn(config.payments.mtn) : sandbox('mtn'),
  airtel: config.payments.airtel ? airtel(config.payments.airtel) : sandbox('airtel'),
  zamtel: sandbox('zamtel'),
  card: sandbox('card'),
};
