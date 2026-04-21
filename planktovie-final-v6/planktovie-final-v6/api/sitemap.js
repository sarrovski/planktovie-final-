// api/sitemap.js — Generates sitemap.xml dynamically from Sanity products

const SANITY_ID = 'xysumkw1';
const SANITY_DS = 'production';
const SITE_URL = 'https://planktovie.biz';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

module.exports = async function handler(req, res) {
  try {
    // Fetch products from Sanity
    const groq = '*[_type == "product" && defined(name)] | order(sortOrder asc) { name, _updatedAt }';
    const url = `https://${SANITY_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DS}?query=${encodeURIComponent(groq)}`;
    const sanityRes = await fetch(url);
    const data = await sanityRes.json();
    const products = data.result || [];

    const today = new Date().toISOString().split('T')[0];

    // Static pages
    const staticPages = [
      { path: '/', priority: '1.0', changefreq: 'weekly' },
      { path: '/shop', priority: '0.9', changefreq: 'daily' },
      { path: '/brand', priority: '0.7', changefreq: 'monthly' },
      { path: '/training', priority: '0.6', changefreq: 'monthly' },
      { path: '/resources', priority: '0.7', changefreq: 'monthly' },
      { path: '/about', priority: '0.5', changefreq: 'monthly' },
      { path: '/contact', priority: '0.6', changefreq: 'monthly' },
      { path: '/careers', priority: '0.4', changefreq: 'monthly' },
    ];

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    for (const page of staticPages) {
      xml += `  <url>\n`;
      xml += `    <loc>${SITE_URL}${page.path}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    // Product pages
    for (const product of products) {
      const slug = slugify(product.name);
      const lastmod = product._updatedAt ? product._updatedAt.split('T')[0] : today;
      xml += `  <url>\n`;
      xml += `    <loc>${SITE_URL}/shop/${slug}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += `  </url>\n`;
    }

    xml += '</urlset>';

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(xml);

  } catch (err) {
    console.error('Sitemap error:', err.message);
    return res.status(500).send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
};
