// api/stripe-webhook.js — Vercel Serverless Function
// Handles Stripe webhook: generates PDF invoice and sends confirmation emails

const Stripe = require('stripe');
const { generateInvoice } = require('./lib/generate-invoice');

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
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderNum  = 'ORD-PK-' + session.id.slice(-8).toUpperCase();
    const customer  = (session.customer_details && session.customer_details.name) || (session.metadata && session.metadata.billing_name) || 'Customer';
    const email     = (session.customer_details && session.customer_details.email) || '';
    const amount    = ((session.amount_total || 0) / 100).toFixed(2);
    const currency  = (session.currency || 'eur').toUpperCase();
    const org       = (session.metadata && session.metadata.billing_org) || '';
    const date      = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    // Get line items from Stripe
    var lineItems = [], subtotal = 0, shippingCost = 0, coolBoxCost = 0, taxAmount = 0;
    try {
      var sessionFull = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
      var stripeItems = (sessionFull.line_items && sessionFull.line_items.data) || [];
      for (var li of stripeItems) {
        var name = li.description || 'Product';
        var qty = li.quantity || 1;
        var unitPrice = ((li.price && li.price.unit_amount) || 0) / 100;
        var total = (li.amount_total || 0) / 100;
        if (name.toLowerCase().includes('shipping')) { shippingCost = total; }
        else if (name.toLowerCase().includes('cool box')) { coolBoxCost = total; }
        else { lineItems.push({ name: name, qty: qty, unitPrice: unitPrice, total: total }); subtotal += total; }
      }
      taxAmount = ((sessionFull.total_details && sessionFull.total_details.amount_tax) || 0) / 100;
    } catch (err) {
      console.error('Failed to retrieve line items:', err.message);
      lineItems = [{ name: 'Order ' + orderNum, qty: 1, unitPrice: parseFloat(amount), total: parseFloat(amount) }];
      subtotal = parseFloat(amount);
    }

    var shippingAddr = (session.shipping_details && session.shipping_details.address) || (session.customer_details && session.customer_details.address) || {};
    console.log('Payment confirmed: ' + orderNum + ' - ' + customer + ' - ' + currency + ' ' + amount);

    // Generate PDF invoice
    var pdfBuffer = null;
    try {
      pdfBuffer = await generateInvoice({
        orderNum: orderNum, date: date, customer: customer, email: email, org: org,
        address: shippingAddr, items: lineItems, subtotal: subtotal,
        shipping: shippingCost, coolBox: coolBoxCost, taxAmount: taxAmount,
        total: parseFloat(amount), currency: currency,
      });
      console.log('Invoice PDF generated: ' + pdfBuffer.length + ' bytes');
    } catch (pdfErr) {
      console.error('PDF generation failed:', pdfErr.message);
    }

    // Send emails
    if (RESEND_KEY && email) {
      try {
        var confirmHtml = '<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#2d3748">'
          + '<div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0"><h2 style="margin:0;color:#fff;font-size:18px">Invoice — Planktovie</h2></div>'
          + '<div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">'
          + '<p style="margin-top:0">Dear ' + customer + ',</p>'
          + '<p>Thank you for your order. Your payment has been confirmed.</p>'
          + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">'
          + '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:140px">Invoice</td><td style="padding:8px 12px;font-weight:700">' + orderNum + '</td></tr>'
          + '<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Total</td><td style="padding:8px 12px;color:#007a6e;font-weight:700">' + currency + ' ' + amount + '</td></tr>'
          + '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Date</td><td style="padding:8px 12px">' + date + '</td></tr>'
          + (org ? '<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Organization</td><td style="padding:8px 12px">' + org + '</td></tr>' : '')
          + '</table>'
          + '<p><strong>Your invoice PDF is attached to this email.</strong></p>'
          + '<p>Our team will ship within 2-5 business days.</p>'
          + '<p>Questions? Contact <a href="mailto:info@planktovie.biz" style="color:#007a6e">info@planktovie.biz</a></p>'
          + '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8ecf0;font-size:12px;color:#8b95a3">Planktovie SAS · 45 rue Frédéric Joliot Curie, 13013 Marseille · planktovie.biz</div>'
          + '</div></div>';

        var emailPayload = {
          from: 'Planktovie <noreply@planktovie.biz>',
          to: [email],
          subject: 'Invoice ' + orderNum + ' — Planktovie',
          html: confirmHtml,
        };
        if (pdfBuffer) {
          emailPayload.attachments = [{ filename: 'Planktovie-Invoice-' + orderNum + '.pdf', content: pdfBuffer.toString('base64'), type: 'application/pdf' }];
        }
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload),
        });

        // Team notification
        var teamPayload = {
          from: 'Planktovie Website <noreply@planktovie.biz>',
          to: [ORDER_EMAIL],
          subject: 'New Order ' + orderNum + ' — ' + currency + ' ' + amount + ' — ' + customer,
          html: confirmHtml.replace('Dear ' + customer, '<strong>New order from ' + customer + (org ? ' (' + org + ')' : '') + ' — ' + email + '</strong>'),
        };
        if (pdfBuffer) {
          teamPayload.attachments = [{ filename: 'Planktovie-Invoice-' + orderNum + '.pdf', content: pdfBuffer.toString('base64'), type: 'application/pdf' }];
        }
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(teamPayload),
        });

        console.log('Emails sent with invoice PDF to ' + email + ' and ' + ORDER_EMAIL);
      } catch (emailErr) {
        console.error('Email error:', emailErr.message);
      }
    }
  }

  if (event.type === 'checkout.session.expired') { console.log('Session expired: ' + event.data.object.id); }
  if (event.type === 'payment_intent.payment_failed') { console.log('Payment failed: ' + event.data.object.id); }

  return res.status(200).json({ received: true });
};
