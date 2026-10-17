'use strict';

// Razorpay payments (Standard Checkout) for the Event Pass.
//
// Flow: the server creates an Order (amount is always set here, never by the
// browser) -> the browser opens Razorpay Checkout -> on success the browser
// sends back the payment id + signature, which the server verifies with the
// key secret and double-checks against Razorpay's API before activating the
// Pass. A webhook does the same for payments whose tab was closed early.
//
// Configured with environment variables (see README). Without keys, billing
// is off and nothing is limited.

const crypto = require('node:crypto');

const API = 'https://api.razorpay.com/v1';

function intEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read at call time so settings changed in Vercel apply without code changes.
function billingConfig(env = process.env) {
  const keyId = (env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET || '').trim();
  return {
    enabled: Boolean(keyId && keySecret),
    keyId,
    keySecret,
    webhookSecret: (env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
    price: intEnv(env.PASS_PRICE_PAISE, 49900), // paise: 49900 = ₹499
    currency: 'INR',
    freeLimit: intEnv(env.FREE_ENTRY_LIMIT, 16),
    business: {
      name: env.BUSINESS_NAME || 'Tonament',
      address: env.BUSINESS_ADDRESS || '',
      email: env.BUSINESS_EMAIL || '',
      phone: env.BUSINESS_PHONE || '',
      gstin: env.BUSINESS_GSTIN || '',
    },
  };
}

// What the browser may see: never the secrets.
function publicBillingConfig(cfg = billingConfig()) {
  return {
    enabled: cfg.enabled,
    keyId: cfg.enabled ? cfg.keyId : null,
    price: cfg.price,
    currency: cfg.currency,
    freeLimit: cfg.freeLimit,
    business: cfg.business,
  };
}

function createRazorpay({ keyId, keySecret, fetchImpl = globalThis.fetch }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  async function call(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data && data.error && data.error.description ? data.error.description : 'request failed';
      throw new Error(`Razorpay ${res.status}: ${reason}`);
    }
    return data;
  }
  return {
    createOrder: (order) => call('POST', '/orders', order),
    fetchPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
    capture: (id, amount, currency) => call('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount, currency }),
  };
}

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Checkout success handler signature: HMAC_SHA256(order_id|payment_id, key_secret)
function verifyPaymentSignature({ orderId, paymentId, signature }, keySecret) {
  return safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

// Webhook signature: HMAC_SHA256(raw request body, webhook secret)
function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  return safeEqual(hmacHex(webhookSecret, rawBody), signature);
}

module.exports = {
  billingConfig,
  publicBillingConfig,
  createRazorpay,
  hmacHex,
  verifyPaymentSignature,
  verifyWebhookSignature,
};
