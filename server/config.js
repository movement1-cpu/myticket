import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && !env.APP_SECRET) {
  throw new Error('APP_SECRET must be set in production (used to sign login tokens and ticket QR codes).');
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  dbFile: env.DB_FILE || path.resolve('data/myticket.db'),
  uploadDir: env.UPLOAD_DIR || path.resolve('data/uploads'),
  secret: env.APP_SECRET || crypto.createHash('sha256').update('dev-only-secret').digest('hex'),
  currency: env.CURRENCY || 'ZMW',
  timezoneOffset: env.TZ_OFFSET || '+02:00', // Africa/Lusaka, no DST
  // Payment providers run in sandbox until their credentials are present.
  payments: {
    mtn: env.MTN_MOMO_SUBSCRIPTION_KEY ? {
      baseUrl: env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
      subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY, apiUser: env.MTN_MOMO_API_USER, apiKey: env.MTN_MOMO_API_KEY,
      targetEnv: env.MTN_MOMO_TARGET_ENV || 'sandbox',
    } : null,
    airtel: env.AIRTEL_CLIENT_ID ? {
      baseUrl: env.AIRTEL_BASE_URL || 'https://openapiuat.airtel.africa',
      clientId: env.AIRTEL_CLIENT_ID, clientSecret: env.AIRTEL_CLIENT_SECRET, country: 'ZM',
    } : null,
  },
  notify: {
    africastalking: env.AT_API_KEY ? { username: env.AT_USERNAME, apiKey: env.AT_API_KEY, from: env.AT_SENDER_ID } : null,
    whatsapp: env.WA_TOKEN ? { token: env.WA_TOKEN, phoneNumberId: env.WA_PHONE_NUMBER_ID } : null,
    emailWebhook: env.EMAIL_WEBHOOK_URL || null, // POST {to, subject, text} to your mail service
  },
};
