// api/create-checkout.js — Vercel Serverless Function
// Creates a Stripe Checkout Session with SERVER-SIDE price validation

const Stripe = require('stripe');

// Sanity config
const SANITY_ID = 'xysumkw1';
const SANITY_DS = 'production';

// Fetch product prices from Sanity to prevent client-side price manipulation
async function fetchSanityPrices() {
  const groq = `*[_type == "product"] { "id": coalesce(sortOrder, 999), name, price, variants }`;
  const url = `https://${SANITY_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DS}?query=${encodeURIComponent(groq)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch product prices from Sanity');
  const data = await res.json();
  return data.result || [];
}

module.exports = async function handler(req, res) {
  // CORS — restrict to your domain
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
    return res.status(500).json({ error: 'Stripe not configured on server.' });
  }

  try {
    const { cart, shipping, billing } = req.body || {};

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // ── SERVER-SIDE PRICE VALIDATION ──
    let sanityProducts;
    try {
      sanityProducts = await fetchSanityPrices();
    } catch (err) {
      console.error('Sanity fetch failed:', err.message);
      return res.status(500).json({ error: 'Could not verify product prices. Please try again.' });
    }

    const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });

    const lineItems = [];

    for (const item of cart) {
      if (!item.id || !item.qty || item.qty < 1) {
        return res.status(400).json({ error: `Invalid cart item: ${item.name || 'unknown'}` });
      }

      const sanityProduct = sanityProducts.find(p => p.id === item.id);
      if (!sanityProduct) {
        return res.status(400).json({ error: `Product not found: ${item.name || item.id}` });
      }

      // Determine validated price
      let validatedPrice = sanityProduct.price;

      if (sanityProduct.variants && sanityProduct.variants.length > 0) {
        // Check if client price matches any variant
        const matchingVariant = sanityProduct.variants.find(
          v => Math.round(v.price * 100) === Math.round(item.price * 100)
        );
        if (matchingVariant) {
          validatedPrice = matchingVariant.price;
        } else {
          console.warn(`Variant price mismatch for ${sanityProduct.name}: client=${item.price}`);
          validatedPrice = sanityProduct.variants[0].price;
        }
      } else {
        if (Math.round(item.price * 100) !== Math.round(sanityProduct.price * 100)) {
          console.warn(`Price mismatch for ${sanityProduct.name}: client=€${item.price}, server=€${sanityProduct.price}`);
        }
        validatedPrice = sanityProduct.price;
      }

      if (typeof validatedPrice !== 'number' || validatedPrice <= 0) {
        return res.status(400).json({ error: `${sanityProduct.name} requires a quote. Please use the quote form.` });
      }

      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name || sanityProduct.name,
            metadata: { sku: `PKV-${String(item.id).padStart(4, '0')}` },
          },
          unit_amount: Math.round(validatedPrice * 100),
        },
        quantity: Math.min(Math.max(Math.round(item.qty), 1), 100),
      });
    }

    // Recalculate shipping server-side
    if (shipping && shipping.cost > 0) {
      const subtotal = lineItems.reduce((s, li) => s + (li.price_data.unit_amount * li.quantity), 0) / 100;
      const zone = shipping.zone === 'france' ? 'france' : 'other';
      const serverShipCost = zone === 'france' ? (30 + subtotal * 0.08) : (60 + subtotal * 0.10);

      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: `Shipping (${zone === 'france' ? 'France' : 'Europe / International'})` },
          unit_amount: Math.round(serverShipCost * 100),
        },
        quantity: 1,
      });
    }

    const sessionOrigin = req.headers.origin || 'https://planktovie.biz';

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
      success_url: `${sessionOrigin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${sessionOrigin}/?checkout=cancelled`,
      locale: 'auto',
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session.' });
  }
};
