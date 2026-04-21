// api/create-subscription.js — Vercel Serverless Function
// Creates a Stripe Checkout Session in subscription mode

const Stripe = require('stripe');

const SANITY_ID = 'xysumkw1';
const SANITY_DS = 'production';

async function fetchSanityProduct(productId) {
  const groq = `*[_type == "product" && _id == "${productId}"][0] { "id": _id, name, price, category, variants }`;
  const url = `https://${SANITY_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DS}?query=${encodeURIComponent(groq)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch product from Sanity');
  const data = await res.json();
  return data.result || null;
}

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://planktovie.biz', 'https://www.planktovie.biz', 'https://planktovie-final.vercel.app'];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET) {
    return res.status(500).json({ error: 'Stripe not configured.' });
  }

  try {
    const { productId, productName, price, originalPrice, qty, frequency, discount, cat, variantLabel } = req.body || {};

    if (!productId || !productName || !price || !qty || !frequency) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Validate product exists in Sanity
    const sanityProduct = await fetchSanityProduct(productId);
    if (!sanityProduct) {
      return res.status(400).json({ error: 'Product not found.' });
    }

    // Validate price server-side
    let validatedPrice = sanityProduct.price;
    if (sanityProduct.variants && sanityProduct.variants.length > 0 && variantLabel) {
      const match = sanityProduct.variants.find(v => v.label === variantLabel);
      if (match) validatedPrice = match.price;
    }

    // Apply discount server-side (don't trust client discount)
    const allowedDiscounts = { 'bimonthly': 0.10, 'monthly': 0.15 };
    const serverDiscount = allowedDiscounts[frequency] || 0;
    const discountedPrice = Math.round(validatedPrice * (1 - serverDiscount) * 100) / 100;

    // Determine billing interval
    const intervalMap = {
      'monthly': { interval: 'month', interval_count: 1 },
      'bimonthly': { interval: 'month', interval_count: 2 },
    };
    const billing = intervalMap[frequency] || intervalMap['bimonthly'];

    const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });

    // Create a Stripe Product (or reuse if it exists)
    const stripeProductName = `${productName} — Subscription (${frequency})`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: stripeProductName,
            metadata: {
              planktovie_product_id: productId,
              variant: variantLabel || '',
              frequency: frequency,
              discount_pct: String(Math.round(serverDiscount * 100)),
              original_price: String(validatedPrice),
            },
          },
          unit_amount: Math.round(discountedPrice * 100),
          recurring: {
            interval: billing.interval,
            interval_count: billing.interval_count,
          },
        },
        quantity: Math.min(Math.max(Math.round(qty), 1), 100),
      }],
      mode: 'subscription',
      billing_address_collection: 'required',
      automatic_tax: { enabled: false },
      subscription_data: {
        metadata: {
          source: 'planktovie-website',
          product_id: productId,
          product_name: productName,
          frequency: frequency,
          discount: String(Math.round(serverDiscount * 100)) + '%',
        },
      },
      success_url: `${req.headers.origin || 'https://planktovie.biz'}/?subscription=success`,
      cancel_url: `${req.headers.origin || 'https://planktovie.biz'}/?subscription=cancelled`,
      locale: 'auto',
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Subscription error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create subscription.' });
  }
};
