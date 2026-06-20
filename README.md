# 🛒 Everastore - Panduan Setup & Deploy

Web toko digital dengan payment gateway otomatis SakuRupiah, manajemen stok akun, dan dashboard admin.

---

## 📁 Struktur File

```
everastore/
├── index.html          ← Halaman utama web (tampilan toko)
├── vercel.json         ← Konfigurasi Vercel
├── .gitignore          ← File yang TIDAK di-upload ke GitHub
├── .env.example        ← Contoh konfigurasi (SALIN menjadi .env)
├── README.md           ← Panduan ini
└── api/
    ├── admin-login.js      ← Login admin via password
    ├── create-payment.js   ← Buat invoice SakuRupiah
    ├── payment-callback.js ← Webhook dari SakuRupiah (otomatis kirim akun)
    ├── check-payment.js    ← Cek status pembayaran (polling)
    └── manage-stock.js     ← Tambah/lihat stok akun (admin)
```

---

## 🚀 Langkah Deploy ke Vercel

### Step 1 — Siapkan GitHub Repository

1. Buat akun [GitHub](https://github.com) jika belum punya
2. Buat repository **PRIVATE** (wajib private karena ada konfigurasi sensitif)
3. Upload semua file ini ke repository tersebut

> **Vercel bisa deploy dari repository private** — tidak ada masalah.

---

### Step 2 — Setup Firebase

1. Buka [console.firebase.google.com](https://console.firebase.google.com)
2. Klik **"Add project"** → beri nama (contoh: `everastore-toko`)
3. Setelah project dibuat, klik ikon `</>` (Web app) → daftarkan app
4. Salin nilai `firebaseConfig` yang muncul (apiKey, projectId, dll)
5. Aktifkan **Firestore Database**:
   - Klik "Firestore Database" di sidebar → "Create database"
   - Pilih mode **Production** → pilih region Asia
6. Atur **Rules** Firestore (klik tab Rules, ganti dengan kode di bawah):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Produk: publik bisa baca, hanya authenticated yang bisa tulis
    match /artifacts/{appId}/public/data/products/{doc} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    // Stok akun: HANYA server (Cloud Functions/Admin SDK) yang bisa akses
    match /stocks/{doc} {
      allow read, write: if false; // API serverless yang mengakses
    }

    // Orders: hanya server yang bisa tulis
    match /orders/{doc} {
      allow read, write: if false;
    }

    // Log transaksi: hanya server
    match /transaction_logs/{doc} {
      allow read, write: if false;
    }
  }
}
```

---

### Step 3 — Daftar & Dapatkan API Key SakuRupiah

1. Daftar di [sakurupiah.com](https://sakurupiah.com) sebagai merchant
2. Masuk ke dashboard → bagian **API / Integrasi**
3. Salin **API Key** dan **Merchant ID**
4. Pastikan **Callback URL** di dashboard SakuRupiah diisi dengan:
   ```
   https://nama-domain-vercel-kamu.vercel.app/api/payment-callback
   ```

---

### Step 4 — Deploy ke Vercel

1. Buka [vercel.com](https://vercel.com) → Login dengan GitHub
2. Klik **"New Project"** → pilih repository everastore kamu
3. Pada bagian **Environment Variables**, tambahkan semua variabel berikut:

| Key | Value |
|-----|-------|
| `FIREBASE_API_KEY` | Dari Firebase project settings |
| `FIREBASE_AUTH_DOMAIN` | `project-id.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | ID project Firebase kamu |
| `FIREBASE_STORAGE_BUCKET` | `project-id.firebasestorage.app` |
| `FIREBASE_MESSAGING_SENDER_ID` | Dari Firebase project settings |
| `FIREBASE_APP_ID` | Dari Firebase project settings |
| `SAKURUPIAH_API_KEY` | API Key dari SakuRupiah |
| `SAKURUPIAH_MERCHANT_ID` | Merchant ID dari SakuRupiah |
| `SAKURUPIAH_BASE_URL` | `https://api.sakurupiah.com` |
| `ADMIN_PASSWORD` | Password admin kamu (buat yang kuat!) |
| `JWT_SECRET` | String acak panjang (minimal 64 karakter) |
| `CLOUDINARY_CLOUD_NAME` | `dhipofpp2` (sudah ada, bisa diganti) |
| `CLOUDINARY_UPLOAD_PRESET` | `katalog` (sudah ada, bisa diganti) |
| `INSIDER_BASE_URL` | `https://insidertopup.com` (base URL provider topup Game) |
| `INSIDER_API_KEY` | API Key insidertopup (untuk auto-topup Game) |

4. Klik **Deploy** → tunggu beberapa menit
5. Web kamu sudah online! 🎉

---

## ⚙️ Cara Pakai Fitur-Fitur Baru

### Fitur 1: Login Admin (Password Sederhana)

Di halaman web, klik ikon 🛡️ di pojok kanan atas → masukkan password admin yang kamu set di `ADMIN_PASSWORD`.

### Fitur 2: Tambah Stok Akun

1. Login sebagai admin
2. Masuk ke Dashboard Admin
3. Di setiap produk, klik tombol **kotak hijau (📦)**
4. Isi stok akun di textarea — satu baris satu akun
   - Format bebas, contoh: `email@gmail.com|password`
5. Klik **Tambah Stok**

### Fitur 3: Payment Gateway Otomatis

Di halaman produk pembeli:
1. Pilih produk dan varian
2. Klik tombol **"Bayar Otomatis"** (warna ungu)
3. Isi nama (wajib) dan email/HP (opsional)
4. Klik **Buat Invoice Pembayaran**
5. Halaman akan menampilkan link pembayaran SakuRupiah
6. Setelah pembeli membayar → akun otomatis ditampilkan di halaman itu juga!

---

## 🔐 Keamanan

| Aspek | Penjelasan |
|-------|-----------|
| **Repository Private** | API key tidak terbaca publik di GitHub |
| **Environment Variables** | Semua secret disimpan di Vercel, tidak di file |
| **Timing-safe compare** | Login admin aman dari timing attack |
| **Webhook signature verify** | Callback SakuRupiah diverifikasi signature-nya |
| **Transaksi atomic Firestore** | Stok tidak bisa dikurangi dua kali sekaligus |
| **Input sanitization** | Semua input pengguna dibersihkan |
| **Idempotency** | Pembayaran yang sama tidak diproses dua kali |
| **Rate limiting** | Delay 1 detik jika password salah |

---

## ❓ FAQ

**Q: Repository harus public atau private?**
A: **WAJIB PRIVATE** kalau kamu simpan konfigurasi penting. Vercel bisa deploy dari repo private tanpa masalah.

**Q: Bagaimana jika stok habis tapi ada yang bayar?**
A: Sistem akan mencatat order dan menandai `needsManualHandling: true`. Kamu perlu tambah stok manual dan hubungi pembeli via WhatsApp.

**Q: Apakah aman menyimpan akun di Firestore?**
A: Firestore rules yang sudah diatur memblokir akses langsung. Akun hanya bisa diambil oleh API serverless Vercel menggunakan Firebase Admin SDK. Tidak ada yang bisa baca langsung dari browser.

**Q: Bagaimana cara ganti Firebase dengan yang baru?**
A: Update nilai `FIREBASE_*` di Vercel Environment Variables, lalu trigger redeploy.

---

## 📞 Support

Jika ada masalah teknis, hubungi admin via WhatsApp: **6285750173207**
