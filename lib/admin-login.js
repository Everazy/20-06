// api/admin-login.js
// Endpoint: POST /api/admin-login
// Body: { password: "..." }

export default async function handler(req, res) {
  // Hanya izinkan POST
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password } = req.body || {};

    if (!password) {
      return res.status(400).json({ error: 'Password diperlukan' });
    }

    // Rate limiting sederhana via header (Vercel tidak persist state antar request)
    // Untuk production, gunakan Upstash Redis untuk rate limiting yang lebih kuat
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      return res.status(500).json({ error: 'Konfigurasi server belum lengkap' });
    }

    // Bandingkan password (timing-safe)
    const isValid = timingSafeCompare(password, adminPassword);

    if (!isValid) {
      // Tambahkan delay untuk mencegah brute force
      await sleep(1000);
      return res.status(401).json({ error: 'Password salah' });
    }

    // Buat token sederhana dengan expiry 8 jam
    const token = createSimpleToken();
    const expiry = Date.now() + (8 * 60 * 60 * 1000); // 8 jam

    return res.status(200).json({
      success: true,
      token,
      expiry,
      message: 'Login berhasil'
    });

  } catch (err) {
    console.error('Admin login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Perbandingan string yang aman dari timing attack
function timingSafeCompare(a, b) {
  if (a.length !== b.length) {
    // Tetap lakukan loop penuh untuk mencegah timing attack
    let diff = 0;
    const padded = b.padEnd(a.length, '\0');
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ padded.charCodeAt(i);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function createSimpleToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
