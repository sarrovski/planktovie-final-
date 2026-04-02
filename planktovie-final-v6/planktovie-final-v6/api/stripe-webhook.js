// api/stripe-webhook.js — Vercel Serverless Function
// Handles Stripe webhook events (payment confirmation, failures)

const Stripe = require('stripe');

// Vercel needs raw body for webhook signature verification
const config = { api: { bodyParser: false } };
module.exports.config = config;

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');

  const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const RESEND_KEY     = process.env.RESEND_API_KEY;
  const ORDER_EMAIL    = process.env.QUOTE_EMAIL || 'info@planktovie.biz';

  if (!STRIPE_SECRET || !WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Stripe not configured.' });
  }

  const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const orderNum  = `ORD-PK-${session.id.slice(-8).toUpperCase()}`;
    const customer  = session.customer_details?.name || session.metadata?.billing_name || 'Customer';
    const email     = session.customer_details?.email || '';
    const amount    = ((session.amount_total || 0) / 100).toFixed(2);
    const currency  = (session.currency || 'eur').toUpperCase();
    const org       = session.metadata?.billing_org || '';
    const date      = new Date().toISOString().replace('T', ' ').split('.')[0];

    console.log(`Payment confirmed: ${orderNum} - ${customer} - ${currency} ${amount}`);

    if (RESEND_KEY && email) {
      try {
        const confirmHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#2d3748">
            <div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0">
              <h2 style="margin:0;color:#fff;font-size:18px">Order Confirmed — Planktovie</h2>
            </div>
            <div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">
              <p style="margin-top:0">Dear ${customer},</p>
              <p>Thank you for your order. Your payment has been confirmed and your order is being prepared.</p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
                <tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:160px">Order Number</td><td style="padding:8px 12px;color:#2d3748;font-weight:700">${orderNum}</td></tr>
                <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Total Paid</td><td style="padding:8px 12px;color:#007a6e;font-weight:700">${currency} ${amount}</td></tr>
                ${org ? `<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Organization</td><td style="padding:8px 12px;color:#2d3748">${org}</td></tr>` : ''}
                <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Date</td><td style="padding:8px 12px;color:#2d3748">${date}</td></tr>
              </table>
              <p>Our team will review your order and ship within 2-5 business days.</p>
              <p>Questions? Reply to this email or contact us at <a href="mailto:info@planktovie.biz" style="color:#007a6e">info@planktovie.biz</a>.</p>
              <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8ecf0;font-size:12px;color:#8b95a3">
                Planktovie — Aquatic Organism Solutions · Marseille, France · planktovie.biz
              </div>
            </div>
          </div>`;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Planktovie <onboarding@resend.dev>',
            to: [email],
            subject: `Order Confirmed — ${orderNum}`,
            html: confirmHtml,
          }),
        });

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Planktovie Website <onboarding@resend.dev>',
            to: [ORDER_EMAIL],
            subject: `New Order ${orderNum} — ${currency} ${amount}`,
            html: confirmHtml.replace('Dear ' + customer, `<strong>New order received from ${customer}${org ? ' (' + org + ')' : ''}</strong>`),
          }),
        });

      } catch (emailErr) {
        console.error('Email send error:', emailErr.message);
      }
    }
  }

  if (event.type === 'checkout.session.expired') {
    console.log(`Session expired: ${event.data.object.id}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    console.log(`Payment failed: ${event.data.object.id}`);
  }

  return res.status(200).json({ received: true });
};
