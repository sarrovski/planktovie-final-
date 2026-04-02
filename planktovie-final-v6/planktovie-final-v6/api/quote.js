// api/quote.js — Vercel Serverless Function
// Sends quote request emails via Resend

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { name, email, phone, organization, role, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    const QUOTE_EMAIL = process.env.QUOTE_EMAIL || 'info@planktovie.biz';

    if (!RESEND_KEY) {
      console.error('RESEND_API_KEY not set');
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    const date = new Date().toISOString().replace('T', ' ').split('.')[0];

    const htmlBody = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#2d3748">
        <div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0">
          <h2 style="margin:0;color:#fff;font-size:18px">New Quote Request — Planktovie</h2>
        </div>
        <div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:140px">Name</td><td style="padding:8px 12px;color:#2d3748">${name}</td></tr>
            <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Email</td><td style="padding:8px 12px"><a href="mailto:${email}" style="color:#007a6e">${email}</a></td></tr>
            ${phone ? `<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Phone</td><td style="padding:8px 12px;color:#2d3748">${phone}</td></tr>` : ''}
            ${organization ? `<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Organization</td><td style="padding:8px 12px;color:#2d3748">${organization}</td></tr>` : ''}
            <tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Role</td><td style="padding:8px 12px;color:#2d3748">${role || 'Not specified'}</td></tr>
            <tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Message</td><td style="padding:8px 12px;color:#2d3748;line-height:1.6">${message.replace(/\n/g, '<br>')}</td></tr>
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
        from: 'Planktovie Website <onboarding@resend.dev>',
        to: [QUOTE_EMAIL],
        reply_to: email,
        subject: `Quote Request from ${name}${organization ? ' — ' + organization : ''}`,
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
