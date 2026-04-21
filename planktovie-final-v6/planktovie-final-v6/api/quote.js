// api/quote.js — AI-Powered Quote Generator
// Analyzes the client's message with Claude, identifies products,
// calculates prices with institutional discounts, generates PDF quote

const PDFDocument = require('pdfkit');

const SANITY_ID = 'xysumkw1';
const SANITY_DS = 'production';

// Rate limiter
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > 60000) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > 5;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function fetchProducts() {
  var groq = '*[_type=="product"]{ name, price, category, variants, sku }';
  var url = 'https://' + SANITY_ID + '.api.sanity.io/v2024-01-01/data/query/' + SANITY_DS + '?query=' + encodeURIComponent(groq);
  var r = await fetch(url);
  var d = await r.json();
  return d.result || [];
}

async function analyzeWithClaude(message, productList) {
  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!ANTHROPIC_KEY) return null;

  var productInfo = productList.map(function(p) {
    var variants = '';
    if (p.variants && p.variants.length) {
      variants = ' — variants: ' + p.variants.map(function(v) { return v.label + ' €' + v.price; }).join(', ');
    }
    return p.name + ' (€' + (p.price || 0).toFixed(2) + ', ' + (p.category || '') + ')' + variants;
  }).join('\n');

  var prompt = 'You are a sales assistant for Planktovie, a French company selling zebrafish nutrition and aquatic lab equipment.\n\n'
    + 'PRODUCT CATALOG:\n' + productInfo + '\n\n'
    + 'INSTITUTIONAL DISCOUNT RULES:\n'
    + '- Orders over €1500: 50% off shipping\n'
    + '- Orders over €3000: free shipping\n'
    + '- Institutional clients (universities, CNRS, INSERM, etc.): 5-10% discount on products\n'
    + '- Bulk orders (10+ of same item): additional 5% discount on that item\n\n'
    + 'CLIENT MESSAGE:\n' + message + '\n\n'
    + 'Analyze this quote request. Respond ONLY with a JSON object (no markdown, no backticks):\n'
    + '{\n'
    + '  "items": [{"name": "product name", "variant": "variant if any or null", "qty": 1, "unitPrice": 0.00, "discount": 0, "discountReason": "reason or null"}],\n'
    + '  "notes": "any notes about the request, things you could not identify, or recommendations",\n'
    + '  "isInstitutional": true/false,\n'
    + '  "shippingEstimate": "France" or "EU" or "International",\n'
    + '  "confidence": "high" or "medium" or "low"\n'
    + '}\n'
    + 'If you cannot identify specific products, set items to an empty array and explain in notes.\n'
    + 'Match products by name even if the client uses abbreviations or partial names.\n'
    + 'All prices in EUR HT.';

  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    var data = await r.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Claude API error:', err.message);
    return null;
  }
}

