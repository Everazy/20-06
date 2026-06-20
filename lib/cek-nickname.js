// Proxy untuk api.isan.eu.org — menghindari CORS block di browser
export default async function handler(req, res) {
  const { game, id, server } = req.query;

  const allowed = ['ml', 'ff', 'pubgm', 'codm', 'genshin', 'hsr'];
  if (!game || !allowed.includes(game)) {
    return res.status(400).json({ error: 'Game tidak valid' });
  }
  if (!id) {
    return res.status(400).json({ error: 'ID wajib diisi' });
  }

  // Bangun URL ke API asli sesuai game
  const params = new URLSearchParams({ id });
  if (game === 'ml')      params.set('server', server || '');
  if (game === 'ff')      params.set('region', server || '');
  if (game === 'pubgm')   params.set('region', server || '');
  if (game === 'codm')    params.set('region', (server || '').toLowerCase());
  if (game === 'genshin') params.set('server', (server || '').toLowerCase());
  if (game === 'hsr')     params.set('server', (server || '').toLowerCase());

  const upstream = `https://api.isan.eu.org/nickname/${game}?${params.toString()}`;

  try {
    const response = await fetch(upstream, {
      headers: { 'User-Agent': 'EverastoreProxy/1.0' }
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Gagal terhubung ke upstream', detail: err.message });
  }
}
