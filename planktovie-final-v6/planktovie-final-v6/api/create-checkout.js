// api/create-checkout.js — Vercel Serverless Function
// Creates a Stripe Checkout Session and returns the redirect URL

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET) {
    return res.status(500).json({ error: 'Stripe not configured on server.' });
  }

  try {
    const { cart, shipping, billing, vatRate = 0.20 } = req.body || {};

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });

    // Build Stripe line items from cart
    const lineItems = cart.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.name,
          metadata: { sku: `PKV-${String(item.id).padStart(4, '0')}` },
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    // Add shipping as a line item if applicable
    if (shipping && shipping.cost > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: `Shipping (${shipping.zone === 'france' ? 'France' : 'Europe / International'})` },
          unit_amount: Math.round(shipping.cost * 100),
        },
        quantity: 1,
      });
    }

    const origin = req.headers.origin || 'https://planktovie.biz';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: [
          'FR','DE','BE','NL','ES','IT','PT','AT','CH','LU','DK','SE','FI','NO','IE',
          'PL','CZ','HU','RO','GR','HR','US','CA','AU','JP','SG','GB',
        ],
      },
      automatic_tax: { enabled: false },
      customer_email: billing?.email || undefined,
      metadata: {
        source: 'planktovie-website',
        billing_name: billing ? `${billing.first} ${billing.last}` : '',
        billing_org: billing?.org || '',
      },
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      locale: 'auto',
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session.' });
  }
};
