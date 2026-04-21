// api/subscription-webhook.js — Vercel Serverless Function
// Handles Stripe subscription events: invoice.paid, subscription updates/cancellations
// Sends notification emails via Resend

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.SALES_EMAIL || 'sales@planktovie.biz';

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured' });

  const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });

  let event;

  // Verify webhook signature if secret is configured
  if (WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      // Vercel provides raw body as buffer
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'Webhook signature failed' });
    }
  } else {
    // No webhook secret configured — accept but log warning
    event = req.body;
    console.warn('No STRIPE_SUBSCRIPTION_WEBHOOK_SECRET set — skipping signature verification');
  }

  try {
    switch (event.type) {
      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerEmail = invoice.customer_email;
        const amount = (invoice.amount_paid / 100).toFixed(2);
        const subId = invoice.subscription;

        // Get subscription details
        let subMeta = {};
        if (subId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subId);
            subMeta = sub.metadata || {};
          } catch (e) {
            console.warn('Could not fetch subscription:', e.message);
          }
        }

        const productName = subMeta.product_name || 'Planktovie Subscription';
        const frequency = subMeta.frequency || 'recurring';

        // Send confirmation email to customer
        if (RESEND_KEY && customerEmail) {
          await sendEmail(RESEND_KEY, {
            to: customerEmail,
            subject: `Planktovie — Subscription payment confirmed (€${amount})`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <h2 style="color:#0f2b4c">Payment Confirmed</h2>
                <p>Thank you! Your subscription payment has been processed.</p>
                <table style="width:100%;border-collapse:collapse;margin:20px 0">
                  <tr><td style="padding:8px;border-bottom:1px solid #e8ecf0;color:#6b7685">Product</td><td style="padding:8px;border-bottom:1px solid #e8ecf0;font-weight:600">${escapeHtml(productName)}</td></tr>
                  <tr><td style="padding:8px;border-bottom:1px solid #e8ecf0;color:#6b7685">Frequency</td><td style="padding:8px;border-bottom:1px solid #e8ecf0">${frequency === 'monthly' ? 'Monthly' : 'Every 2 months'}</td></tr>
                  <tr><td style="padding:8px;border-bottom:1px solid #e8ecf0;color:#6b7685">Amount</td><td style="padding:8px;border-bottom:1px solid #e8ecf0;font-weight:600">€${amount}</td></tr>
                </table>
                <p style="color:#6b7685;font-size:14px">Your order will be prepared and shipped shortly. You will receive tracking information by email.</p>
                <p style="color:#6b7685;font-size:14px">To manage or cancel your subscription, reply to this email.</p>
                <hr style="border:none;border-top:1px solid #e8ecf0;margin:20px 0">
                <p style="color:#8b95a3;font-size:12px">Planktovie SAS — Marseille, France — planktovie.biz</p>
              </div>
            `,
          });
        }

        // Notify Planktovie team
        if (RESEND_KEY) {
          await sendEmail(RESEND_KEY, {
            to: NOTIFY_EMAIL,
            subject: `New subscription payment — ${escapeHtml(productName)} (€${amount})`,
            html: `
              <div style="font-family:Arial,sans-serif;padding:20px">
                <h2 style="color:#007a6e">Subscription Payment Received</h2>
                <p><strong>Customer:</strong> ${escapeHtml(customerEmail || 'Unknown')}</p>
                <p><strong>Product:</strong> ${escapeHtml(productName)}</p>
                <p><strong>Frequency:</strong> ${frequency}</p>
                <p><strong>Amount:</strong> €${amount}</p>
                <p><strong>Invoice:</strong> ${invoice.id}</p>
                <p><strong>Subscription:</strong> ${subId || 'N/A'}</p>
                <hr>
                <p style="color:#d97706;font-weight:600">Action required: Prepare and ship this order.</p>
              </div>
            `,
          });
        }

        console.log(`Invoice paid: ${invoice.id}, customer: ${customerEmail}, amount: €${amount}`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        console.log(`Subscription updated: ${sub.id}, status: ${sub.status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const productName = sub.metadata?.product_name || 'Subscription';

        // Notify team of cancellation
        if (RESEND_KEY) {
          await sendEmail(RESEND_KEY, {
            to: NOTIFY_EMAIL,
            subject: `Subscription cancelled — ${escapeHtml(productName)}`,
            html: `
              <div style="font-family:Arial,sans-serif;padding:20px">
                <h2 style="color:#dc2626">Subscription Cancelled</h2>
                <p><strong>Product:</strong> ${escapeHtml(productName)}</p>
                <p><strong>Subscription ID:</strong> ${sub.id}</p>
                <p><strong>Frequency:</strong> ${sub.metadata?.frequency || 'N/A'}</p>
                <p>The customer has cancelled their recurring order.</p>
              </div>
            `,
          });
        }

        console.log(`Subscription cancelled: ${sub.id}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Send email via Resend
async function sendEmail(apiKey, { to, subject, html }) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Planktovie <noreply@planktovie.biz>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend error:', errText);
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
