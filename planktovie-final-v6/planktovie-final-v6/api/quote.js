// api/quote.js — Vercel Serverless Function
// Sends quote request emails via Resend
// Fixed: HTML escaping, rate limiting, CORS restriction

// Simple in-memory rate limiter (resets on cold start, good enough for serverless)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // max 5 requests per IP per minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// HTML escape to prevent injection in email templates
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
  // CORS — restrict to your domains
  const allowedOrigins = ['https://planktovie.biz', 'https://www.planktovie.biz', 'https://planktovie-final.vercel.app'];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
  }

  try {
    const { name, email, phone, organization, role, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // Basic anti-spam: reject if message contains too many URLs
    const urlCount = (message.match(/https?:\/\//gi) || []).length;
    if (urlCount > 3) {
      return res.status(400).json({ error: 'Message contains too many links.' });
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    const QUOTE_EMAIL = process.env.QUOTE_EMAIL || 'info@planktovie.biz';

    if (!RESEND_KEY) {
      console.error('RESEND_API_KEY not set');
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    const date = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Escape all user-provided fields before injecting into HTML
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone);
    const safeOrg = escapeHtml(organization);
    const safeRole = escapeHtml(role);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

    const htmlBody = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#2d3748">
        <div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0">
          <h2 style="margin:0;color:#fff;font-size:18px">New Quote Request — Planktovie</h2>
        </div>
        <div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:140px">Name</td><td style="padding:8px 12px;color:#2d3748">${safeName}</td></tr>
            <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Email</td><td style="padding:8px 12px"><a href="mailto:${safeEmail}" style="color:#007a6e">${safeEmail}</a></td></tr>
            ${safePhone ? `<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Phone</td><td style="padding:8px 12px;color:#2d3748">${safePhone}</td></tr>` : ''}
            ${safeOrg ? `<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Organization</td><td style="padding:8px 12px;color:#2d3748">${safeOrg}</td></tr>` : ''}
            <tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Role</td><td style="padding:8px 12px;color:#2d3748">${safeRole || 'Not specified'}</td></tr>
            <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Message</td><td style="padding:8px 12px;color:#2d3748;line-height:1.6">${safeMessage}</td></tr>
          </table>
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e8ecf0;font-size:12px;color:#8b95a3">
            Submitted via planktovie.biz · ${date}
          </div>
        </div>
      </div>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Planktovie Website <noreply@planktovie.biz>',
        to: [QUOTE_EMAIL],
        reply_to: email,
        subject: `Quote Request from ${safeName}${safeOrg ? ' — ' + safeOrg : ''}`,
        html: htmlBody,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(500).json({ error: 'Failed to send email. Please try again later.' });
    }

    return res.status(200).json({ success: true, message: 'Quote request sent.' });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};