function generateQuotePDF(quoteData) {
  return new Promise(function(resolve, reject) {
    try {
      var doc = new PDFDocument({ size: 'A4', margin: 50 });
      var chunks = [];
      doc.on('data', function(c) { chunks.push(c); });
      doc.on('end', function() { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      var W = doc.page.width - 100;
      var q = quoteData;

      // Header
      doc.fontSize(20).fillColor('#0f2b4c').font('Helvetica-Bold').text('PLANKTOVIE', 50, 50);
      doc.fontSize(8).fillColor('#8b95a3').font('Helvetica')
        .text('45 rue Frederic Joliot Curie', 50, 75)
        .text('13013 Marseille, France', 50, 86)
        .text('info@planktovie.biz | planktovie.biz', 50, 97);

      doc.fontSize(22).fillColor('#007a6e').font('Helvetica-Bold')
        .text('QUOTE', 350, 50, { align: 'right', width: W - 300 });
      doc.fontSize(9).fillColor('#2d3748').font('Helvetica')
        .text('Ref: ' + q.quoteNum, 350, 78, { align: 'right', width: W - 300 })
        .text('Date: ' + q.date, 350, 91, { align: 'right', width: W - 300 })
        .text('Valid for 30 days', 350, 104, { align: 'right', width: W - 300 });

      doc.moveTo(50, 125).lineTo(50 + W, 125).strokeColor('#e8ecf0').lineWidth(1).stroke();

      // Client info
      doc.fontSize(8).fillColor('#8b95a3').font('Helvetica-Bold').text('PREPARED FOR', 50, 140);
      doc.fontSize(10).fillColor('#2d3748').font('Helvetica-Bold').text(q.clientName, 50, 153);
      doc.fontSize(9).fillColor('#4a5568').font('Helvetica');
      var y = 167;
      if (q.org) { doc.text(q.org, 50, y); y += 13; }
      if (q.email) { doc.text(q.email, 50, y); y += 13; }

      // Items table
      var tableTop = Math.max(y + 20, 220);
      doc.rect(50, tableTop, W, 22).fill('#0f2b4c');
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold');
      doc.text('Product', 58, tableTop + 6, { width: W * 0.4 });
      doc.text('Qty', 58 + W * 0.4, tableTop + 6, { width: W * 0.08, align: 'center' });
      doc.text('Unit Price', 58 + W * 0.48, tableTop + 6, { width: W * 0.15, align: 'right' });
      doc.text('Discount', 58 + W * 0.63, tableTop + 6, { width: W * 0.12, align: 'center' });
      doc.text('Total', 58 + W * 0.78, tableTop + 6, { width: W * 0.2, align: 'right' });

      var rowY = tableTop + 22;
      var subtotal = 0;
      doc.font('Helvetica').fillColor('#2d3748').fontSize(8.5);

      (q.items || []).forEach(function(item, i) {
        var bg = i % 2 === 0 ? '#ffffff' : '#f8fafb';
        doc.rect(50, rowY, W, 20).fill(bg);
        doc.fillColor('#2d3748');
        var displayName = item.name + (item.variant ? ' (' + item.variant + ')' : '');
        doc.text(displayName, 58, rowY + 5, { width: W * 0.4 });
        doc.text(String(item.qty), 58 + W * 0.4, rowY + 5, { width: W * 0.08, align: 'center' });
        doc.text('EUR ' + item.unitPrice.toFixed(2), 58 + W * 0.48, rowY + 5, { width: W * 0.15, align: 'right' });
        var discountText = item.discount > 0 ? '-' + item.discount + '%' : '—';
        doc.text(discountText, 58 + W * 0.63, rowY + 5, { width: W * 0.12, align: 'center' });
        var lineTotal = item.unitPrice * item.qty * (1 - (item.discount || 0) / 100);
        doc.text('EUR ' + lineTotal.toFixed(2), 58 + W * 0.78, rowY + 5, { width: W * 0.2, align: 'right' });
        subtotal += lineTotal;
        rowY += 20;
      });

      // Totals
      rowY += 15;
      var totX = 58 + W * 0.55;
      doc.fontSize(9).fillColor('#6b7685').font('Helvetica');
      doc.text('Subtotal (HT)', totX, rowY); doc.text('EUR ' + subtotal.toFixed(2), totX + W * 0.25, rowY, { width: W * 0.2, align: 'right' }); rowY += 16;

      var shipCost = 0;
      if (q.shippingEstimate === 'France') shipCost = Math.round(30 + subtotal * 0.08);
      else shipCost = Math.round(60 + subtotal * 0.10);
      if (subtotal >= 3000) { shipCost = 0; }
      else if (subtotal >= 1500) { shipCost = Math.round(shipCost * 0.5); }

      doc.text('Shipping (' + (q.shippingEstimate || 'TBD') + ')', totX, rowY);
      doc.text(shipCost > 0 ? 'EUR ' + shipCost.toFixed(2) : 'Free', totX + W * 0.25, rowY, { width: W * 0.2, align: 'right' }); rowY += 16;

      doc.text('VAT', totX, rowY); doc.text('As applicable', totX + W * 0.25, rowY, { width: W * 0.2, align: 'right' }); rowY += 16;

      doc.moveTo(totX, rowY).lineTo(totX + W * 0.45, rowY).strokeColor('#0f2b4c').lineWidth(1.5).stroke(); rowY += 8;
      doc.fontSize(13).fillColor('#0f2b4c').font('Helvetica-Bold');
      doc.text('TOTAL (HT)', totX, rowY);
      doc.text('EUR ' + (subtotal + shipCost).toFixed(2), totX + W * 0.25, rowY, { width: W * 0.2, align: 'right' });

      // Notes
      if (q.notes) {
        rowY += 40;
        doc.fontSize(8).fillColor('#8b95a3').font('Helvetica-Bold').text('NOTES', 50, rowY);
        doc.fontSize(8.5).fillColor('#4a5568').font('Helvetica').text(q.notes, 50, rowY + 14, { width: W });
      }

      // AI confidence notice
      rowY += 60;
      if (q.confidence && q.confidence !== 'high') {
        doc.fontSize(7.5).fillColor('#d97706').font('Helvetica')
          .text('This quote was auto-generated and may require adjustments. Our team will confirm within 1 business day.', 50, rowY, { width: W });
      }

      // Footer
      var footY = doc.page.height - 60;
      doc.moveTo(50, footY).lineTo(50 + W, footY).strokeColor('#e8ecf0').lineWidth(0.5).stroke();
      doc.fontSize(7).fillColor('#8b95a3').font('Helvetica')
        .text('Planktovie SAS | 45 rue Frederic Joliot Curie, 13013 Marseille, France | info@planktovie.biz', 50, footY + 8, { align: 'center', width: W })
        .text('This quote is valid for 30 days from the date of issue. All prices in EUR, excluding VAT.', 50, footY + 20, { align: 'center', width: W });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = async function handler(req, res) {
  var allowedOrigins = ['https://planktovie.biz', 'https://www.planktovie.biz', 'https://planktovie-final.vercel.app'];
  var origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(clientIp)) return res.status(429).json({ error: 'Too many requests.' });

  try {
    var body = req.body || {};
    var name = body.name, email = body.email, phone = body.phone;
    var organization = body.organization, role = body.role, message = body.message;

    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email.' });

    var RESEND_KEY = process.env.RESEND_API_KEY;
    var QUOTE_EMAIL = process.env.QUOTE_EMAIL || 'info@planktovie.biz';
    if (!RESEND_KEY) return res.status(500).json({ error: 'Server config error.' });

    var date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    var quoteNum = 'QT-PK-' + Date.now().toString(36).toUpperCase().slice(-6);

    // Fetch products and analyze with AI
    var products = [];
    var aiResult = null;
    var pdfBuffer = null;

    try {
      products = await fetchProducts();
      aiResult = await analyzeWithClaude(message, products);
    } catch (err) {
      console.error('AI analysis failed:', err.message);
    }

    // Generate PDF if AI identified products
    if (aiResult && aiResult.items && aiResult.items.length > 0) {
      try {
        pdfBuffer = await generateQuotePDF({
          quoteNum: quoteNum,
          date: date,
          clientName: name,
          org: organization,
          email: email,
          items: aiResult.items,
          notes: aiResult.notes || '',
          shippingEstimate: aiResult.shippingEstimate || 'France',
          confidence: aiResult.confidence || 'medium',
        });
        console.log('AI quote PDF generated: ' + pdfBuffer.length + ' bytes, ' + aiResult.items.length + ' items');
      } catch (pdfErr) {
        console.error('PDF generation failed:', pdfErr.message);
      }
    }

    var safeName = escapeHtml(name);
    var safeEmail = escapeHtml(email);
    var safeOrg = escapeHtml(organization);
    var safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

    // Build AI analysis summary for the team email
    var aiSummary = '';
    if (aiResult) {
      aiSummary = '<div style="margin-top:16px;padding:16px;background:#e6f3f1;border-radius:6px;border-left:4px solid #007a6e">'
        + '<div style="font-weight:600;color:#007a6e;margin-bottom:8px">AI Quote Analysis (confidence: ' + (aiResult.confidence || 'unknown') + ')</div>';
      if (aiResult.items && aiResult.items.length > 0) {
        aiSummary += '<table style="width:100%;font-size:13px;border-collapse:collapse">';
        var subT = 0;
        aiResult.items.forEach(function(item) {
          var lineTotal = item.unitPrice * item.qty * (1 - (item.discount || 0) / 100);
          subT += lineTotal;
          aiSummary += '<tr><td style="padding:4px 8px">' + escapeHtml(item.name) + (item.variant ? ' (' + item.variant + ')' : '') + '</td>'
            + '<td style="padding:4px 8px;text-align:center">x' + item.qty + '</td>'
            + '<td style="padding:4px 8px;text-align:right">EUR ' + lineTotal.toFixed(2) + '</td></tr>';
        });
        aiSummary += '<tr style="font-weight:600;border-top:1px solid #007a6e"><td style="padding:6px 8px" colspan="2">Subtotal</td>'
          + '<td style="padding:6px 8px;text-align:right">EUR ' + subT.toFixed(2) + '</td></tr></table>';
      }
      if (aiResult.notes) {
        aiSummary += '<div style="margin-top:8px;font-size:12px;color:#4a5568">Notes: ' + escapeHtml(aiResult.notes) + '</div>';
      }
      aiSummary += '<div style="margin-top:8px;font-size:11px;color:#8b95a3">Auto-generated quote PDF attached. Review and forward to client if correct.</div></div>';
    }

    var teamHtml = '<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#2d3748">'
      + '<div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0"><h2 style="margin:0;color:#fff;font-size:18px">New Quote Request — ' + quoteNum + '</h2></div>'
      + '<div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">'
      + '<table style="width:100%;border-collapse:collapse;font-size:14px">'
      + '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:120px">Name</td><td style="padding:8px 12px">' + safeName + '</td></tr>'
      + '<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Email</td><td style="padding:8px 12px"><a href="mailto:' + safeEmail + '" style="color:#007a6e">' + safeEmail + '</a></td></tr>'
      + (safeOrg ? '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Organization</td><td style="padding:8px 12px">' + safeOrg + '</td></tr>' : '')
      + '<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Message</td><td style="padding:8px 12px;line-height:1.6">' + safeMessage + '</td></tr>'
      + '</table>'
      + aiSummary
      + '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e8ecf0;font-size:12px;color:#8b95a3">Submitted via planktovie.biz</div>'
      + '</div></div>';

    // Send to team (with PDF if generated)
    var teamPayload = {
      from: 'Planktovie Website <noreply@planktovie.biz>',
      to: [QUOTE_EMAIL],
      reply_to: email,
      subject: 'Quote ' + quoteNum + ' from ' + safeName + (safeOrg ? ' — ' + safeOrg : '') + (pdfBuffer ? ' [AI Quote Attached]' : ''),
      html: teamHtml,
    };
    if (pdfBuffer) {
      teamPayload.attachments = [{ filename: 'Planktovie-Quote-' + quoteNum + '.pdf', content: pdfBuffer.toString('base64'), type: 'application/pdf' }];
    }
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(teamPayload),
    });

    // Send auto-quote to client (if AI generated it with high/medium confidence)
    if (pdfBuffer && aiResult && aiResult.confidence !== 'low') {
      var clientHtml = '<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#2d3748">'
        + '<div style="background:#0f2b4c;padding:20px 24px;border-radius:6px 6px 0 0"><h2 style="margin:0;color:#fff;font-size:18px">Your Quote — Planktovie</h2></div>'
        + '<div style="border:1px solid #e8ecf0;border-top:none;padding:24px;border-radius:0 0 6px 6px">'
        + '<p style="margin-top:0">Dear ' + safeName + ',</p>'
        + '<p>Thank you for your quote request. Please find attached a preliminary quote based on your requirements.</p>'
        + '<p>Our team will review and confirm this quote within 1 business day. If you have any questions, reply to this email.</p>'
        + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">'
        + '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600;width:140px">Quote Ref</td><td style="padding:8px 12px;font-weight:700">' + quoteNum + '</td></tr>'
        + '<tr style="background:#f4f6f8"><td style="padding:8px 12px;color:#6b7685;font-weight:600">Date</td><td style="padding:8px 12px">' + date + '</td></tr>'
        + '<tr><td style="padding:8px 12px;color:#6b7685;font-weight:600">Items</td><td style="padding:8px 12px">' + aiResult.items.length + ' product(s)</td></tr>'
        + '</table>'
        + '<p><strong>Your quote PDF is attached to this email.</strong></p>'
        + '<p style="font-size:13px;color:#8b95a3">This is a preliminary quote. Final pricing may vary based on availability and shipping requirements.</p>'
        + '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8ecf0;font-size:12px;color:#8b95a3">Planktovie SAS · Marseille, France · planktovie.biz</div>'
        + '</div></div>';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Planktovie <noreply@planktovie.biz>',
          to: [email],
          reply_to: QUOTE_EMAIL,
          subject: 'Your Quote ' + quoteNum + ' — Planktovie',
          html: clientHtml,
          attachments: [{ filename: 'Planktovie-Quote-' + quoteNum + '.pdf', content: pdfBuffer.toString('base64'), type: 'application/pdf' }],
        }),
      });
      console.log('AI quote sent to client: ' + email);
    }

    return res.status(200).json({ success: true, message: 'Quote request sent.' + (pdfBuffer ? ' A preliminary quote has been emailed to you.' : '') });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};
