// api/insider-catalog.js
// Endpoint admin untuk menarik katalog insidertopup (daftar games & produk/SKU)
// agar bisa dipilih lewat picker di dashboard. Butuh token admin (Authorization: Bearer ...).
//
//   GET /api/insider-catalog?type=games
//   GET /api/insider-catalog?type=products&code=VAL
//
// Mengembalikan data ringkas yang dibutuhkan UI picker.

import { insiderGames, insiderProducts } from './_insider.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Hanya admin (token sama seperti manage-stock POST / toggle-autopayment).
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || token.length < 32) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { type, code } = req.query;

    if (type === 'games') {
      const r = await insiderGames();
      if (!r.ok) return res.status(502).json({ error: r.error });
      const games = (Array.isArray(r.data) ? r.data : [])
        .filter(g => g && g.status !== 'Off')
        .map(g => ({ code: g.code, name: g.games, category: g.category }));
      return res.status(200).json({ success: true, games });
    }

    if (type === 'products') {
      if (!code) return res.status(400).json({ error: 'Parameter code (kode game) diperlukan' });
      const r = await insiderProducts(code);
      if (!r.ok) return res.status(502).json({ error: r.error });
      const products = (Array.isArray(r.data) ? r.data : [])
        .filter(p => p && p.status !== 'Off')
        .map(p => ({
          sku: p.sku,
          name: p.product,
          game: p.games,
          // harga publik dari insider (biaya modal) — ditampilkan sbg referensi ke admin
          basePrice: parseInt(p.price?.publik || '0') || 0,
        }));
      return res.status(200).json({ success: true, products });
    }

    return res.status(400).json({ error: "Parameter type harus 'games' atau 'products'" });
  } catch (err) {
    console.error('insider-catalog error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
