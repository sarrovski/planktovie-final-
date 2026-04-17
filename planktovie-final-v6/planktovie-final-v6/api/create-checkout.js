// api/create-checkout.js — Vercel Serverless Function
// Prices are HT (excl. VAT) — Stripe Tax handles VAT based on customer location
// Cool Box: €20 per 1-5 units of Preserved / Live Feed

const Stripe = require('stripe');

const SANITY_ID = 'xysumkw1';
const SANITY_DS = 'production';

async function fetchSanityPrices() {
  const groq = `*[_type == "product"] { "id": _id, name, price, category, variants }`;
  const url = `https://${SANITY_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DS}?query=${encodeURIComponent(groq)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch product prices from Sanity');
  const data = await res.json();
  return data.result || [];
}

// Sanity prices are TTC — convert to HT
function toHT(priceTTC) {
  return Math.round((priceTTC / 1.20) * 100) / 100;
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
    return res.status(500).json({ error: 'Stripe not configured on server.' });
  }

  try {
    const { cart, shipping, coolBox, billing } = req.body || {};

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    let sanityProducts;
    try {
      sanityProducts = await fetchSanityPrices();
    } catch (err) {
      console.error('Sanity fetch failed:', err.message);
      return res.status(500).json({ error: 'Could not verify product prices. Please try again.' });
    }

    const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });
    const lineItems = [];
    let liveFeedQty = 0;

    for (const item of cart) {
      if (!item.id || !item.qty || item.qty < 1) {
        return res.status(400).json({ error: `Invalid cart item: ${item.name || 'unknown'}` });
      }

      const sanityProduct = sanityProducts.find(p => p.id === item.id);
      if (!sanityProduct) {
        return res.status(400).json({ error: `Product not found: ${item.name || item.id}` });
      }

      let validatedPriceHT;

      if (sanityProduct.variants && sanityProduct.variants.length > 0) {
        const matchingVariant = sanityProduct.variants.find(
          v => Math.round(toHT(v.price) * 100) === Math.round(item.price * 100)
        );
        validatedPriceHT = matchingVariant ? toHT(matchingVariant.price) : toHT(sanityProduct.variants[0].price);
      } else {
        validatedPriceHT = toHT(sanityProduct.price);
      }

      if (typeof validatedPriceHT !== 'number' || validatedPriceHT <= 0) {
        return res.status(400).json({ error: `${sanityProduct.name} requires a quote.` });
      }

      const cat = sanityProduct.category || item.cat || '';
      if (cat === 'Preserved / Live Feed') {
        liveFeedQty += Math.round(item.qty);
      }

      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name || sanityProduct.name,
            metadata: { sku: item.id },
          },
          unit_amount: Math.round(validatedPriceHT * 100),
        },
        quantity: Math.min(Math.max(Math.round(item.qty), 1), 100),
      });
    }

    // Shipping — recalculated server-side
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

    // Cool Box — €20 per 1-5 units of live feed (recalculated server-side)
    if (liveFeedQty > 0) {
      const coolBoxCount = Math.ceil(liveFeedQty / 5);
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: `Cool Box — Temperature-controlled packaging` },
          unit_amount: 2000,
        },
        quantity: coolBoxCount,
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
      automatic_tax: { enabled: true },
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
