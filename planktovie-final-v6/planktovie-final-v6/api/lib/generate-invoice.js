// api/lib/generate-invoice.js
// Generates a professional PDF invoice using PDFKit

const PDFDocument = require('pdfkit');

const COMPANY = {
  name: 'Planktovie SAS',
  address: '45 rue Frédéric Joliot Curie',
  city: '13013 Marseille, France',
  email: 'info@planktovie.biz',
  web: 'planktovie.biz',
  siret: '', // Add when available
  tva: '', // Add intra-community VAT number when available
};

function generateInvoice({ orderNum, date, customer, email, org, address, items, subtotal, shipping, coolBox, taxAmount, total, currency }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 100; // usable width

      // ── HEADER ──
      doc.fontSize(20).fillColor('#0f2b4c').font('Helvetica-Bold')
        .text('PLANKTOVIE', 50, 50);
      doc.fontSize(8).fillColor('#8b95a3').font('Helvetica')
        .text(COMPANY.address, 50, 75)
        .text(COMPANY.city, 50, 86)
        .text(COMPANY.email + ' · ' + COMPANY.web, 50, 97);

      // Invoice title
      doc.fontSize(22).fillColor('#007a6e').font('Helvetica-Bold')
        .text('INVOICE', 350, 50, { align: 'right', width: W - 300 });
      
      doc.fontSize(9).fillColor('#2d3748').font('Helvetica')
        .text(`Invoice: ${orderNum}`, 350, 78, { align: 'right', width: W - 300 })
        .text(`Date: ${date}`, 350, 91, { align: 'right', width: W - 300 });

      // ── DIVIDER ──
      doc.moveTo(50, 120).lineTo(50 + W, 120).strokeColor('#e8ecf0').lineWidth(1).stroke();

      // ── BILL TO ──
      doc.fontSize(8).fillColor('#8b95a3').font('Helvetica-Bold')
        .text('BILL TO', 50, 135);
      doc.fontSize(10).fillColor('#2d3748').font('Helvetica-Bold')
        .text(customer || 'Customer', 50, 148);
      doc.fontSize(9).fillColor('#4a5568').font('Helvetica');
      let billY = 162;
      if (org) { doc.text(org, 50, billY); billY += 13; }
      if (email) { doc.text(email, 50, billY); billY += 13; }
      if (address) {
        if (address.line1) { doc.text(address.line1, 50, billY); billY += 13; }
        if (address.line2) { doc.text(address.line2, 50, billY); billY += 13; }
        const cityLine = [address.postal_code, address.city, address.country].filter(Boolean).join(' ');
        if (cityLine) { doc.text(cityLine, 50, billY); billY += 13; }
      }

      // ── ITEMS TABLE ──
      const tableTop = Math.max(billY + 20, 220);

      // Table header
      doc.rect(50, tableTop, W, 22).fill('#0f2b4c');
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold');
      doc.text('Product', 58, tableTop + 6, { width: W * 0.5 });
      doc.text('Qty', 58 + W * 0.5, tableTop + 6, { width: W * 0.12, align: 'center' });
      doc.text('Unit Price', 58 + W * 0.62, tableTop + 6, { width: W * 0.18, align: 'right' });
      doc.text('Total', 58 + W * 0.8, tableTop + 6, { width: W * 0.18, align: 'right' });

      // Table rows
      let rowY = tableTop + 22;
      doc.font('Helvetica').fillColor('#2d3748').fontSize(8.5);

      if (items && items.length) {
        items.forEach((item, i) => {
          const bg = i % 2 === 0 ? '#ffffff' : '#f8fafb';
          doc.rect(50, rowY, W, 20).fill(bg);
          doc.fillColor('#2d3748');
          doc.text(item.name || 'Product', 58, rowY + 5, { width: W * 0.5 });
          doc.text(String(item.qty || 1), 58 + W * 0.5, rowY + 5, { width: W * 0.12, align: 'center' });
          doc.text('€' + (item.unitPrice || 0).toFixed(2), 58 + W * 0.62, rowY + 5, { width: W * 0.18, align: 'right' });
          doc.text('€' + (item.total || 0).toFixed(2), 58 + W * 0.8, rowY + 5, { width: W * 0.18, align: 'right' });
          rowY += 20;
        });
      }

      // ── TOTALS ──
      rowY += 10;
      const totalsX = 58 + W * 0.62;
      const totalsW = W * 0.36;

      doc.fontSize(9).fillColor('#6b7685').font('Helvetica');
      doc.text('Subtotal (HT)', totalsX, rowY, { width: totalsW * 0.55 });
      doc.text('€' + (subtotal || 0).toFixed(2), totalsX + totalsW * 0.55, rowY, { width: totalsW * 0.45, align: 'right' });
      rowY += 16;

      if (shipping > 0) {
        doc.text('Shipping', totalsX, rowY, { width: totalsW * 0.55 });
        doc.text('€' + shipping.toFixed(2), totalsX + totalsW * 0.55, rowY, { width: totalsW * 0.45, align: 'right' });
        rowY += 16;
      }

      if (coolBox > 0) {
        doc.text('Cool Box', totalsX, rowY, { width: totalsW * 0.55 });
        doc.text('€' + coolBox.toFixed(2), totalsX + totalsW * 0.55, rowY, { width: totalsW * 0.45, align: 'right' });
        rowY += 16;
      }

      if (taxAmount > 0) {
        doc.text('VAT', totalsX, rowY, { width: totalsW * 0.55 });
        doc.text('€' + taxAmount.toFixed(2), totalsX + totalsW * 0.55, rowY, { width: totalsW * 0.45, align: 'right' });
        rowY += 16;
      }

      // Total line
      doc.moveTo(totalsX, rowY).lineTo(totalsX + totalsW, rowY).strokeColor('#0f2b4c').lineWidth(1.5).stroke();
      rowY += 6;
      doc.fontSize(12).fillColor('#0f2b4c').font('Helvetica-Bold');
      doc.text('TOTAL', totalsX, rowY, { width: totalsW * 0.55 });
      doc.text(currency + ' ' + (total || 0).toFixed(2), totalsX + totalsW * 0.55, rowY, { width: totalsW * 0.45, align: 'right' });

      // ── FOOTER ──
      const footY = doc.page.height - 80;
      doc.moveTo(50, footY).lineTo(50 + W, footY).strokeColor('#e8ecf0').lineWidth(0.5).stroke();
      doc.fontSize(7).fillColor('#8b95a3').font('Helvetica')
        .text('Planktovie SAS · 45 rue Frédéric Joliot Curie, 13013 Marseille, France · info@planktovie.biz · planktovie.biz', 50, footY + 8, { align: 'center', width: W })
        .text('Payment processed securely via Stripe. All prices in EUR.', 50, footY + 20, { align: 'center', width: W });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoice };
