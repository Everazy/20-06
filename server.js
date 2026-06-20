import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load semua API handler
const { default: adminLogin }        = await import('./api/admin-login.js');
const { default: checkPayment }      = await import('./api/check-payment.js');
const { default: createPayment }     = await import('./api/create-payment.js');
const { default: insiderCatalog }    = await import('./api/insider-catalog.js');
const { default: manageStock }       = await import('./api/manage-stock.js');
const { default: paymentCallback }   = await import('./api/payment-callback.js');
const { default: toggleAutopayment } = await import('./api/toggle-autopayment.js');
const { default: myIp }              = await import('./api/my-ip.js');
const { default: cekNickname }       = await import('./api/cek-nickname.js');
const { default: myOrders }          = await import('./api/my-orders.js');
const { default: rentalListing }     = await import('./api/rental-listing.js');
const { default: rentalPayment }     = await import('./api/rental-payment.js');
const { default: rentalCallback }    = await import('./api/rental-callback.js');

// ── MAINTENANCE MODE ──────────────────────────────────────────────────
// Set MAINTENANCE_MODE=true di Railway Variables untuk aktifkan
// Set ALLOWED_IPS=1.2.3.4,5.6.7.8 di Railway Variables untuk bypass (IP kamu)
const allowedIps = (process.env.ALLOWED_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);

app.use((req, res, next) => {
  if (process.env.MAINTENANCE_MODE?.toLowerCase() === 'true') {
    const clientIp = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
    if (allowedIps.includes(clientIp)) return next();
    return res.sendFile(path.join(__dirname, 'maintenance.html'));
  }
  next();
});
// ─────────────────────────────────────────────────────────────────────

// Mount API routes DULU sebelum static files
app.all('/api/admin-login',        adminLogin);
app.all('/api/check-payment',      checkPayment);
app.all('/api/create-payment',     createPayment);
app.all('/api/insider-catalog',    insiderCatalog);
app.all('/api/manage-stock',       manageStock);
app.all('/api/payment-callback',   paymentCallback);
app.all('/api/toggle-autopayment', toggleAutopayment);
app.all('/api/my-ip',              myIp);
app.all('/api/cek-nickname',        cekNickname);
app.all('/api/my-orders',           myOrders);
app.all('/api/rental-listing',      rentalListing);
app.all('/api/rental-payment',      rentalPayment);
app.all('/api/rental-callback',     rentalCallback);

// Static files SETELAH API routes
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// HTML pages
app.get('/',                (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/game',            (req, res) => res.sendFile(path.join(__dirname, 'game.html')));
app.get('/lainnya',         (req, res) => res.sendFile(path.join(__dirname, 'lainnya.html')));
app.get('/premium',         (req, res) => res.sendFile(path.join(__dirname, 'premium.html')));
app.get('/sosmed',          (req, res) => res.sendFile(path.join(__dirname, 'sosmed.html')));
app.get('/sewa',            (req, res) => res.sendFile(path.join(__dirname, 'sewa.html')));
app.get('/sewa.html',       (req, res) => res.sendFile(path.join(__dirname, 'sewa.html')));
app.get('/payment-success', (req, res) => res.sendFile(path.join(__dirname, 'payment-success.html')));

// Fallback ke index.html
app.get('*', (req, res) => {
  const filePath = path.join(__dirname, req.path);
  res.sendFile(filePath, (err) => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

app.listen(PORT, () => {
  console.log(`EVERASTORE running on port ${PORT}`);
});
