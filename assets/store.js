
        // === EVERASTORE ENGINE (shared across index/game/premium/sosmed/lainnya) ===
        // Page identity is set by each HTML file via window.EVERA_PAGE before this loads.
        // 'home' = landing; otherwise a category page key below.
        const EVERA_PAGE = window.EVERA_PAGE || 'home';
        // Map a category-page key -> internal storeData category code.
        const PAGE_TO_CAT = { game: 'topup', premium: 'premium', sosmed: 'sosmed', lainnya: 'lainnya' };
        const PAGE_CAT = PAGE_TO_CAT[EVERA_PAGE] || null; // null on home
        const IS_CATEGORY_PAGE = PAGE_CAT !== null;
        // Brand logo click: on a category page go back to landing; on home reset view.
        window.goBrandHome = () => {
            if (IS_CATEGORY_PAGE) { window.location.href = '/'; return; }
            resetToHome();
        };

        // === FIREBASE REST API (no SDK) ===
        const FIREBASE_PROJECT_ID = "everast-27aec";
        const FIREBASE_API_KEY = "AIzaSyBSF51J6c8TDqzy4KCfZ4aEoQyoAnbCmyI";
        const FIREBASE_AUTH_DOMAIN = "everast-27aec.firebaseapp.com";
        const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
        const FB_AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts`;

        let _idToken = null;

        // Convert JS value → Firestore field value
        function toFSValue(v) {
            if (v === null || v === undefined) return { nullValue: null };
            if (typeof v === 'boolean') return { booleanValue: v };
            if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
            if (typeof v === 'string') return { stringValue: v };
            if (Array.isArray(v)) return { arrayValue: { values: v.map(toFSValue) } };
            if (typeof v === 'object') {
                const fields = {};
                for (const [k, val] of Object.entries(v)) fields[k] = toFSValue(val);
                return { mapValue: { fields } };
            }
            return { stringValue: String(v) };
        }
        function toFSFields(obj) {
            const fields = {};
            for (const [k, v] of Object.entries(obj)) fields[k] = toFSValue(v);
            return fields;
        }
        // Convert Firestore document → JS object
        function fromFSDoc(doc) {
            if (!doc || !doc.fields) return null;
            const obj = { id: doc.name?.split('/').pop() };
            for (const [k, v] of Object.entries(doc.fields)) obj[k] = fromFSValue(v);
            return obj;
        }
        function fromFSValue(v) {
            if ('nullValue' in v) return null;
            if ('booleanValue' in v) return v.booleanValue;
            if ('integerValue' in v) return parseInt(v.integerValue);
            if ('doubleValue' in v) return v.doubleValue;
            if ('stringValue' in v) return v.stringValue;
            if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFSValue);
            if ('mapValue' in v) {
                const obj = {};
                for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFSValue(val);
                return obj;
            }
            return null;
        }

        // Firestore REST operations
        // fieldMask (opsional): array nama field yang BOLEH diubah. Tanpa ini, Firestore
        // REST API akan menimpa SELURUH dokumen (field lain yang tidak dikirim akan terhapus) —
        // makanya untuk update profil (bukan full replace seperti data produk admin) WAJIB isi fieldMask.
        async function fsSet(collPath, docId, data, tokenOverride, fieldMask) {
            let url = `${FB_BASE}/${collPath}/${docId}?key=${FIREBASE_API_KEY}`;
            if (fieldMask && fieldMask.length) {
                url += fieldMask.map(f => `&updateMask.fieldPaths=${encodeURIComponent(f)}`).join('');
            }
            const headers = { 'Content-Type': 'application/json' };
            const tok = tokenOverride || _idToken;
            if (tok) headers['Authorization'] = `Bearer ${tok}`;
            const res = await fetch(url, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ fields: toFSFields(data) })
            });
            if (!res.ok) { const e = await res.text(); throw new Error(e); }
            return res.json();
        }
        async function fsDelete(collPath, docId) {
            const url = `${FB_BASE}/${collPath}/${docId}?key=${FIREBASE_API_KEY}`;
            const headers = {};
            if (_idToken) headers['Authorization'] = `Bearer ${_idToken}`;
            const res = await fetch(url, { method: 'DELETE', headers });
            if (!res.ok) { const e = await res.text(); throw new Error(e); }
        }
        async function fsList(collPath) {
            // Read publik - tidak butuh token
            const url = `${FB_BASE}/${collPath}?key=${FIREBASE_API_KEY}&pageSize=200`;
            const res = await fetch(url);
            if (!res.ok) { const e = await res.text(); throw new Error(e); }
            const json = await res.json();
            return (json.documents || []).map(fromFSDoc);
        }

        // Auth REST operations
        async function fbSignIn(email, password) {
            const res = await fetch(`${FB_AUTH_URL}:signInWithPassword?key=${FIREBASE_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, returnSecureToken: true })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error?.message || 'Login gagal');
            _idToken = data.idToken;
            return data;
        }
        function fbSignOut() { _idToken = null; }

        // === AKUN PEMBELI (Login Google) ===
        // Dipakai sebagai syarat order otomatis (Bayar Otomatis). Pakai Firebase Identity Toolkit
        // REST API (signInWithIdp) + Google Identity Services (GIS) token, konsisten dengan pola
        // "tanpa SDK" yang sudah dipakai di file ini.
        const GOOGLE_CLIENT_ID = "PASANG_GOOGLE_CLIENT_ID_DI_SINI.apps.googleusercontent.com";
        const BUYER_STORAGE_KEY = 'evr_buyer_session';
        const POINTS_PER_ORDER   = 10;
        const POINTS_FIRST_LOGIN = 1000;
        const POINTS_REFERRAL    = 1000;
        const POINTS_TO_RUPIAH   = 1; // 1 poin = Rp1
        let buyerUser = null; // { uid, name, email, photo, idToken, refreshToken, expiresAt }
        let _pendingAutoOrderAfterLogin = false;

        function saveBuyerSession(s) {
            buyerUser = s;
            if (s) localStorage.setItem(BUYER_STORAGE_KEY, JSON.stringify(s));
            else localStorage.removeItem(BUYER_STORAGE_KEY);
            renderBuyerUI();
        }

        async function restoreBuyerSession() {
            const raw = localStorage.getItem(BUYER_STORAGE_KEY);
            if (!raw) { renderBuyerUI(); return; }
            try {
                const s = JSON.parse(raw);
                // Jika tidak ada refreshToken, sesi tidak valid — hapus dan paksa login ulang
                if (!s || !s.refreshToken) {
                    localStorage.removeItem(BUYER_STORAGE_KEY);
                    buyerUser = null;
                    renderBuyerUI();
                    return;
                }
                if (s.expiresAt && Date.now() > s.expiresAt - 60000) {
                    // Token hampir/sudah kedaluwarsa - refresh pakai refreshToken
                    const refreshed = await refreshBuyerToken(s.refreshToken);
                    if (!refreshed) { saveBuyerSession(null); return; }
                    buyerUser = { ...s, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: Date.now() + (parseInt(refreshed.expiresIn || '3600') * 1000) };
                    localStorage.setItem(BUYER_STORAGE_KEY, JSON.stringify(buyerUser));
                } else {
                    buyerUser = s;
                }
            } catch (e) {
                // Sesi corrupt — bersihkan supaya user bisa login ulang
                localStorage.removeItem(BUYER_STORAGE_KEY);
                buyerUser = null;
            }
            renderBuyerUI();
        }

        async function refreshBuyerToken(refreshToken) {
            if (!refreshToken) return null;
            try {
                const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
                });
                if (!res.ok) return null;
                return await res.json();
            } catch (e) { return null; }
        }

        function initBuyerAuth() {
            restoreBuyerSession();
            if (window.google?.accounts?.id) {
                google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
            } else {
                // Skrip GIS belum siap, coba lagi sebentar
                window.addEventListener('load', () => {
                    if (window.google?.accounts?.id) {
                        google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
                    }
                });
            }
        }

        window.openBuyerModal = () => {
            document.getElementById('modal-buyer')?.classList.remove('hidden');
            // Validasi buyerUser benar-benar valid (punya uid & refreshToken)
            if (buyerUser && buyerUser.uid && buyerUser.refreshToken) {
                showBuyerProfileView();
            } else {
                if (buyerUser) saveBuyerSession(null); // bersihkan sesi tidak valid
                showBuyerGuestView();
            }
        };
        window.closeBuyerModal = () => {
            document.getElementById('modal-buyer')?.classList.add('hidden');
        };

        function showBuyerGuestView() {
            document.getElementById('buyer-modal-guest')?.classList.remove('hidden');
            document.getElementById('buyer-modal-profile')?.classList.add('hidden');
            const container = document.getElementById('google-signin-btn-container');
            if (container && window.google?.accounts?.id) {
                container.innerHTML = '';
                google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
            }
            document.getElementById('buyer-email-error')?.classList.add('hidden');
        }

        function showBuyerProfileView() {
            document.getElementById('buyer-modal-guest')?.classList.add('hidden');
            document.getElementById('buyer-modal-profile')?.classList.remove('hidden');
            document.getElementById('buyer-profile-avatar').src = buyerUser.photo || '';
            document.getElementById('buyer-profile-name').innerText = buyerUser.name || 'Pembeli';
            document.getElementById('buyer-profile-email').innerText = buyerUser.email || '';
            // Set kode referral langsung dari UID tanpa tunggu fetch
            const refEl = document.getElementById('buyer-referral-code');
            if (refEl && buyerUser.uid) refEl.innerText = buyerUser.uid.substring(0, 8).toUpperCase();
            loadBuyerDashboard();
        }

        async function loadBuyerDashboard() {
            if (!buyerUser) return;
            try {
                const res = await fetch(`/api/my-orders?uid=${encodeURIComponent(buyerUser.uid)}`);
                const data = await res.json();
                const pts = data.points ?? 0;
                document.getElementById('buyer-profile-points').innerText = pts;
                const rpEl = document.getElementById('buyer-profile-points-rp');
                if (rpEl) rpEl.innerText = pts.toLocaleString('id-ID');
                document.getElementById('buyer-profile-orders').innerText = data.totalOrders ?? 0;
                // Kode referral = 8 karakter pertama UID (unik & mudah dibagikan)
                const refEl = document.getElementById('buyer-referral-code');
                if (refEl) refEl.innerText = buyerUser.uid.substring(0, 8).toUpperCase();
                const histEl = document.getElementById('buyer-order-history');
                if (!data.orders || data.orders.length === 0) {
                    histEl.innerHTML = '<p class="text-[9px] text-slate-300 font-bold text-center py-4">Belum ada order otomatis.</p>';
                } else {
                    histEl.innerHTML = data.orders.map(o => `
                        <div class="bg-slate-50 rounded-xl p-3 flex justify-between items-center">
                            <div class="overflow-hidden">
                                <p class="text-[9px] font-black text-slate-700 truncate">${escapeHtml(o.productName || o.productId)}</p>
                                <p class="text-[8px] text-slate-400 font-bold">${o.paidAt ? new Date(o.paidAt).toLocaleString('id-ID') : ''}</p>
                            </div>
                            <span class="text-[8px] font-black uppercase px-2 py-1 rounded-full ${o.status === 'paid' ? 'bg-green-100 text-green-600' : 'bg-amber-100 text-amber-600'}">${escapeHtml(o.status || '-')}</span>
                        </div>
                    `).join('');
                }
            } catch (e) {
                console.error('[Buyer] Gagal memuat dashboard:', e);
            }
        }

        // escapeHtml() sudah didefinisikan di bawah, dipakai juga oleh dashboard pembeli

        async function handleGoogleCredential(response) {
            try {
                showToast('MEMPROSES LOGIN...');
                const idpRes = await fetch(`${FB_AUTH_URL}:signInWithIdp?key=${FIREBASE_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        postBody: `id_token=${response.credential}&providerId=google.com`,
                        requestUri: window.location.origin,
                        returnIdpCredential: true,
                        returnSecureToken: true
                    })
                });
                const data = await idpRes.json();
                if (!idpRes.ok) throw new Error(data.error?.message || 'Login Google gagal');

                const session = {
                    uid: data.localId,
                    name: data.displayName || data.email,
                    email: data.email,
                    photo: data.photoUrl || '',
                    idToken: data.idToken,
                    refreshToken: data.refreshToken,
                    expiresAt: Date.now() + (parseInt(data.expiresIn || '3600') * 1000)
                };

                // Simpan/perbarui profil ke Firestore users/{uid}
                try {
                    // createdAt hanya diset pertama kali (PATCH tidak overwrite field yang tidak ada di updateMask,
                    // tapi kita pakai conditional: cek dulu apakah user sudah ada)
                    const _existCheck = await fetch(`${FB_BASE}/users/${session.uid}?key=${FIREBASE_API_KEY}`);
                    const _isNew = !_existCheck.ok || !(await _existCheck.json()).fields?.createdAt;
                    const profileData = {
                        displayName: session.name,
                        email: session.email,
                        photoURL: session.photo,
                        updatedAt: new Date().toISOString(),
                        // Kode referral disimpan sebagai FIELD (bukan cuma dihitung di tampilan),
                        // supaya backend bisa mencari pemilik kode ini saat ada yang klaim.
                        referralCode: session.uid.substring(0, 8).toUpperCase()
                    };
                    const profileFieldMask = ['displayName', 'email', 'photoURL', 'updatedAt', 'referralCode'];
                    if (_isNew) { profileData.createdAt = new Date().toISOString(); profileFieldMask.push('createdAt'); }
                    // fieldMask wajib di sini — tanpa ini, field lain seperti points/referralClaimed/totalOrders
                    // akan TERHAPUS setiap kali user login ulang (PATCH Firestore tanpa mask = full overwrite).
                    await fsSet('users', session.uid, profileData, session.idToken, profileFieldMask);
                } catch (e) { console.warn('[Buyer] Gagal sinkron profil:', e); }

                saveBuyerSession(session);

                // Bonus login pertama
                try {
                    const bonusRes = await fetch('/api/first-login-bonus', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uid: session.uid, idToken: session.idToken })
                    });
                    const bonusData = await bonusRes.json();
                    if (bonusData.awarded) showToast(`🎉 BONUS LOGIN PERTAMA! +${POINTS_FIRST_LOGIN} POIN`);
                    else showToast('LOGIN BERHASIL!');
                } catch { showToast('LOGIN BERHASIL!'); }

                showBuyerProfileView();

                if (_pendingAutoOrderAfterLogin) {
                    _pendingAutoOrderAfterLogin = false;
                    closeBuyerModal();
                    window.startPaymentGateway();
                }
            } catch (e) {
                console.error('[Buyer] Login error:', e);
                showToast('LOGIN GAGAL: ' + e.message);
            }
        }

        window.buyerLogout = () => {
            saveBuyerSession(null);
            closeBuyerModal();
            showToast('BERHASIL LOGOUT');
        };

        // === SISTEM POIN ===

        // Salin kode referral ke clipboard
        window.copyReferralCode = () => {
            const code = document.getElementById('buyer-referral-code')?.innerText;
            if (!code || code === '-') return;
            navigator.clipboard.writeText(code).then(() => showToast('KODE REFERRAL DISALIN!'));
        };

        // Klaim kode referral orang lain (satu kali saja)
        window.claimReferral = async () => {
            if (!buyerUser) return;
            const input = document.getElementById('referral-input');
            const msgEl = document.getElementById('referral-claim-msg');
            const referrerCode = input?.value?.trim().toUpperCase();
            if (!referrerCode) return;

            const ownCode = buyerUser.uid.substring(0, 8).toUpperCase();
            if (referrerCode === ownCode) {
                msgEl.className = 'text-[8px] font-bold text-red-400';
                msgEl.innerText = 'Tidak bisa pakai kode referral milikmu sendiri.';
                msgEl.classList.remove('hidden');
                return;
            }

            msgEl.className = 'text-[8px] font-bold text-slate-400';
            msgEl.innerText = 'Memproses...';
            msgEl.classList.remove('hidden');
            try {
                const res = await fetch('/api/claim-referral', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ referrerCode, newUserUid: buyerUser.uid, newUserIdToken: buyerUser.idToken })
                });
                const data = await res.json();
                if (data.success) {
                    msgEl.className = 'text-[8px] font-bold text-green-500';
                    msgEl.innerText = '✅ Referral berhasil diklaim! Temanmu dapat +1.000 poin.';
                    input.value = '';
                    document.getElementById('referral-claim-section').style.display = 'none';
                } else {
                    msgEl.className = 'text-[8px] font-bold text-red-400';
                    msgEl.innerText = data.error || 'Gagal klaim referral.';
                }
            } catch {
                msgEl.className = 'text-[8px] font-bold text-red-400';
                msgEl.innerText = 'Gagal terhubung ke server.';
            }
        };

        // Tampilkan/sembunyikan section redeem poin di checkout berdasarkan login status
        function refreshCheckoutPointsUI() {
            const section = document.getElementById('redeem-points-section');
            if (!section) return;
            if (buyerUser) {
                section.classList.remove('hidden');
                loadCheckoutPoints();
            } else {
                section.classList.add('hidden');
            }
        }

        let _pointsApplied = 0; // poin yang akan dipakai di order ini

        async function loadCheckoutPoints() {
            if (!buyerUser) return;
            try {
                const res = await fetch(`/api/my-orders?uid=${encodeURIComponent(buyerUser.uid)}`);
                const data = await res.json();
                const el = document.getElementById('checkout-points-available');
                if (el) el.innerText = data.points ?? 0;
            } catch {}
        }

        window.applyPoints = async () => {
            if (!buyerUser) return;
            const input = document.getElementById('checkout-points-input');
            const msgEl = document.getElementById('checkout-points-msg');
            const pointsToUse = parseInt(input?.value || '0');
            if (!pointsToUse || pointsToUse < 1) {
                msgEl.className = 'text-[8px] font-bold text-red-400';
                msgEl.innerText = 'Masukkan jumlah poin yang valid.';
                msgEl.classList.remove('hidden');
                return;
            }
            msgEl.className = 'text-[8px] font-bold text-slate-400';
            msgEl.innerText = 'Memverifikasi...';
            msgEl.classList.remove('hidden');
            try {
                const res = await fetch('/api/redeem-points', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid: buyerUser.uid, idToken: buyerUser.idToken, pointsToUse })
                });
                const data = await res.json();
                if (data.success) {
                    _pointsApplied = pointsToUse;
                    msgEl.className = 'text-[8px] font-bold text-green-500';
                    msgEl.innerText = `✅ Diskon Rp${pointsToUse.toLocaleString('id-ID')} diterapkan! Sisa poin: ${data.remainingPoints}`;
                    const el = document.getElementById('checkout-points-available');
                    if (el) el.innerText = data.remainingPoints;
                    input.disabled = true;
                } else {
                    msgEl.className = 'text-[8px] font-bold text-red-400';
                    msgEl.innerText = data.error || 'Gagal memakai poin.';
                }
            } catch {
                msgEl.className = 'text-[8px] font-bold text-red-400';
                msgEl.innerText = 'Gagal terhubung ke server.';
            }
        };

        // === LOGIN/DAFTAR EMAIL & PASSWORD (alternatif Google, tanpa OTP) ===
        // Disengaja tanpa OTP: order ini cuma syarat punya akun untuk auto order,
        // bukan transaksi finansial langsung (pembayaran tetap lewat SakuRupiah/QRIS),
        // jadi email+password saja sudah cukup tanpa perlu infra OTP yang lebih ribet & berbayar.
        let _buyerEmailMode = 'login'; // 'login' | 'register'

        window.toggleBuyerEmailMode = () => {
            _buyerEmailMode = _buyerEmailMode === 'login' ? 'register' : 'login';
            const nameInput = document.querySelector('[data-register-only]');
            const btn = document.getElementById('buyer-email-submit-btn');
            const toggleText = document.getElementById('buyer-email-toggle-text');
            document.getElementById('buyer-email-error')?.classList.add('hidden');
            if (_buyerEmailMode === 'register') {
                nameInput?.classList.remove('hidden');
                btn.innerText = 'Daftar';
                btn.onclick = window.buyerEmailRegister;
                toggleText.innerText = 'Sudah punya akun? Masuk di sini';
            } else {
                nameInput?.classList.add('hidden');
                btn.innerText = 'Masuk';
                btn.onclick = window.buyerEmailLogin;
                toggleText.innerText = 'Belum punya akun? Daftar di sini';
            }
        };

        function showBuyerEmailError(msg) {
            const el = document.getElementById('buyer-email-error');
            if (!el) return;
            el.innerText = msg;
            el.classList.remove('hidden');
        }

        function buyerFriendlyAuthError(code) {
            const map = {
                EMAIL_EXISTS: 'Email sudah terdaftar, silakan masuk.',
                EMAIL_NOT_FOUND: 'Email belum terdaftar, silakan daftar dulu.',
                INVALID_PASSWORD: 'Password salah.',
                INVALID_LOGIN_CREDENTIALS: 'Email atau password salah.',
                WEAK_PASSWORD: 'Password minimal 6 karakter.',
                INVALID_EMAIL: 'Format email tidak valid.',
                MISSING_PASSWORD: 'Password wajib diisi.'
            };
            return map[code] || 'Gagal memproses akun. Coba lagi.';
        }

        async function finishBuyerEmailAuth(data, fallbackName) {
            const session = {
                uid: data.localId,
                name: fallbackName || data.displayName || data.email,
                email: data.email,
                photo: '',
                idToken: data.idToken,
                refreshToken: data.refreshToken,
                expiresAt: Date.now() + (parseInt(data.expiresIn || '3600') * 1000)
            };

            try {
                const _existCheck2 = await fetch(`${FB_BASE}/users/${session.uid}?key=${FIREBASE_API_KEY}`);
                const _isNew2 = !_existCheck2.ok || !(await _existCheck2.json()).fields?.createdAt;
                const profileData2 = {
                    displayName: session.name,
                    email: session.email,
                    updatedAt: new Date().toISOString(),
                    referralCode: session.uid.substring(0, 8).toUpperCase()
                };
                const profileFieldMask2 = ['displayName', 'email', 'updatedAt', 'referralCode'];
                if (_isNew2) { profileData2.createdAt = new Date().toISOString(); profileFieldMask2.push('createdAt'); }
                await fsSet('users', session.uid, profileData2, session.idToken, profileFieldMask2);
            } catch (e) { console.warn('[Buyer] Gagal sinkron profil:', e); }

            saveBuyerSession(session);

            // Bonus login pertama
            try {
                const bonusRes = await fetch('/api/first-login-bonus', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid: session.uid, idToken: session.idToken })
                });
                const bonusData = await bonusRes.json();
                if (bonusData.awarded) showToast(`🎉 BONUS LOGIN PERTAMA! +${POINTS_FIRST_LOGIN} POIN`);
                else showToast('LOGIN BERHASIL!');
            } catch { showToast('LOGIN BERHASIL!'); }

            showBuyerProfileView();

            if (_pendingAutoOrderAfterLogin) {
                _pendingAutoOrderAfterLogin = false;
                closeBuyerModal();
                window.startPaymentGateway();
            }
        }

        window.buyerEmailRegister = async () => {
            const name = document.getElementById('buyer-email-name')?.value?.trim();
            const email = document.getElementById('buyer-email-input')?.value?.trim();
            const password = document.getElementById('buyer-email-password')?.value || '';
            document.getElementById('buyer-email-error')?.classList.add('hidden');

            if (!name) return showBuyerEmailError('Isi nama lengkap dulu.');
            if (!email) return showBuyerEmailError('Isi email dulu.');
            if (password.length < 6) return showBuyerEmailError('Password minimal 6 karakter.');

            try {
                showToast('MENDAFTARKAN AKUN...');
                const res = await fetch(`${FB_AUTH_URL}:signUp?key=${FIREBASE_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, returnSecureToken: true })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(buyerFriendlyAuthError(data.error?.message));
                await finishBuyerEmailAuth(data, name);
            } catch (e) {
                showBuyerEmailError(e.message);
            }
        };

        window.buyerEmailLogin = async () => {
            const email = document.getElementById('buyer-email-input')?.value?.trim();
            const password = document.getElementById('buyer-email-password')?.value || '';
            document.getElementById('buyer-email-error')?.classList.add('hidden');

            if (!email) return showBuyerEmailError('Isi email dulu.');
            if (!password) return showBuyerEmailError('Isi password dulu.');

            try {
                showToast('MEMPROSES LOGIN...');
                const res = await fetch(`${FB_AUTH_URL}:signInWithPassword?key=${FIREBASE_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, returnSecureToken: true })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(buyerFriendlyAuthError(data.error?.message));
                await finishBuyerEmailAuth(data, null);
            } catch (e) {
                showBuyerEmailError(e.message);
            }
        };

        function renderBuyerUI() {
            const icon = document.getElementById('buyer-account-icon');
            const avatar = document.getElementById('buyer-account-avatar');
            if (!icon || !avatar) return;
            if (buyerUser && buyerUser.photo) {
                icon.classList.add('hidden');
                avatar.src = buyerUser.photo;
                avatar.classList.remove('hidden');
            } else {
                icon.classList.remove('hidden');
                avatar.classList.add('hidden');
            }
        }
        const appId = "everast-27aec-main";
        const WHATSAPP_NUMBER = "6285750173207";        const CLOUDINARY_CLOUD_NAME = "dhipofpp2";
        const CLOUDINARY_UPLOAD_PRESET = "katalog";

        let storeData = { topup: { items: [] }, sosmed: { items: [] }, premium: { items: [] }, lainnya: { items: [] } };
        let activeCat = null, activeProd = null, activeVar = null, activeAlbum = null, activeOrderType = 'none', isAdmin = false, currentEditId = null, currentFilter = 'all';
        let socialPrice = 0, currentSocialService = null, currentSocialTier = null, premiumQty = 1, currentTestimonialEditId = null, globalSearchQuery = '';
        let hasStartedListening = false;
        let _categoryOpened = false; // halaman kategori: tandai sudah dibuka otomatis sekali

        // --- OPTIMASI GAMBAR ---
        const PLACEHOLDER_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'%3E%3Crect width='400' height='400' fill='%23f1f5f9'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='48' fill='%23cbd5e1'%3E📦%3C/text%3E%3C/svg%3E";

        function getOptimizedUrl(url) {
            if (!url || !url.includes('cloudinary.com')) return url || PLACEHOLDER_IMG;
            return url.replace('/upload/', '/upload/f_auto,q_auto,w_800/');
        }

        // --- GLOBAL TOAST ---
        window.showToast = (m) => { 
            const t = document.getElementById('feedback-toast'); 
            t.innerText = m; t.classList.replace('scale-0', 'scale-100'); t.classList.replace('opacity-0', 'opacity-100'); 
            setTimeout(() => { t.classList.replace('scale-100', 'scale-0'); t.classList.replace('opacity-100', 'opacity-0'); }, 3000); 
        };

        let pendingConfirmCancelAction = null;

        window.resolveConfirmCancel = (confirmed) => {
            const modal = document.getElementById('modal-confirm-cancel');
            if (modal) modal.classList.add('hidden');
            const action = pendingConfirmCancelAction;
            pendingConfirmCancelAction = null;
            if (confirmed && typeof action === 'function') action();
        };

        function confirmCancel(message = 'Anda yakin ingin membatalkan?', onConfirm = null, confirmText = 'Ya, Batalkan') {
            const modal = document.getElementById('modal-confirm-cancel');
            const msg = document.getElementById('confirm-cancel-message');
            const yesBtn = document.getElementById('btn-confirm-cancel-yes');
            if (!modal || !msg || !yesBtn) {
                if (typeof onConfirm === 'function') onConfirm();
                return false;
            }

            pendingConfirmCancelAction = onConfirm;
            msg.innerText = message;
            yesBtn.innerText = confirmText;
            yesBtn.onclick = () => window.resolveConfirmCancel(true);
            modal.classList.remove('hidden');
            return false;
        }

        function normalizeCodePart(value) {
            return (value || '').toString().trim().replace(/\s+/g, '').toUpperCase();
        }

        function ensureHashCode(value, fallback = '') {
            const code = normalizeCodePart(value || fallback);
            if (!code) return normalizeCodePart(fallback);
            return code.startsWith('#') ? code : `#${code}`;
        }

        // Helper konsisten untuk ambil fullCode dari DOM row varian
        function getVariantFullCodeFromRow(row) {
            const albumBox = row.closest('.album-box') || row.closest('[id^="album-"]');
            const albumRaw = albumBox?.querySelector('.album-code')?.value || '';
            const varRaw   = row.querySelector('.v-code')?.value || '';
            const albumCode = ensureHashCode(albumRaw);
            const varCode   = normalizeCodePart(varRaw).replace(/^#/, '');
            if (albumCode && varCode) return `${albumCode}${varCode}`;
            if (albumCode) return albumCode;
            if (varCode) return `#${varCode}`;
            return '';
        }

        function buildProductOrderCode(album, variant, fallback = 'VAR') {
            const albumCode = ensureHashCode(album?.code || '');
            const variantCode = normalizeCodePart(variant?.code || '');
            if (variant?.fromSimpleAlbum) return albumCode || ensureHashCode(variantCode || fallback);
            if (albumCode && variantCode) return `${albumCode}${variantCode.replace(/^#/, '')}`;
            if (albumCode) return albumCode;
            if (variantCode) return ensureHashCode(variantCode);
            return ensureHashCode(fallback);
        }

        function buildSosmedOrderCode(service, tier, fallback = 'SOS') {
            const serviceCode = ensureHashCode(service?.code || '');
            const tierCode = normalizeCodePart(tier?.code || '');
            if (serviceCode && tierCode) return `${serviceCode}${tierCode.replace(/^#/, '')}`;
            if (serviceCode) return serviceCode;
            if (tierCode) return ensureHashCode(tierCode);
            return ensureHashCode(fallback);
        }

 window.hideOverlay = () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) { overlay.style.opacity = '0'; setTimeout(() => overlay.style.display = 'none', 500); }
};

function safeStartListening() {
    if (hasStartedListening) return;
    hasStartedListening = true;
    startListening();
}

window.addEventListener('error', function(e) {
    console.error('JS ERROR:', e.message, e.filename, e.lineno, e.colno);
    hideOverlay();
});

window.addEventListener('unhandledrejection', function(e) {
    console.error('PROMISE ERROR:', e.reason);
    hideOverlay();
});

setTimeout(() => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && overlay.style.display !== 'none') {
        console.warn('Loading terlalu lama, overlay dipaksa hilang.');
        hideOverlay();
    }
}, 8000);

// --- FLOATING BUTTONS ---
function updateFloatingButtons() {
    const homeBtn = document.getElementById('floating-home-btn');
    const topBtn = document.getElementById('scroll-top-btn');
    const adminView = document.getElementById('admin-view');
    const isAdminViewOpen = adminView && !adminView.classList.contains('hidden');

    if (homeBtn) {
        const shouldShowHome = !isAdminViewOpen && !!activeCat;
        homeBtn.classList.toggle('is-hidden', !shouldShowHome);
    }

    if (topBtn) {
        const shouldShowTop = !isAdminViewOpen && !!activeProd;
        topBtn.classList.toggle('is-hidden', !shouldShowTop);
    }
}


window.openFeaturedProduct = (cat, pid, event) => {
    if (event) event.preventDefault();

    changeCategory(cat);

    setTimeout(() => {
        changeProduct(pid);

        setTimeout(() => {
            const detailBox = document.querySelector('.product-detail-box');
            const sectionForm = document.getElementById('section-form');

            if (detailBox) {
                detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (sectionForm) {
                sectionForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 120);
    }, 120);
};

window.floatingHome = () => {
    // Jika sedang di detail produk, Home balik ke daftar produk kategori yang sedang aktif.
    // Setelah itu scroll ke bagian "Pilih Produk" agar langsung terlihat.
    if (activeCat) {
        activeProd = null;
        activeVar = null;
        activeAlbum = null;
        activeOrderType = 'none';
        currentSocialService = null;
        currentSocialTier = null;
        socialPrice = 0;

        document.getElementById('section-prod').classList.remove('hidden');
        document.getElementById('section-form').classList.add('hidden');
        document.getElementById('bottom-bar').classList.add('hidden');

        const oldDesc = document.getElementById('prod-desc');
        if (oldDesc) oldDesc.classList.remove('hidden');

        refreshCategoryUI();
        updateFloatingButtons();

        setTimeout(() => {
            const productSection = document.getElementById('section-prod');
            if (productSection) productSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);

        return;
    }

    resetToHome();
    updateFloatingButtons();
};

window.scrollToProductDetail = () => {
    const detailBox = document.querySelector('.product-detail-box');
    const sectionForm = document.getElementById('section-form');

    if (activeProd && detailBox) {
        detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }

    if (sectionForm && !sectionForm.classList.contains('hidden')) {
        sectionForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

window.addEventListener('scroll', updateFloatingButtons, { passive: true });

// --- DATA LISTENER (REST polling) ---
        let _pollingInterval = null;
        async function startListening() {
            async function fetchProducts() {
                try {
                    // Snapshot state SEBELUM fetch, agar tidak hilang saat data loading
                    const snapshotActiveProdId = activeProd ? activeProd.id : null;
                    const snapshotActiveProdCat = activeProd ? activeProd.category : null;

                    const path = `artifacts/${appId}/public/data/products`;
                    const items = await fsList(path);

                    // Pastikan items valid sebelum reset storeData
                    if (!items || items.length === 0) {
                        // Kalau response kosong/error, jangan reset tampilan
                        hideOverlay();
                        return;
                    }

                    storeData.topup.items = []; storeData.sosmed.items = []; storeData.premium.items = []; storeData.lainnya.items = [];
                    items.forEach(item => {
                        if (item && storeData[item.category]) storeData[item.category].items.push(item);
                    });
                    renderPromoHome();
                    renderBestSellerHome();
                    updateAdminStats();

                    // Jika ada modal terbuka atau sedang buka produk, jangan reset tampilan
                    const anyModalOpen = document.querySelector('.fixed:not(.hidden)[id^="modal"]') !== null;

                    // Gunakan snapshot id untuk cari produk yang aktif (lebih aman dari race condition)
                    if (snapshotActiveProdId && snapshotActiveProdCat) {
                        const updated = storeData[snapshotActiveProdCat]?.items.find(x => x.id === snapshotActiveProdId) || null;
                        if (updated) {
                            activeProd = updated;
                            // Jangan panggil refreshCategoryUI agar tampilan tidak hilang
                        } else if (!anyModalOpen) {
                            // Produk tidak ada lagi (dihapus admin), baru reset ke daftar kategori
                            activeProd = null;
                            if (activeCat) refreshCategoryUI();
                        }
                    } else if (!anyModalOpen && activeCat) {
                        refreshCategoryUI();
                    }

                    if (globalSearchQuery) searchProducts();
                    if (isAdmin) renderAdminProducts();

                    // Halaman kategori: buka otomatis kategori-nya sekali, saat data pertama siap.
                    if (IS_CATEGORY_PAGE && !_categoryOpened && !globalSearchQuery) {
                        _categoryOpened = true;
                        openCategoryPage();
                    }

                    hideOverlay();
                } catch (error) {
                    console.error("Firestore Error:", error);
                    hideOverlay();
                }
            }
            await fetchProducts();
            if (_pollingInterval) clearInterval(_pollingInterval);
            _pollingInterval = setInterval(fetchProducts, 30000);
        }
        // --- AUTH LOGIC (REST) ---
        // Cek token admin dari localStorage
        (async () => {
            try {
                isAdmin = false;
                document.getElementById('admin-indicator').classList.replace('flex', 'hidden');
                document.getElementById('login-trigger').classList.remove('hidden');
                safeStartListening();
            } catch (err) {
                console.error("Init Error:", err);
                hideOverlay();
            }
        })();


        function getCategoryLabel(cat) {
            const labels = {
                topup: 'Game',
                sosmed: 'Sosmed',
                premium: 'Premium',
                lainnya: 'Lainnya'
            };
            return labels[cat] || cat;
        }

        // Halaman kategori: tampilkan langsung daftar produk kategori ini (tanpa kartu kategori).
        function openCategoryPage() {
            if (!PAGE_CAT) return;
            activeCat = PAGE_CAT;
            activeProd = null; activeVar = null; activeAlbum = null; activeOrderType = 'none';
            refreshCategoryUI();
            const sp = document.getElementById('section-prod');
            const sf = document.getElementById('section-form');
            if (sp) sp.classList.remove('hidden');
            if (sf) sf.classList.add('hidden');
            const bb = document.getElementById('bottom-bar');
            if (bb) bb.classList.add('hidden');
            updateFloatingButtons();
        }

        // --- USER ACTIONS ---
        window.resetToHome = () => {
            // Di halaman kategori, "reset" = kembali ke daftar produk kategori (bukan kosong).
            if (IS_CATEGORY_PAGE) {
                const searchInput = document.getElementById('product-search-input');
                if (searchInput) searchInput.value = '';
                globalSearchQuery = '';
                openCategoryPage();
                return;
            }
            activeCat = null; activeProd = null; activeVar = null; activeAlbum = null; activeOrderType = 'none'; activeAlbum = null; activeAlbum = null; globalSearchQuery = ''; const searchInput = document.getElementById('product-search-input'); if (searchInput) searchInput.value = '';
            document.querySelectorAll('.cat-card').forEach(el => el.classList.remove('selected-item'));
            document.getElementById('section-prod').classList.add('hidden');
            document.getElementById('section-form').classList.add('hidden');
            const oldDesc = document.getElementById('prod-desc');
            if (oldDesc) oldDesc.classList.remove('hidden');
            document.getElementById('bottom-bar').classList.add('hidden');
            updateFloatingButtons();
            /* Auto-scroll dimatikan */
        };

        window.changeCategory = (c, event) => {
            if (event) event.preventDefault();

            activeCat = c;
            activeProd = null;
            activeVar = null;
            activeAlbum = null;
            activeOrderType = 'none';

            document.querySelectorAll('.cat-card').forEach(el => el.classList.remove('selected-item'));
            const btn = document.getElementById('btn-' + c);
            if (btn) btn.classList.add('selected-item');

            refreshCategoryUI();

            document.getElementById('section-prod').classList.remove('hidden');
            document.getElementById('section-form').classList.add('hidden');
            document.getElementById('bottom-bar').classList.add('hidden');

            const oldDesc = document.getElementById('prod-desc');
            if (oldDesc) oldDesc.classList.remove('hidden');

            updateFloatingButtons();

            setTimeout(() => {
                const productSection = document.getElementById('section-prod');
                if (productSection) {
                    productSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 80);
        };

        window.refreshCategoryUI = () => {
            // Jika sedang buka produk atau ada modal terbuka, jangan reset tampilan
            if (activeProd) return;
            const modalCheckout = document.getElementById('modal-checkout');
            if (modalCheckout && !modalCheckout.classList.contains('hidden')) return;
            const l = document.getElementById('list-prod'); l.innerHTML = '';
            l.className = "grid grid-cols-2 gap-4";
            if(!activeCat) return; 
            const items = storeData[activeCat].items;
            if (items.length === 0) { l.innerHTML = `<p class="col-span-2 text-center text-slate-400 py-10 text-[10px] font-bold">Produk kosong.</p>`; return; }
            items.forEach(p => { 
                l.innerHTML += `<div onclick=\"window.changeProduct('${p.id}', event)\" class="product-card-enhanced bg-white p-4 rounded-[2rem] border shadow-sm flex flex-col items-center cursor-pointer active:scale-95 transition-all">
                    ${p.bestSeller ? '<div class="best-seller-badge">Terlaris</div>' : ''}
                    <div class="img-container w-full mb-2"><img src="${getOptimizedUrl(p.imageUrl)}" class="w-full h-full object-cover"></div>
                    <span class="font-black text-slate-800 text-[9px] text-center uppercase truncate w-full px-1">${p.name}</span>
                    <div class="mt-1.5 bg-indigo-50 text-indigo-600 text-[7px] font-black px-3 py-1 rounded-full uppercase">Pilih</div>
                </div>`; 
            }); 
        };

        window.changeProduct = (pid, event) => {
            if (event) event.preventDefault();
            activeProd = storeData[activeCat].items.find(x => x.id === pid); 
            if (!activeProd) return;

            const list = document.getElementById('list-prod');
            list.className = "block";

            const descText = activeProd.description || 'Layanan Terbaik Everastore';

            list.innerHTML = `
                <div class="product-detail-box">
                    <div class="product-logo-card bg-white p-6 rounded-[2.5rem] border-2 selected-item flex flex-col items-center">
                        <div class="img-container w-full mb-3">
                            <img src="${getOptimizedUrl(activeProd.imageUrl)}" class="w-full h-full object-cover">
                        </div>
                        <span class="font-black text-slate-800 text-[10px] uppercase text-center">${activeProd.name}</span>
                    </div>

                    <div class="product-desc-card">
                        ${descText}
                    </div>
                </div>
            `;

            const oldDesc = document.getElementById('prod-desc');
            if (oldDesc) oldDesc.classList.add('hidden');

            const isSosmed = activeProd.category === 'sosmed';
            document.getElementById('list-var').classList.toggle('hidden', isSosmed);
            document.getElementById('sosmed-controls').classList.toggle('hidden', !isSosmed);

            if(isSosmed) {
                const sel = document.getElementById('sosmed-service-select');
                const activeServices = (activeProd.subServices || [])
                    .map((s, i) => ({ service: s, index: i }))
                    .filter(entry => entry.service.active !== false);

                sel.innerHTML = activeServices.map(entry => `<option value="${entry.index}">${entry.service.name}</option>`).join('');
                document.getElementById('sosmed-qty').value = ''; 
                socialPrice = 0; 
                updateSosmedPrice();
            } else {
                renderAlbums();
            }

            document.getElementById('section-form').classList.remove('hidden'); 
            document.getElementById('bottom-bar').classList.remove('hidden'); 
            updateFloatingButtons();
            // Auto-scroll detail/form dimatikan
        };

        function renderAlbums() {
            const listVar = document.getElementById('list-var');
            listVar.innerHTML = '';
            if(!activeProd || !activeProd.albums) return;

            const activeAlbums = activeProd.albums
                .map((album, aIdx) => ({ album, aIdx }))
                .filter(entry => {
                    if (entry.album.active === false) return false;
                    if (entry.album.mode === 'simple') return true;
                    return (entry.album.items || []).some(v => v.active !== false);
                });

            if (activeAlbums.length === 0) {
                listVar.innerHTML = `<p class="text-center text-slate-400 py-8 text-[10px] font-bold uppercase">Belum ada varian aktif.</p>`;
                return;
            }

            const navHtml = `
                <div class="album-jump-nav">
                    ${activeAlbums.map(({ album, aIdx }) => `
                        <button type="button" onclick="scrollToAlbum('${aIdx}')" class="album-jump-btn">
                            ${album.name || `Album ${aIdx + 1}`}
                        </button>
                    `).join('')}
                </div>
            `;

            let albumSectionsHtml = '';

            activeAlbums.forEach(({ album, aIdx }) => {
                let itemsHtml = '';

                if (album.mode === 'simple') {
                    const price = Number(album.p || album.price || 0);
                    const vid = `${aIdx}-album`;
                    itemsHtml += `
                    <div onclick="setVar('${vid}', ${price})" id="v-${vid}" class="var-item bg-white p-5 rounded-[2rem] border flex justify-between items-center cursor-pointer transition-all active:scale-[0.98]">
                        <div class="flex items-center gap-3">
                            <div class="check-icon hidden w-5 h-5 bg-indigo-600 rounded-full items-center justify-center flex-shrink-0"><i class="fas fa-check text-white text-[8px]"></i></div>
                            <div>
                                <span class="text-[11px] font-black text-slate-800 block uppercase">${album.name}</span>
                                <span class="text-[8px] font-bold text-slate-400 uppercase tracking-widest">${album.desc || 'Tersedia'}</span>
                            </div>
                        </div>
                        <div class="text-right">
                            <span class="text-[12px] font-black text-indigo-600">Rp ${price.toLocaleString('id-ID')}</span>
                            ${album.promo ? '<br><span class="promo-badge inline-block scale-75 origin-right mt-1">PROMO</span>' : ''}
                        </div>
                    </div>`;
                } else {
                    (album.items || []).forEach((v, iIdx) => {
                        if (v.active === false) return;
                        const vid = `${aIdx}-${iIdx}`;
                        itemsHtml += `
                        <div onclick="setVar('${vid}', ${v.p})" id="v-${vid}" class="var-item bg-white p-5 rounded-[2rem] border flex justify-between items-center cursor-pointer transition-all active:scale-[0.98]">
                            <div class="flex items-center gap-3">
                                <div class="check-icon hidden w-5 h-5 bg-indigo-600 rounded-full items-center justify-center flex-shrink-0"><i class="fas fa-check text-white text-[8px]"></i></div>
                                <div>
                                    <span class="text-[11px] font-black text-slate-800 block uppercase">${v.n}</span>
                                    <span class="text-[8px] font-bold text-slate-400 uppercase tracking-widest">${v.desc || 'Tersedia'}</span>
                                </div>
                            </div>
                            <div class="text-right">
                                <span class="text-[12px] font-black text-indigo-600">Rp ${Number(v.p || 0).toLocaleString('id-ID')}</span>
                                ${v.promo ? '<br><span class="promo-badge inline-block scale-75 origin-right mt-1">PROMO</span>' : ''}
                            </div>
                        </div>`;
                    });
                }

                if (itemsHtml) {
                    albumSectionsHtml += `
                        <div id="album-section-${aIdx}" class="album-anchor-card">
                            <h3 class="text-[9px] font-black text-indigo-400 uppercase mb-3 pl-2">${album.name}</h3>
                            <div class="space-y-3">${itemsHtml}</div>
                        </div>`;
                }
            });

            listVar.innerHTML = navHtml + albumSectionsHtml;
        }

        window.scrollToAlbum = (albumIndex) => {
            const target = document.getElementById(`album-section-${albumIndex}`);
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        window.setVar = (id, price) => {
            document.querySelectorAll('.var-item').forEach(el => el.classList.remove('selected-item'));
            const target = document.getElementById('v-'+id);
            if(target) target.classList.add('selected-item');

            const finalPrice = Number(price || 0);
            document.getElementById('txt-price').innerText = `Rp ${finalPrice.toLocaleString('id-ID')}`;

            const [a, i] = id.split('-');
            if (activeProd && activeProd.albums && activeProd.albums[a]) {
                activeAlbum = activeProd.albums[a];

                if (i === 'album' || activeAlbum.mode === 'simple') {
                    activeVar = {
                        n: activeAlbum.name || 'Paket',
                        code: (activeAlbum.code || '').toString().toUpperCase(),
                        p: Number(activeAlbum.p || activeAlbum.price || 0),
                        desc: activeAlbum.desc || '',
                        loginType: 'inherit',
                        promo: !!activeAlbum.promo,
                        active: activeAlbum.active !== false,
                        fromSimpleAlbum: true
                    };
                    activeVar._resolvedCode = buildProductOrderCode(activeAlbum, activeVar, 'VAR');
                    activeOrderType = resolveOrderType(activeVar.loginType || 'inherit', activeAlbum.loginType || 'none');
                    return;
                }

                if (activeAlbum.items && activeAlbum.items[i]) {
                    activeVar = activeAlbum.items[i];
                    activeVar._resolvedCode = buildProductOrderCode(activeAlbum, activeVar, 'VAR');
                    activeOrderType = resolveOrderType(activeVar.loginType || 'inherit', activeAlbum.loginType || 'none');
                    return;
                }
            }

            activeVar = null;
            activeAlbum = null;
            activeOrderType = 'none';
        };

window.updateSosmedPrice = () => {
    const select = document.getElementById('sosmed-service-select'); 
    if (!select || !select.value) return;

    const qtyInput = document.getElementById('sosmed-qty'); 
    const qty = parseInt(qtyInput.value) || 0;

    const service = activeProd.subServices[select.value]; 
    currentSocialService = service;

    if (qty > 0 && service) {
        const sorted = [...service.rateList].sort((a, b) => a.min - b.min);

        let selectedTier = sorted[0];

        const tier = sorted.find(r => qty >= r.min && qty <= r.max);

        if (tier) {
            selectedTier = tier;
        } else {
            const h = sorted.filter(r => qty >= r.min).pop();
            if (h) selectedTier = h;
        }

        currentSocialTier = selectedTier;

        const rate = selectedTier.price;
        socialPrice = Math.round(qty * rate);

        document.getElementById('txt-price').innerText = `Rp ${socialPrice.toLocaleString('id-ID')}`;
        document.getElementById('sosmed-price-hint').innerText = `Harga: Rp ${rate.toLocaleString('id-ID')}/unit`;
        document.getElementById('sosmed-price-info').classList.remove('hidden');
    } else {
        socialPrice = 0; 
        currentSocialTier = null;

        document.getElementById('txt-price').innerText = `Rp 0`;
        document.getElementById('sosmed-price-info').classList.add('hidden');
    }
};

        function updateCheckoutTotal(basePrice) {
            const qtyInput = document.getElementById('final-qty'); if(!qtyInput) return;
            const qty = parseInt(qtyInput.value) || 0;

            const btnCheckout = document.getElementById('btn-confirm-checkout');
            const totalPriceEl = document.getElementById('checkout-total-price');

            if (qty <= 0) {
                // Disable tombol checkout jika quantity 0 atau kosong
                if (btnCheckout) {
                    btnCheckout.disabled = true;
                    btnCheckout.classList.add('opacity-50', 'cursor-not-allowed');
                }
                if (totalPriceEl) totalPriceEl.innerText = `Rp 0`;
            } else {
                // Enable tombol checkout
                if (btnCheckout) {
                    btnCheckout.disabled = false;
                    btnCheckout.classList.remove('opacity-50', 'cursor-not-allowed');
                }
                if (totalPriceEl) totalPriceEl.innerText = `Rp ${(basePrice * qty).toLocaleString('id-ID')}`;
            }

            const unitLabel = document.getElementById('checkout-unit-price');
            if (unitLabel) unitLabel.innerText = `Rp ${basePrice.toLocaleString('id-ID')} / pesanan`;
        }

        function normalizeOrderType(type) {
            const t = (type || 'none').toString().toLowerCase();
            if (t === 'inherit' || t === 'album' || t === 'default') return 'inherit';
            if (t === 'polos') return 'none';
            if (t === 'invite') return 'link';
            if (t === 'id+server' || t === 'id_server' || t === 'id-server') return 'idserver';
            if (t === 'emailpw' || t === 'email+password' || t === 'email-password') return 'login';
            return t;
        }

        function resolveOrderType(variantType, albumType = 'none') {
            const vType = normalizeOrderType(variantType || 'inherit');
            if (vType === 'inherit') return normalizeOrderType(albumType || 'none');
            return vType;
        }

        function getOrderTypeLabel(type) {
            const labels = {
                inherit: 'Ikuti Album',
                none: 'Polos',
                id: 'ID',
                idserver: 'ID + Server',
                email: 'Email',
                login: 'Email + Password',
                link: 'Link'
            };
            return labels[normalizeOrderType(type)] || 'Polos';
        }

        function getRequiredMessage(type) {
            const t = normalizeOrderType(type);
            if (t === 'id') return 'Masukkan ID terlebih dahulu';
            if (t === 'idserver') return 'Masukkan ID dan server terlebih dahulu';
            if (t === 'email') return 'Masukkan email terlebih dahulu';
            if (t === 'login') return 'Masukkan email dan password terlebih dahulu';
            if (t === 'link') return 'Masukkan link terlebih dahulu';
            return '';
        }

        function getCheckoutFieldsHtml(loginType) {
            const t = normalizeOrderType(loginType);

            if (t === 'none') {
                return '';
            }

            if (t === 'id') {
                return '<input id="final-id" placeholder="ID Akun" class="w-full bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none">';
            }

            if (t === 'idserver') {
                return '<div class="grid grid-cols-2 gap-2"><input id="final-id" placeholder="ID Akun" class="bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none"><input id="final-server" placeholder="Server" class="bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none"></div>';
            }

            if (t === 'email') {
                return '<input id="final-email" type="email" placeholder="Email" class="w-full bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none">';
            }

            if (t === 'login') {
                return '<div class="grid grid-cols-2 gap-2"><input id="final-acc" type="email" placeholder="Email" class="bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none"><input id="final-pw" type="password" placeholder="Password" class="bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none"></div>';
            }

            if (t === 'link') {
                return '<input id="final-invite" placeholder="Link" class="w-full bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none">';
            }

            return '';
        }

        function setupCheckoutValidation(loginType) {
            const btn = document.getElementById('btn-confirm-checkout');
            if (!btn) return;

            // Tombol tetap bisa ditekan agar validasi di confirmCheckout bisa menampilkan teks wajib isi.
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }

        // --- CHECKOUT MODAL ---
        window.openCheckoutModal = () => {
            let varName, price, loginType, quantityInputHtml = '';

            if (activeProd.category === 'sosmed') {
                const qty = parseInt(document.getElementById('sosmed-qty').value) || 0;
                if(!qty || socialPrice <= 0) { showToast("ISI JUMLAH!"); return; }
                varName = currentSocialService.name;
                price = socialPrice;
                loginType = resolveOrderType(currentSocialTier?.loginType || 'inherit', currentSocialService?.loginType || 'none');
            } else {
                if (!activeVar) { showToast("PILIH VARIAN!"); return; }

                const album = activeAlbum || activeProd.albums.find(a => a.items && a.items.includes(activeVar));
                const basePrice = parseFloat(activeVar.p) || 0;

                varName = activeVar.n;
                price = basePrice;

                // Varian akan mengikuti tipe album jika tipe varian = inherit / belum diatur.
                // Jika varian punya tipe khusus, tipe varian akan dipakai.
                loginType = resolveOrderType(activeVar.loginType || 'inherit', album ? album.loginType : 'none');
                activeOrderType = loginType;

                if (activeProd.category === 'premium') {
                    quantityInputHtml = `
                        <div class="space-y-2">
                            <label class="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] block">Jumlah Pesanan</label>
                            <input id="final-qty" type="number" value="1" class="w-full bg-slate-50 p-3 rounded-xl border text-xs font-bold outline-none">
                            <p id="checkout-unit-price" class="text-[9px] text-indigo-600 font-black uppercase">Rp ${basePrice.toLocaleString('id-ID')} / pesanan</p>
                        </div>`;
                }
            }

            const authFieldsHtml = getCheckoutFieldsHtml(loginType);
            const content = document.getElementById('modal-check-content');

            content.innerHTML = `
                <div class="bg-indigo-50/50 p-4 rounded-[1.5rem] flex items-center gap-4">
                    <img src="${getOptimizedUrl(activeProd.imageUrl)}" class="w-12 h-12 rounded-xl object-cover bg-white">
                    <div class="min-w-0">
                        <p class="text-[9px] font-black text-indigo-400 uppercase truncate">${activeProd.name}</p>
                        <p class="text-xs font-black text-slate-800 uppercase truncate">${varName}</p>
                        <p class="text-[8px] font-black text-slate-400 uppercase mt-1">Tipe: ${getOrderTypeLabel(loginType)}</p>
                    </div>
                </div>
                <div class="space-y-4">
                    ${authFieldsHtml}
                    ${quantityInputHtml}
                    <textarea id="final-note" placeholder="Catatan tambahan (Opsional)" class="w-full bg-slate-50 p-3 rounded-xl border text-xs font-bold h-20 resize-none outline-none"></textarea>
                </div>
                <div class="pt-4 border-t flex justify-between items-center"><span class="text-[9px] font-black text-slate-400 uppercase">Total:</span><span id="checkout-total-price" class="text-lg font-black text-indigo-600">Rp ${price.toLocaleString('id-ID')}</span></div>
            `;

            document.getElementById('modal-checkout').classList.remove('hidden');
            updatePaymentButtons(); // Tampilkan/sembunyikan tombol bayar otomatis

            if (activeProd.category === 'premium') {
                updateCheckoutTotal(price);
                const qtyInput = document.getElementById('final-qty');
                if (qtyInput) {
                    qtyInput.addEventListener('input', () => updateCheckoutTotal(price));
                    qtyInput.addEventListener('change', () => updateCheckoutTotal(price));
                }
            }

            setupCheckoutValidation(loginType);
        };


        window.closeCheckoutModal = (skipConfirm = false) => {
            if (!skipConfirm) return confirmCancel('Anda yakin ingin membatalkan checkout ini?', () => window.closeCheckoutModal(true));
            document.getElementById('modal-checkout').classList.add('hidden');
        };

        window.confirmCheckout = () => {
            let note = "";
            const fid = document.getElementById('final-id');
            const fsv = document.getElementById('final-server');
            const femail = document.getElementById('final-email');
            const fac = document.getElementById('final-acc');
            const fpw = document.getElementById('final-pw');
            const finv = document.getElementById('final-invite');

            const checkoutType = activeProd.category === 'sosmed'
                ? resolveOrderType(currentSocialTier?.loginType || 'inherit', currentSocialService?.loginType || 'none')
                : resolveOrderType(activeVar?.loginType || 'inherit', activeAlbum?.loginType || 'none');

            if (checkoutType === 'id' && (!fid || !fid.value.trim())) {
                showToast("Masukkan ID terlebih dahulu");
                return;
            }

            if (checkoutType === 'idserver' && (!fid || !fid.value.trim() || !fsv || !fsv.value.trim())) {
                showToast("Masukkan ID dan server terlebih dahulu");
                return;
            }

            if (checkoutType === 'email' && (!femail || !femail.value.trim())) {
                showToast("Masukkan email terlebih dahulu");
                return;
            }

            if (checkoutType === 'login' && (!fac || !fac.value.trim() || !fpw || !fpw.value.trim())) {
                showToast("Masukkan email dan password terlebih dahulu");
                return;
            }

            if (checkoutType === 'link' && (!finv || !finv.value.trim())) {
                showToast("Masukkan link terlebih dahulu");
                return;
            }

            if ((checkoutType === 'id' || checkoutType === 'idserver') && fid && fid.value) {
                note += `[ID: ${fid.value}]`;
                if (checkoutType === 'idserver') note += ` [Server: ${fsv.value}]`;
            }

            if (checkoutType === 'email' && femail && femail.value) {
                note += `[Email: ${femail.value}]`;
            }

            if (checkoutType === 'login' && fac && fac.value) {
                note += `[Email: ${fac.value}] [PW: ${fpw.value}]`;
            }

            if (checkoutType === 'link' && finv && finv.value) {
                note += `[Link: ${finv.value}]`;
            }

            const prodCode = activeProd.category === 'sosmed' 
                ? buildSosmedOrderCode(currentSocialService, currentSocialTier, 'SOS') 
                : buildProductOrderCode(activeAlbum, activeVar, 'VAR');

            const qty = activeProd.category === 'sosmed'
                ? document.getElementById('sosmed-qty').value
                : activeProd.category === 'premium'
                    ? document.getElementById('final-qty')?.value || 1
                    : 1;

            // Validasi quantity untuk kategori premium
            if (activeProd.category === 'premium') {
                const qtyNum = parseInt(qty) || 0;
                if (qtyNum <= 0) {
                    showToast("Jumlah pesanan harus lebih dari 0!");
                    return;
                }
            }

            const addNote = document.getElementById('final-note')?.value;
            if(addNote) note += (note ? " | " : "") + addNote;

            let itemName = activeProd.name || '-';
            let orderDetail = '-';
            let totalPrice = 0;

            if (activeProd.category === 'sosmed') {
                orderDetail = currentSocialService?.name || 'Layanan Sosmed';
                totalPrice = socialPrice || 0;
            } else {
                orderDetail = activeVar?.n || 'Paket';
                const basePrice = parseFloat(activeVar?.p) || 0;
                const finalQty = activeProd.category === 'premium' ? parseInt(qty) || 1 : 1;
                totalPrice = basePrice * finalQty;
            }

            const msg = `.buy ${prodCode}|${qty}|${note || '-'}
Produk: ${itemName}
Detail: ${orderDetail}
Tipe: ${getOrderTypeLabel(checkoutType)}
Total: Rp ${Number(totalPrice || 0).toLocaleString('id-ID')}`;

            window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank');
        };

        // --- ADMIN VIEW FUNCTIONS ---
        window.toggleAdminView = () => {
            const uv = document.getElementById('user-view'), av = document.getElementById('admin-view'), bb = document.getElementById('bottom-bar');
            const switchTxt = document.getElementById('txt-switch-view'), switchIcon = document.getElementById('switch-icon');
            if (av.classList.contains('hidden')) {
                uv.classList.add('hidden'); av.classList.remove('hidden'); bb.classList.add('hidden');
                switchTxt.innerText = "Katalog"; switchIcon.className = "fas fa-eye text-[10px] mr-1.5";
                renderAdminProducts(); updateAdminStats();
            } else {
                uv.classList.remove('hidden'); av.classList.add('hidden');
                switchTxt.innerText = "Dashboard"; switchIcon.className = "fas fa-tools text-[10px] mr-1.5";
                if(activeProd) bb.classList.remove('hidden');
            }
            updateFloatingButtons();
        };

        window.filterAdmin = (f) => {
            currentFilter = f;
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.id === 'tab-' + f);
                btn.classList.toggle('bg-white', btn.id !== 'tab-' + f);
                btn.classList.toggle('text-slate-400', btn.id !== 'tab-' + f);
            });
            renderAdminProducts();
        };

        window.renderAdminProducts = () => {
            const c = document.getElementById('admin-product-list'); c.innerHTML = '';
            const search = (document.getElementById('admin-search-input')?.value || '').toLowerCase().trim();
            const cats = currentFilter === 'all' ? ['topup', 'sosmed', 'premium', 'lainnya'] : [currentFilter];
            let count = 0;

            cats.forEach(cat => {
                storeData[cat].items
                    .filter(p => !search || (p.name || '').toLowerCase().includes(search) || (p.description || '').toLowerCase().includes(search))
                    .forEach(p => {
                        count++;
                        c.innerHTML += `
                        <div class="admin-card flex justify-between items-center">
                            <div class="flex items-center gap-3 min-w-0">
                                <img src="${getOptimizedUrl(p.imageUrl)}" class="w-10 h-10 rounded-lg object-cover flex-shrink-0">
                                <div class="min-w-0">
                                    <h3 class="font-black text-slate-800 text-[10px] uppercase truncate">${p.name}</h3>
                                    <div class="flex gap-1 mt-1 flex-wrap">
                                        <p class="text-[7px] text-slate-400 font-bold uppercase">${p.category}</p>
                                        ${p.bestSeller ? '<span class="text-[7px] font-black text-amber-500 uppercase">• Terlaris</span>' : ''}
                                    </div>
                                </div>
                            </div>
                            <div class="flex gap-2 flex-shrink-0">

                                <button onclick="window.editProduct('${p.category}', '${p.id}')" class="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center active:scale-90 transition-transform"><i class="fas fa-edit text-[10px]"></i></button>
                                <button onclick="window.deleteProduct('${p.id}')" class="w-8 h-8 bg-red-50 text-red-500 rounded-xl flex items-center justify-center active:scale-90 transition-transform"><i class="fas fa-trash text-[10px]"></i></button>
                            </div>
                        </div>`;
                    });
            });

            if (count === 0) {
                c.innerHTML = `<p class="text-center text-slate-400 py-8 text-[10px] font-bold uppercase">Produk tidak ditemukan.</p>`;
            }
        };

        // --- ADMIN CRUD ACTIONS ---
        window.openProductModal = () => { 
            currentEditId = null; 
            document.getElementById('modal-title').innerText = "TAMBAH PRODUK";
            document.getElementById('edit-name').value = ''; document.getElementById('edit-image').value = ''; 
            document.getElementById('edit-albums-container').innerHTML = ''; document.getElementById('edit-sosmed-container').innerHTML = ''; 
            document.getElementById('edit-desc').value = ''; document.getElementById('edit-best-seller').checked = false; toggleAdminBuilders(); 
            document.getElementById('modal-product').classList.remove('hidden'); 
            initDragula();
        };

        window.closeProductModal = (skipConfirm = false) => {
            if (!skipConfirm) return confirmCancel('Anda yakin ingin membatalkan perubahan produk ini?', () => window.closeProductModal(true));
            document.getElementById('modal-product').classList.add('hidden');
        };

        window.toggleAdminBuilders = () => {
            const cat = document.getElementById('edit-cat').value;
            document.getElementById('builder-albums').classList.toggle('hidden', cat === 'sosmed');
            document.getElementById('builder-sosmed').classList.toggle('hidden', cat !== 'sosmed');
        };

        window.toggleAlbumMode = (albumUid) => {
            const box = document.getElementById(albumUid);
            if (!box) return;

            const mode = box.querySelector('.album-mode')?.value || 'variant';
            const simpleFields = box.querySelector('.album-simple-fields');
            const itemsContainer = box.querySelector('.album-items-container');
            const addVariantBtn = box.querySelector('.btn-add-variant');

            if (simpleFields) simpleFields.classList.toggle('hidden', mode !== 'simple');
            if (itemsContainer) itemsContainer.classList.toggle('hidden', mode === 'simple');
            if (addVariantBtn) addVariantBtn.classList.toggle('hidden', mode === 'simple');
        };

        window.addAlbumField = (name = '', items = [], type = 'none', active = true, mode = 'variant', albumDesc = '', albumCode = '', albumPrice = '', albumPromo = false) => {
            const container = document.getElementById('edit-albums-container');
            const albumUid = 'alb-' + Math.random().toString(36).substr(2, 9);
            const albumType = normalizeOrderType(type || 'none');
            const albumMode = mode || 'variant';
            const div = document.createElement('div');
            div.id = albumUid;
            div.className = "album-box p-4 rounded-2xl border shadow-sm mb-4 space-y-3";
            div.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                    <div class="album-drag-handle" title="Geser album"><i class="fas fa-grip-vertical text-[10px]"></i></div>
                    <input type="text" placeholder="Nama Album" value="${name}" class="album-name flex-1 min-w-[100px] bg-white p-2 rounded-lg text-[10px] font-bold border">
                    <input type="text" placeholder="#KODE" value="${albumCode}" class="album-code w-20 bg-indigo-50 p-2 rounded-lg text-[8px] font-black border uppercase text-indigo-700" title="Kode awal album, contoh: #YT atau #WK">
                    <select class="album-mode bg-emerald-50 p-2 rounded-lg text-[8px] font-bold text-emerald-600" onchange="toggleAlbumMode('${albumUid}')" title="Jenis isi album">
                        <option value="variant" ${albumMode !== 'simple' ? 'selected' : ''}>Isi: Varian</option>
                        <option value="simple" ${albumMode === 'simple' ? 'selected' : ''}>Isi: Langsung</option>
                    </select>
                    <select class="album-type bg-slate-100 p-2 rounded-lg text-[8px] font-bold" title="Tipe default album">
                        <option value="none" ${albumType === 'none' ? 'selected' : ''}>Album: Polos</option>
                        <option value="id" ${albumType === 'id' ? 'selected' : ''}>Album: ID</option>
                        <option value="idserver" ${albumType === 'idserver' ? 'selected' : ''}>Album: ID+Server</option>
                        <option value="email" ${albumType === 'email' ? 'selected' : ''}>Album: Email</option>
                        <option value="login" ${albumType === 'login' ? 'selected' : ''}>Album: Email+PW</option>
                        <option value="link" ${albumType === 'link' ? 'selected' : ''}>Album: Link</option>
                    </select>
                    <label class="flex items-center gap-1 cursor-pointer select-none">
                        <input type="checkbox" ${active ? 'checked' : ''} class="album-active w-3 h-3">
                        <span class="text-[7px] font-black text-green-500 uppercase">Aktif</span>
                    </label>
                    <button onclick="this.closest('.album-box').remove()" class="text-red-400 p-1"><i class="fas fa-times"></i></button>
                </div>

                <div class="album-simple-fields ${albumMode === 'simple' ? '' : 'hidden'} space-y-2">
                    <p class="text-[7px] font-black text-emerald-600 uppercase">Mode langsung: album ini jadi item yang bisa dibeli tanpa daftar varian.</p>
                    <div class="grid grid-cols-2 gap-2">
                        <input type="number" placeholder="Harga" value="${albumPrice}" class="album-price bg-white p-2 rounded-lg text-[8px] font-bold border">
                        <label class="flex items-center gap-1 justify-center bg-white rounded-lg border text-[7px] font-black text-rose-500 uppercase">
                            <input type="checkbox" ${albumPromo ? 'checked' : ''} class="album-promo w-3 h-3"> Promo
                        </label>
                    </div>
                    <input type="text" placeholder="Keterangan" value="${albumDesc}" class="album-desc w-full bg-white p-2 rounded-lg text-[8px] font-bold border">
                </div>

                <p class="text-[7px] font-black text-slate-400 uppercase px-1">Kode album digabung dengan nomor/kode varian saat order. Contoh album #WK + varian 1 = #WK1.</p>
                <div class="album-items-container ${albumMode === 'simple' ? 'hidden' : ''} space-y-2 pl-2 border-l-2 border-indigo-50"></div>
                <button onclick="window.addItemToAlbum('${albumUid}')" class="btn-add-variant ${albumMode === 'simple' ? 'hidden' : ''} w-full py-1 border border-dashed rounded-lg text-[8px] font-black text-slate-400 uppercase">+ Varian</button>
            `;
            container.appendChild(div);

            if(items.length > 0) {
                items.forEach(i => {
                    const rawItemType = i.loginType || i.type || 'inherit';
                    const itemType = normalizeOrderType(rawItemType);
                    const finalType = (!i.loginType && !i.type) || itemType === albumType ? 'inherit' : itemType;
                    window.addItemToAlbum(albumUid, i.n, i.p, i.desc, i.promo, i.code, i.active, finalType);
                });
            } else if (albumMode !== 'simple') {
                window.addItemToAlbum(albumUid, '', '', '', false, '', true, 'inherit');
            }

            toggleAlbumMode(albumUid);
            setTimeout(initDragula, 50);
        };

        /* untuk membuat posisi album dan varian agar bisa di geser urutannya, gunakan library dragula (https://bevacqua.github.io/dragula/) dengan inisialisasi: dragula([document.querySelector('.album-items-container')], { moves: (el, container, handle) => handle.classList.contains('album-name') || handle.classList.contains('check-icon') });
        langkah pertama tambahkan class "album-name" di baris ke 2 pada input nama album, dan class "check-icon" di div check-icon pada setiap varian.
        sekarang cari input nama album atau icon check pada varian, ketik di pencarian kata 
        
        
        */
        window.addItemToAlbum = (albumUid, n='', p='', d='', promo=false, c='', active=true, type='inherit') => {
            const container = document.querySelector(`#${albumUid} .album-items-container`);
            if (!container) return;
            const autoNumber = container.querySelectorAll('.item-row').length + 1;
            const finalCode = c || autoNumber;
            const normalizedType = normalizeOrderType(type || 'inherit');
            const div = document.createElement('div');
            div.className = "item-row space-y-2 p-2 bg-slate-50 rounded-lg";
            div.innerHTML = `
                <div class="flex gap-1">
                    <div class="variant-drag-handle check-icon" title="Geser varian"><i class="fas fa-grip-vertical text-[9px]"></i></div>
                    <input type="text" placeholder="Varian" value="${n}" class="v-name flex-1 text-[9px] p-1 border rounded">
                    <input type="text" placeholder="NO" value="${finalCode}" class="v-code w-12 text-[9px] p-1 border rounded bg-indigo-50 font-bold uppercase">
                    <input type="number" placeholder="Harga" value="${p}" class="v-price w-16 text-[9px] p-1 border rounded">
                </div>
                <div class="flex gap-1">
                    <input type="text" placeholder="Ket" value="${d}" class="v-desc flex-1 text-[8px] p-1 border rounded">
                    <select class="v-type w-32 text-[8px] p-1 border rounded bg-white font-bold">
                        <option value="inherit" ${normalizedType === 'inherit' ? 'selected' : ''}>Ikuti Album</option>
                        <option value="none" ${normalizedType === 'none' ? 'selected' : ''}>Polos</option>
                        <option value="id" ${normalizedType === 'id' ? 'selected' : ''}>ID</option>
                        <option value="idserver" ${normalizedType === 'idserver' ? 'selected' : ''}>ID+Server</option>
                        <option value="email" ${normalizedType === 'email' ? 'selected' : ''}>Email</option>
                        <option value="login" ${normalizedType === 'login' ? 'selected' : ''}>Email+PW</option>
                        <option value="link" ${normalizedType === 'link' ? 'selected' : ''}>Link</option>
                    </select>
                </div>
                <div class="flex items-center gap-3">
                    <label class="flex items-center gap-1 cursor-pointer select-none">
                        <input type="checkbox" ${promo ? 'checked' : ''} class="v-promo w-3 h-3">
                        <span class="text-[7px] font-black text-rose-500 uppercase">Promo</span>
                    </label>
                    <label class="flex items-center gap-1 cursor-pointer select-none">
                        <input type="checkbox" ${active ? 'checked' : ''} class="v-active w-3 h-3">
                        <span class="text-[7px] font-black text-green-500 uppercase">Aktif</span>
                    </label>
                    <button onclick="this.closest('.item-row').remove()" class="text-red-300 px-1"><i class="fas fa-minus text-[9px]"></i></button>
                    <div class="ml-auto flex gap-1">
                        <button onclick="openVariantAutoPayToggle(this)" title="Toggle Payment Otomatis"
                            class="v-autopay-btn flex items-center gap-1 bg-slate-100 text-slate-400 px-2 py-1 rounded-lg text-[7px] font-black uppercase border border-slate-200 active:scale-95">
                            <i class="fas fa-bolt text-[8px]"></i> <span class="v-autopay-label">OFF</span>
                        </button>
                        <button onclick="openInlineStock(this)" title="Tambah/Lihat Stok Akun"
                            class="v-stock-btn flex items-center gap-1 bg-emerald-50 text-emerald-600 px-2 py-1 rounded-lg text-[7px] font-black uppercase border border-emerald-200 active:scale-95">
                            <i class="fas fa-box text-[8px]"></i> STOK
                        </button>
                    </div>
                </div>
                <div class="v-stock-panel hidden mt-2 p-3 bg-white rounded-xl border border-emerald-100 space-y-2">
                    <div class="flex gap-2 text-[8px] font-black uppercase text-slate-500">
                        <span>Stok: <span class="v-stock-count text-emerald-600">0</span></span>
                        <span>Terjual: <span class="v-sold-count text-indigo-600">0</span></span>
                    </div>
                    <!-- Insider Auto-Topup (hanya untuk kategori Game/topup) -->
                    <div class="v-insider-section hidden border-t border-slate-100 pt-2 space-y-2">
                        <div class="flex items-center justify-between">
                            <span class="text-[8px] font-black uppercase text-violet-600"><i class="fas fa-bolt mr-1"></i> Auto-topup Insider</span>
                            <button onclick="toggleInsiderAuto(this)" class="v-insider-toggle bg-slate-100 text-slate-400 px-2 py-1 rounded-lg text-[7px] font-black uppercase border border-slate-200 active:scale-95 transition-all">OFF</button>
                        </div>
                        <div>
                            <span class="v-insider-sku-label text-[7px] font-bold text-slate-400 uppercase">SKU: </span>
                            <span class="v-insider-sku-value text-[7px] font-black text-violet-600">—</span>
                        </div>
                        <button onclick="openInsiderPicker(this)" class="v-insider-pick-btn w-full bg-violet-50 text-violet-600 py-1.5 rounded-lg text-[7px] font-black uppercase border border-violet-200 active:scale-95">
                            <i class="fas fa-search mr-1"></i> Pilih dari Katalog Insider
                        </button>
                    </div>
                    <textarea class="v-stock-input w-full text-[8px] p-2 border rounded-lg font-mono resize-none" rows="3" placeholder="Satu baris = satu akun&#10;user@gmail.com|pass1&#10;user@gmail.com|pass2"></textarea>
                    <div class="flex gap-2">
                        <button onclick="addVariantStock(this)" class="flex-1 bg-emerald-500 text-white py-1.5 rounded-lg text-[8px] font-black uppercase active:scale-95">+ Tambah Stok</button>
                        <button onclick="clearVariantStock(this)" class="bg-red-50 text-red-400 px-3 py-1.5 rounded-lg text-[8px] font-black uppercase border border-red-200 active:scale-95">Hapus Semua</button>
                    </div>
                </div>`;
            container.appendChild(div);
            setTimeout(initDragula, 50);
        };

        window.addSosmedServiceField = (name = '', rateList = [], promo = false, code = '', type = 'none', active = true) => {
            const container = document.getElementById('edit-sosmed-container');
            const sid = 's-' + Math.random().toString(36).substr(2, 9);
            const serviceType = normalizeOrderType(type || 'none');
            const serviceCode = code || '';
            const div = document.createElement('div');
            div.id = sid;
            div.className = "sosmed-service-box p-4 rounded-2xl border shadow-sm mb-4 space-y-3";
            div.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                    <div class="service-drag-handle" title="Geser layanan sosmed"><i class="fas fa-grip-vertical text-[10px]"></i></div>
                    <input type="text" placeholder="Nama Layanan / Album Sosmed" value="${name}" class="s-name flex-1 bg-white p-2 rounded-lg text-[10px] font-bold border">
                    <input type="text" placeholder="#KODE" value="${serviceCode}" class="s-code w-20 bg-indigo-50 p-2 rounded-lg text-[8px] font-black border uppercase text-indigo-700" title="Kode awal layanan, contoh: #YT atau #WK">
                    <select class="s-type bg-slate-100 p-2 rounded-lg text-[8px] font-bold" title="Tipe default layanan sosmed">
                        <option value="none" ${serviceType === 'none' ? 'selected' : ''}>Layanan: Polos</option>
                        <option value="id" ${serviceType === 'id' ? 'selected' : ''}>Layanan: ID</option>
                        <option value="idserver" ${serviceType === 'idserver' ? 'selected' : ''}>Layanan: ID+Server</option>
                        <option value="email" ${serviceType === 'email' ? 'selected' : ''}>Layanan: Email</option>
                        <option value="login" ${serviceType === 'login' ? 'selected' : ''}>Layanan: Email+PW</option>
                        <option value="link" ${serviceType === 'link' ? 'selected' : ''}>Layanan: Link</option>
                    </select>
                    <label class="flex items-center gap-1 cursor-pointer select-none">
                        <input type="checkbox" ${promo ? 'checked' : ''} class="s-promo w-3 h-3">
                        <span class="text-[7px] font-black text-rose-500 uppercase">Promo</span>
                    </label>
                    <label class="flex items-center gap-1 cursor-pointer select-none">
                        <input type="checkbox" ${active ? 'checked' : ''} class="s-active w-3 h-3">
                        <span class="text-[7px] font-black text-green-500 uppercase">Aktif</span>
                    </label>
                    <button onclick="this.closest('.sosmed-service-box').remove()" class="text-red-400 p-1"><i class="fas fa-times"></i></button>
                </div>
                <p class="text-[7px] font-black text-slate-400 uppercase px-1">Kode layanan digabung dengan nomor/kode tier saat order. Contoh layanan #WK + tier 1 = #WK1. Tipe tier bisa mengikuti tipe layanan.</p>
                <div class="tier-container space-y-1 pl-2 border-l-2 border-indigo-50"></div>
                <button onclick="window.addTierRange('${sid}')" class="w-full py-1 border border-dashed rounded-lg text-[8px] font-black text-slate-400 uppercase">+ Tier</button>
            `;
            container.appendChild(div);

            if (rateList.length > 0) {
                rateList.forEach(r => window.addTierRange(sid, r.min, r.max, r.price, r.code, r.loginType || 'inherit'));
            } else {
                window.addTierRange(sid, 1, 500, '', '1', 'inherit');
                window.addTierRange(sid, 501, 1000, '', '2', 'inherit');
                window.addTierRange(sid, 1001, '', '', '3', 'inherit');
            }
            setTimeout(initDragula, 50);
        };

        window.addTierRange = (sid, min='', max='', price='', code='', type='inherit') => {
            const container = document.querySelector(`#${sid} .tier-container`);
            if (!container) return;
            const autoNumber = container.querySelectorAll('.tier-row').length + 1;
            const finalCode = code || autoNumber;
            const maxValue = (Number(max) >= 999999999) ? '' : max;
            const normalizedType = normalizeOrderType(type || 'inherit');
            const div = document.createElement('div');
            div.className = "tier-row flex flex-wrap gap-1 items-center bg-slate-50 rounded-lg p-2";

            div.innerHTML = `
                <div class="tier-drag-handle" title="Geser tier"><i class="fas fa-grip-vertical text-[8px]"></i></div>
                <input type="text" placeholder="KODE" value="${finalCode}" class="t-code w-14 bg-indigo-50 p-1 rounded text-[8px] font-black border uppercase text-indigo-700" title="Nomor/kode tier, contoh: 1">
                <input type="number" placeholder="Min" value="${min}" class="t-min w-12 text-[8px] p-1 border rounded">
                <input type="number" placeholder="Max / ∞" value="${maxValue}" class="t-max w-14 text-[8px] p-1 border rounded">
                <input type="number" placeholder="Harga" value="${price}" class="t-price flex-1 min-w-[70px] text-[8px] p-1 border rounded">
                <select class="t-type w-28 text-[8px] p-1 border rounded bg-white font-bold" title="Tipe tier">
                    <option value="inherit" ${normalizedType === 'inherit' ? 'selected' : ''}>Ikuti Layanan</option>
                    <option value="none" ${normalizedType === 'none' ? 'selected' : ''}>Polos</option>
                    <option value="id" ${normalizedType === 'id' ? 'selected' : ''}>ID</option>
                    <option value="idserver" ${normalizedType === 'idserver' ? 'selected' : ''}>ID+Server</option>
                    <option value="email" ${normalizedType === 'email' ? 'selected' : ''}>Email</option>
                    <option value="login" ${normalizedType === 'login' ? 'selected' : ''}>Email+PW</option>
                    <option value="link" ${normalizedType === 'link' ? 'selected' : ''}>Link</option>
                </select>
                <button onclick="this.parentElement.remove()" class="text-red-300 px-1"><i class="fas fa-minus text-[8px]"></i></button>
            `;

            container.appendChild(div);
            setTimeout(initDragula, 50);
        };

        window.saveProduct = async () => {
            const name = document.getElementById('edit-name').value;
            const cat = document.getElementById('edit-cat').value;
            if(!name) return showToast("ISI NAMA PRODUK!");
            
            const data = { 
                name, category: cat, 
                description: document.getElementById('edit-desc').value, 
                imageUrl: document.getElementById('edit-image').value,
                bestSeller: document.getElementById('edit-best-seller')?.checked || false,

                updatedAt: Date.now() 
            };

            if(cat === 'sosmed') {
                data.subServices = Array.from(document.querySelectorAll('.sosmed-service-box')).map(box => ({
                    name: box.querySelector('.s-name').value,
                    code: ensureHashCode(box.querySelector('.s-code')?.value || ''),
                    loginType: box.querySelector('.s-type').value,
                    promo: box.querySelector('.s-promo').checked,
                    active: box.querySelector('.s-active').checked,
                    rateList: Array.from(box.querySelectorAll('.tier-row')).map(row => ({
                        code: normalizeCodePart(row.querySelector('.t-code')?.value || ''),
                        min: parseInt(row.querySelector('.t-min').value) || 1,
                        max: row.querySelector('.t-max').value ? (parseInt(row.querySelector('.t-max').value) || 999999999) : 999999999,
                        price: parseInt(row.querySelector('.t-price').value) || 0,
                        loginType: row.querySelector('.t-type')?.value || 'inherit'
                    }))
                }));
            } else {
                data.albums = Array.from(document.querySelectorAll('.album-box')).map(box => {
                    const mode = box.querySelector('.album-mode')?.value || 'variant';
                    const albumData = {
                        name: box.querySelector('.album-name').value,
                        code: ensureHashCode(box.querySelector('.album-code')?.value || ''),
                        mode,
                        loginType: box.querySelector('.album-type').value,
                        active: box.querySelector('.album-active').checked
                    };

                    if (mode === 'simple') {
                        albumData.p = parseInt(box.querySelector('.album-price')?.value || 0) || 0;
                        albumData.desc = box.querySelector('.album-desc')?.value || '';
                        albumData.promo = box.querySelector('.album-promo')?.checked || false;
                        albumData.items = [];
                    } else {
                        albumData.items = Array.from(box.querySelectorAll('.item-row')).map(row => ({
                            n: row.querySelector('.v-name').value,
                            code: row.querySelector('.v-code').value.toUpperCase(),
                            p: parseInt(row.querySelector('.v-price').value) || 0,
                            desc: row.querySelector('.v-desc').value,
                            loginType: row.querySelector('.v-type')?.value || 'inherit',
                            promo: row.querySelector('.v-promo').checked,
                            active: row.querySelector('.v-active').checked
                        }));
                    }

                    return albumData;
                });
            }

            try {
                showToast("MENYIMPAN...");
                const pid = (currentEditId && currentEditId.pid) ? currentEditId.pid : `prod-${Date.now()}`;
                const path = `artifacts/${appId}/public/data/products`;
                await fsSet(path, pid, data);
                if (_pollingInterval) { clearInterval(_pollingInterval); }
                await startListening();
                closeProductModal(true); showToast("TERSIMPAN!");
            } catch (err) { console.error("Save error:", err); showToast("GAGAL SIMPAN!"); }
        };

        window.editProduct = (cat, pid) => {
            const p = storeData[cat].items.find(x => x.id === pid); if (!p) return;
            currentEditId = { cat, pid };
            document.getElementById('modal-title').innerText = "EDIT: " + p.name.toUpperCase();
            document.getElementById('edit-name').value = p.name || ''; document.getElementById('edit-image').value = p.imageUrl || ''; 
            document.getElementById('edit-cat').value = cat; document.getElementById('edit-desc').value = p.description || ''; document.getElementById('edit-best-seller').checked = !!p.bestSeller;
            toggleAdminBuilders();
            if(cat === 'sosmed') {
                document.getElementById('edit-sosmed-container').innerHTML = '';
                (p.subServices || []).forEach(s => window.addSosmedServiceField(s.name, s.rateList, s.promo, s.code, s.loginType, s.active));
            } else {
                document.getElementById('edit-albums-container').innerHTML = '';
                (p.albums || []).forEach(a => window.addAlbumField(a.name, a.items || [], a.loginType, a.active, a.mode || 'variant', a.desc || '', a.code || '', a.p || '', a.promo || false));
            }
            document.getElementById('modal-product').classList.remove('hidden');
            initDragula();
            // Load status autoPayment untuk semua varian
            setTimeout(() => loadAllVariantAutoPayStatus(pid), 500);
        };

        window.deleteProduct = (pid) => {
            const modal = document.getElementById('modal-confirm-delete');
            const btn = document.getElementById('btn-do-delete');
            modal.classList.remove('hidden');
            
            btn.onclick = async () => {
                try {
                    modal.classList.add('hidden');
                    showToast("MENGHAPUS...");
                    const path = `artifacts/${appId}/public/data/products`;
                    await fsDelete(path, pid);
                    if (_pollingInterval) { clearInterval(_pollingInterval); }
                    await startListening();
                    showToast("PRODUK TERHAPUS");
                } catch(e) { 
                    console.error("Delete failed:", e);
                    showToast("GAGAL HAPUS!"); 
                }
            };
        };

        window.closeDeleteModal = (skipConfirm = false) => {
            if (!skipConfirm) return confirmCancel('Anda yakin ingin membatalkan hapus produk ini?', () => window.closeDeleteModal(true));
            document.getElementById('modal-confirm-delete').classList.add('hidden');
        };

        window.handleImageUpload = async (input) => {
            const file = input.files[0]; if(!file) return;
            showToast("UPLOADING...");
            const fd = new FormData(); fd.append('file', file); fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
            try {
                const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: fd });
                const r = await res.json();
                if(r.secure_url) { document.getElementById('edit-image').value = r.secure_url; showToast("FOTO SIAP!"); }
            } catch(e) { showToast("UPLOAD GAGAL!"); }
        };

        window.handleAdminKey = (e) => { if (e.key === 'Enter') window.checkPassword(); };
        window.showLogin = () => isAdmin ? toggleAdminView() : document.getElementById('modal-login').classList.remove('hidden');
        window.hideLogin = (skipConfirm = false) => {
            if (!skipConfirm) return confirmCancel('Anda yakin ingin menutup login admin?', () => window.hideLogin(true), 'Ya, Tutup');
            document.getElementById('modal-login').classList.add('hidden');
        };
        function saveAdminToken(token, expiry) {
            localStorage.setItem('evr_admin_token', token);
            localStorage.setItem('evr_admin_expiry', (expiry || (Date.now() + 55*60*1000)).toString());
        }
        function getAdminToken() {
            const token = localStorage.getItem('evr_admin_token');
            const expiry = parseInt(localStorage.getItem('evr_admin_expiry') || '0');
            if (!token || Date.now() > expiry) {
                localStorage.removeItem('evr_admin_token');
                localStorage.removeItem('evr_admin_expiry');
                return null;
            }
            return token;
        }
        function clearAdminToken() {
            localStorage.removeItem('evr_admin_token');
            localStorage.removeItem('evr_admin_expiry');
        }

        window.checkPassword = async () => { 
            const email = document.getElementById('admin-email').value;
            const password = document.getElementById('admin-pw').value;
            showToast("MEMPROSES...");

            let loginSuccess = false;
            let loginToken = null;
            let loginExpiry = null;

            // Coba Firebase Auth dulu jika ada email
            if (email) {
                try {
                    await fbSignIn(email, password);
                    loginSuccess = true;
                    loginToken = _idToken;
                    loginExpiry = Date.now() + (55 * 60 * 1000);
                } catch (fbErr) {
                    console.log('[Login] Firebase gagal:', fbErr.message);
                }
            }

            // Fallback: ADMIN_PASSWORD via API
            if (!loginSuccess) {
                try {
                    const res = await fetch('/api/admin-login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password })
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                        loginSuccess = true;
                        loginToken = data.token;
                        loginExpiry = data.expiry;
                    }
                } catch (e) {
                    console.error('[Login] admin-login error:', e);
                }
            }

            if (loginSuccess && loginToken) {
                saveAdminToken(loginToken, loginExpiry);
                isAdmin = true;
                try { document.getElementById('admin-indicator').classList.replace('hidden', 'flex'); } catch(e){}
                try { document.getElementById('login-trigger').classList.add('hidden'); } catch(e){}
                try { hideLogin(true); } catch(e){}
                showToast("LOGIN BERHASIL!");
                try { toggleAdminView(); } catch(e){ console.error('[Login] toggleAdminView error:', e); }
            } else {
                showToast("SANDI SALAH!");
            }
        };
        window.logout = () => {
            confirmCancel('Anda yakin ingin logout admin?', async () => {
                fbSignOut();
                isAdmin = false;
                location.reload();
            }, 'Ya, Logout');
        };
        window.openHelpModal = () => {
            document.getElementById('modal-help').classList.remove('hidden');
            showHelpMenu();
        };

        window.closeHelpModal = (skipConfirm = false) => {
            if (!skipConfirm) return confirmCancel('Anda yakin ingin menutup bantuan?', () => window.closeHelpModal(true), 'Ya, Tutup');
            document.getElementById('modal-help').classList.add('hidden');
        };

        window.showHelpMenu = () => {
            document.querySelectorAll('.help-view').forEach(view => view.classList.remove('active'));
            document.getElementById('help-menu-view').classList.add('active');
            document.getElementById('help-modal-title').innerText = 'Bantuan / Help';
            const backBtn = document.getElementById('help-back-btn');
            backBtn.classList.add('hidden');
            backBtn.classList.remove('flex');
        };

        window.showHelpView = (type) => {
            document.querySelectorAll('.help-view').forEach(view => view.classList.remove('active'));

            const titles = {
                cara: 'Cara Order'
            };

            const target = document.getElementById(`help-${type}-view`);
            if (target) target.classList.add('active');

            document.getElementById('help-modal-title').innerText = titles[type] || 'Bantuan / Help';
            const backBtn = document.getElementById('help-back-btn');
            backBtn.classList.remove('hidden');
            backBtn.classList.add('flex');
        };



        // --- SEARCH, BEST SELLER, TESTIMONI, DASHBOARD ---
        window.searchProducts = () => {
            const input = document.getElementById('product-search-input');
            globalSearchQuery = (input?.value || '').toLowerCase().trim();

            if (!globalSearchQuery) {
                // Halaman kategori: query kosong = balik ke daftar produk kategori.
                if (IS_CATEGORY_PAGE) { openCategoryPage(); return; }
                document.getElementById('section-prod').classList.add('hidden');
                document.getElementById('section-form').classList.add('hidden');
                document.getElementById('bottom-bar').classList.add('hidden');
                return;
            }

            activeProd = null;
            activeVar = null;
            document.querySelectorAll('.cat-card').forEach(el => el.classList.remove('selected-item'));

            // Halaman kategori: cari hanya dalam kategori ini. Landing: cari semua kategori.
            const cats = IS_CATEGORY_PAGE ? [PAGE_CAT] : ['topup', 'sosmed', 'premium', 'lainnya'];
            if (!IS_CATEGORY_PAGE) activeCat = null;
            const results = [];
            cats.forEach(cat => {
                storeData[cat].items.forEach(p => {
                    const haystack = `${p.name || ''} ${p.description || ''} ${cat}`.toLowerCase();
                    if (haystack.includes(globalSearchQuery)) results.push({ ...p, cat });
                });
            });

            const section = document.getElementById('section-prod');
            const list = document.getElementById('list-prod');
            section.classList.remove('hidden');
            document.getElementById('section-form').classList.add('hidden');
            document.getElementById('bottom-bar').classList.add('hidden');
            list.className = "grid grid-cols-2 gap-4";

            if (results.length === 0) {
                list.innerHTML = `<p class="col-span-2 text-center text-slate-400 py-10 text-[10px] font-bold uppercase">Produk tidak ditemukan.</p>`;
                return;
            }

            // Di halaman kategori cukup buka produk langsung (kategori sudah aktif).
            const onClick = IS_CATEGORY_PAGE
                ? (p) => `window.changeProduct('${p.id}', event)`
                : (p) => `event.preventDefault(); window.changeCategory('${p.cat}', event); setTimeout(() => window.changeProduct('${p.id}', event), 200)`;

            list.innerHTML = results.map(p => `
                <div onclick=\"${onClick(p)}\" class="product-card-enhanced bg-white p-4 rounded-[2rem] border shadow-sm flex flex-col items-center cursor-pointer active:scale-95 transition-all">
                    ${p.bestSeller ? '<div class="best-seller-badge">Terlaris</div>' : ''}
                    <div class="img-container w-full mb-2"><img src="${getOptimizedUrl(p.imageUrl)}" class="w-full h-full object-cover"></div>
                    <span class="font-black text-slate-800 text-[9px] text-center uppercase truncate w-full px-1">${p.name}</span>
                    <div class="mt-1.5 bg-indigo-50 text-indigo-600 text-[7px] font-black px-3 py-1 rounded-full uppercase">${p.cat}</div>
                </div>
            `).join('');
        };

        window.clearSearchProducts = () => {
            const input = document.getElementById('product-search-input');
            if (input) input.value = '';
            globalSearchQuery = '';
            resetToHome();
        };

        function getAllProducts() {
            return ['topup', 'sosmed', 'premium', 'lainnya'].flatMap(cat => storeData[cat].items.map(p => ({ ...p, cat })));
        }

        function renderBestSellerHome() {
            const section = document.getElementById('best-seller-section');
            const list = document.getElementById('best-seller-list');
            if (!section || !list) return;

            const products = getAllProducts().filter(p => p.bestSeller);
            list.innerHTML = '';

            if (products.length === 0) {
                section.classList.add('hidden');
                return;
            }

            section.classList.remove('hidden');
            products.slice(0, 8).forEach(p => {
                list.innerHTML += `
                    <div onclick="openFeaturedProduct('${p.cat}', '${p.id}', event)" class="product-card-enhanced min-w-[100px] bg-white p-2 rounded-[1.4rem] border shadow-sm snap-start active:scale-95 transition-all cursor-pointer">
                        <div class="best-seller-badge">Terlaris</div>
                        <div class="img-container w-full mb-1.5"><img src="${getOptimizedUrl(p.imageUrl)}" class="w-full h-full object-cover"></div>
                        <h4 class="text-[8px] font-black text-slate-800 uppercase truncate">${p.name}</h4>
                        <p class="text-[6px] font-black text-indigo-500 uppercase mt-0.5">${getCategoryLabel(p.cat)}</p>
                    </div>`;
            });
        }



        function updateAdminStats() {
            const statTotal = document.getElementById('stat-total-products');
            const statPromo = document.getElementById('stat-total-promos');
            const statBest = document.getElementById('stat-total-best');

            const products = ['topup', 'sosmed', 'premium', 'lainnya'].flatMap(cat => {
                const items = storeData?.[cat]?.items || [];
                return items.map(p => ({ ...p, cat }));
            });

            let promoCount = 0;

            products.forEach(p => {
                if (p.category === 'sosmed' || p.cat === 'sosmed') {
                    promoCount += (p.subServices || []).filter(s => s && s.promo && s.active !== false).length;
                } else {
                    promoCount += (p.albums || []).reduce((total, album) => {
                        if (!album || album.active === false) return total;
                        if (album.mode === 'simple') return total + (album.promo ? 1 : 0);
                        return total + (album.items || []).filter(v => v && v.promo && v.active !== false).length;
                    }, 0);
                }
            });

            const bestCount = products.filter(p => p.bestSeller === true).length;

            if (statTotal) statTotal.innerText = products.length.toLocaleString('id-ID');
            if (statPromo) statPromo.innerText = promoCount.toLocaleString('id-ID');
            if (statBest) statBest.innerText = bestCount.toLocaleString('id-ID');
        }


        function renderPromoHome() {
            const list = document.getElementById('promo-home-list');
            const section = document.getElementById('promo-home-section');
            if (!list || !section) return; // hanya ada di halaman landing
            list.innerHTML = ''; let promos = [];
            ['topup', 'sosmed', 'premium', 'lainnya'].forEach(cat => { 
                storeData[cat].items.forEach(prod => { 
                    if(cat === 'sosmed' && prod.subServices) { 
                        prod.subServices.forEach(s => { 
                            if(s.promo && s.active !== false) promos.push({ n: s.name, p: (s.rateList && s.rateList[0]) ? s.rateList[0].price : 0, pid: prod.id, prodName: prod.name, cat }); 
                        }); 
                    } 
                    else if(prod.albums) { 
                        prod.albums.filter(a => a.active !== false).forEach(a => a.items.filter(v => v.active !== false && v.promo).forEach(v => { 
                            promos.push({ n: v.n, p: v.p, pid: prod.id, prodName: prod.name, cat }); 
                        })); 
                        
                    } 
                }); 
            }); 
            if(promos.length > 0) { 
                section.classList.remove('hidden'); promos.forEach(p => { 
                    list.innerHTML += `
                    <div onclick="openFeaturedProduct('${p.cat}', '${p.pid}', event)" class="flex flex-col justify-between bg-white p-3 rounded-[1.5rem] border shadow-sm snap-start active:scale-95 transition-all cursor-pointer" style="min-width:120px;max-width:120px;min-height:110px">
                        <div>
                            <p class="text-[6px] font-black text-indigo-500 uppercase mb-0.5 truncate">${p.n}</p>
                            <h4 class="text-[9px] font-black text-slate-800 uppercase leading-tight line-clamp-2 mb-1">${p.prodName}</h4>
                            <p class="text-[10px] font-black text-indigo-600">Rp ${p.p.toLocaleString('id-ID')}</p>
                        </div>
                        <div class="promo-badge inline-block scale-75 origin-left mt-1">Promo</div>
                    </div>`; 
                }); 
            } else { section.classList.add('hidden'); }
        }

        let albumDragInstance = null;
        let sosmedServiceDragInstance = null;
        let variantDragInstances = [];
        let tierDragInstances = [];

        function bindDragEvents(instance) {
            if (!instance) return instance;
            return instance
                .on('drag', el => el.classList.add('gu-transit'))
                .on('dragend', el => el.classList.remove('gu-transit'))
                .on('drop', el => el.classList.remove('gu-transit'));
        }

        function initDragula() {
            try {
                if (albumDragInstance) albumDragInstance.destroy();
                if (sosmedServiceDragInstance) sosmedServiceDragInstance.destroy();
                variantDragInstances.forEach(instance => instance && instance.destroy());
                tierDragInstances.forEach(instance => instance && instance.destroy());
            } catch (e) {
                console.warn("Reset dragula warning:", e);
            }

            albumDragInstance = null;
            sosmedServiceDragInstance = null;
            variantDragInstances = [];
            tierDragInstances = [];

            const albumContainer = document.getElementById('edit-albums-container');
            if (albumContainer) {
                albumDragInstance = bindDragEvents(dragula([albumContainer], {
                    moves: (el, container, handle) => !!handle.closest('.album-drag-handle') || handle.classList.contains('album-name'),
                    mirrorContainer: document.body,
                    direction: 'vertical',
                    revertOnSpill: true
                }));
            }

            document.querySelectorAll('.album-items-container').forEach(container => {
                const itemDrake = bindDragEvents(dragula([container], {
                    moves: (el, container, handle) => !!handle.closest('.variant-drag-handle'),
                    mirrorContainer: document.body,
                    direction: 'vertical',
                    revertOnSpill: true
                }));

                variantDragInstances.push(itemDrake);
            });

            const sosmedContainer = document.getElementById('edit-sosmed-container');
            if (sosmedContainer) {
                sosmedServiceDragInstance = bindDragEvents(dragula([sosmedContainer], {
                    moves: (el, container, handle) => !!handle.closest('.service-drag-handle') || handle.classList.contains('s-name'),
                    mirrorContainer: document.body,
                    direction: 'vertical',
                    revertOnSpill: true
                }));
            }

            document.querySelectorAll('.tier-container').forEach(container => {
                const tierDrake = bindDragEvents(dragula([container], {
                    moves: (el, container, handle) => !!handle.closest('.tier-drag-handle'),
                    mirrorContainer: document.body,
                    direction: 'vertical',
                    revertOnSpill: true
                }));

                tierDragInstances.push(tierDrake);
            });
        }

        function applyTheme(theme) {
            const isDark = theme === 'dark';
            document.documentElement.classList.toggle('dark', isDark);
            document.body.classList.toggle('dark', isDark);

            const toggle = document.getElementById('theme-toggle');
            if (toggle) {
                const icon = toggle.querySelector('i');
                if (icon) icon.className = isDark ? 'fas fa-sun text-[12px]' : 'fas fa-moon text-[12px]';
                toggle.setAttribute('aria-label', isDark ? 'Aktifkan day mode' : 'Aktifkan night mode');
                toggle.setAttribute('title', isDark ? 'Day mode' : 'Night mode');
            }

            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        }

        window.toggleTheme = () => {
            const nextTheme = document.body.classList.contains('dark') ? 'light' : 'dark';
            applyTheme(nextTheme);
        };




        // --- DISABLE UNWANTED PAGE JUMP ---
        document.addEventListener('click', (e) => {
            const anchor = e.target.closest('a[href="#"], a[href=""]');
            if (anchor) e.preventDefault();
        }, true);

        // --- HERO BANNER SLIDER ---
        function initHeroBanner() {
            const banner = document.getElementById('hero-banner');
            if (!banner) return;

            const track = banner.querySelector('.hero-banner-track');
            const slides = banner.querySelectorAll('.hero-slide');
            const dots = banner.querySelectorAll('.hero-dot');
            const prevBtn = banner.querySelector('.hero-arrow.prev');
            const nextBtn = banner.querySelector('.hero-arrow.next');

            let currentIndex = 0;
            let autoSlide = null;
            let startX = 0;
            let endX = 0;
            const totalSlides = slides.length;
            const intervalTime = 4000;

            function updateSlider() {
                track.style.transform = `translateX(-${currentIndex * 100}%)`;
                dots.forEach((dot, index) => {
                    dot.classList.toggle('active', index === currentIndex);
                });
            }

            function goToSlide(index) {
                currentIndex = index;
                if (currentIndex >= totalSlides) currentIndex = 0;
                if (currentIndex < 0) currentIndex = totalSlides - 1;
                updateSlider();
            }

            function nextSlide() {
                goToSlide(currentIndex + 1);
            }

            function prevSlide() {
                goToSlide(currentIndex - 1);
            }

            function stopAutoSlide() {
                if (autoSlide) clearInterval(autoSlide);
            }

            function startAutoSlide() {
                stopAutoSlide();
                autoSlide = setInterval(nextSlide, intervalTime);
            }

            function handleSwipe() {
                const diff = startX - endX;
                if (Math.abs(diff) < 50) return;

                if (diff > 0) {
                    nextSlide();
                } else {
                    prevSlide();
                }
            }

            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    nextSlide();
                    startAutoSlide();
                });
            }

            if (prevBtn) {
                prevBtn.addEventListener('click', () => {
                    prevSlide();
                    startAutoSlide();
                });
            }

            dots.forEach((dot, index) => {
                dot.addEventListener('click', () => {
                    goToSlide(index);
                    startAutoSlide();
                });
            });

            banner.addEventListener('touchstart', (e) => {
                startX = e.touches[0].clientX;
                stopAutoSlide();
            }, { passive: true });

            banner.addEventListener('touchend', (e) => {
                endX = e.changedTouches[0].clientX;
                handleSwipe();
                startAutoSlide();
            }, { passive: true });

            banner.addEventListener('mousedown', (e) => {
                startX = e.clientX;
                stopAutoSlide();
            });

            banner.addEventListener('mouseup', (e) => {
                endX = e.clientX;
                handleSwipe();
                startAutoSlide();
            });

            banner.addEventListener('mouseenter', stopAutoSlide);
            banner.addEventListener('mouseleave', startAutoSlide);

            updateSlider();
            startAutoSlide();
        }


        // ================================================================
        // PAYMENT GATEWAY - SAKURUPIAH
        // ================================================================

        let currentPaymentOrderId = null;
        let currentPaymentTrxId = null;
        let paymentPollingInterval = null;
        let currentPaymentData = {}; // menyimpan data order saat ini

        window.startPaymentGateway = () => {
            // Siapkan data pembayaran dari state yang aktif
            let price = 0, productId = '', productName = '', variantName = '', variantCode = '', qty = 1;

            if (!activeProd) { showToast("PILIH PRODUK DULU!"); return; }

            // Order otomatis wajib login (akun Google) — lihat initBuyerAuth()/handleGoogleCredential()
            if (!buyerUser) {
                showToast("LOGIN DULU UNTUK ORDER OTOMATIS!");
                _pendingAutoOrderAfterLogin = true;
                window.openBuyerModal();
                return;
            }

            if (activeProd.category === 'sosmed') {
                const qtyVal = parseInt(document.getElementById('sosmed-qty')?.value) || 0;
                if (!qtyVal || socialPrice <= 0) { showToast("ISI JUMLAH!"); return; }
                price = socialPrice;
                productId = activeProd.id;
                productName = activeProd.name;
                variantName = currentSocialService?.name || '';
                variantCode = buildSosmedOrderCode(currentSocialService, currentSocialTier, 'SOS');
                qty = qtyVal;
            } else {
                if (!activeVar) { showToast("PILIH VARIAN!"); return; }
                price = parseFloat(activeVar.p) || 0;
                productId = activeProd.id;
                productName = activeProd.name;
                variantName = activeVar.n || '';
                variantCode = activeVar._resolvedCode || buildProductOrderCode(activeAlbum, activeVar, 'VAR');
                if (activeProd.category === 'premium') {
                    const qtyEl = document.getElementById('final-qty');
                    qty = parseInt(qtyEl?.value) || 1;
                    price = price; // harga per unit
                }
            }

            if (price <= 0) { showToast("HARGA TIDAK VALID!"); return; }

            currentPaymentData = { productId, productName, variantName, variantCode, price, qty };

            // Tampilkan modal payment, step form
            document.getElementById('payment-product-label').innerText = `${productName} - ${variantName}`;
            document.getElementById('payment-total-display').innerText = `Rp ${(price * qty).toLocaleString('id-ID')}`;
            showPaymentStep('form');
            // Prefill nama/email dari akun Google (tetap bisa diubah pembeli)
            const nameEl = document.getElementById('buyer-name');
            const emailEl = document.getElementById('buyer-email');
            if (nameEl && !nameEl.value) nameEl.value = buyerUser.name || '';
            if (emailEl && !emailEl.value) emailEl.value = buyerUser.email || '';
            document.getElementById('modal-checkout').classList.add('hidden');
            document.getElementById('modal-payment').classList.remove('hidden');
        };

        window.closePaymentModal = () => {
            stopPaymentPolling();
            document.getElementById('modal-payment').classList.add('hidden');
        };

        function showPaymentStep(step) {
            ['form', 'invoice', 'success', 'error'].forEach(s => {
                document.getElementById(`payment-step-${s}`)?.classList.add('hidden');
                const footer = document.getElementById(`payment-footer-${s}`);
                if (footer) footer.classList.add('hidden');
            });
            document.getElementById(`payment-step-${step}`)?.classList.remove('hidden');
            const footer = document.getElementById(`payment-footer-${step}`);
            if (footer) footer.classList.remove('hidden');
        }

        window.submitPaymentForm = async () => {
            const buyerName = document.getElementById('buyer-name')?.value?.trim();
            const buyerEmail = document.getElementById('buyer-email')?.value?.trim();
            const buyerPhone = document.getElementById('buyer-phone')?.value?.trim();

            if (!buyerName) { showToast("ISI NAMA DULU!"); return; }
            if (!buyerPhone) { showToast("ISI NOMOR HP DULU!"); return; }
            if (!buyerUser) { showToast("LOGIN DULU UNTUK ORDER OTOMATIS!"); window.openBuyerModal(); return; }

            const { productId, productName, variantName, variantCode, price, qty } = currentPaymentData;

            // Kumpulkan data tambahan dari form checkout
            const orderData = {};
            const fid = document.getElementById('final-id');
            const fsv = document.getElementById('final-server');
            const femail = document.getElementById('final-email');
            const fac = document.getElementById('final-acc');
            const fpw = document.getElementById('final-pw');
            const finv = document.getElementById('final-invite');
            const fnote = document.getElementById('final-note');

            if (fid?.value) orderData.userId = fid.value.trim();
            if (fsv?.value) orderData.server = fsv.value.trim();
            if (femail?.value) orderData.email = femail.value.trim();
            if (fac?.value) orderData.account = fac.value.trim();
            if (fpw?.value) orderData.password = fpw.value.trim();
            if (finv?.value) orderData.link = finv.value.trim();
            if (fnote?.value) orderData.note = fnote.value.trim();

            showToast("MEMBUAT INVOICE...");

            try {
                const res = await fetch('/api/create-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productId, productName, variantName, variantCode,
                        price, qty, buyerName, buyerEmail, buyerPhone,
                        buyerUid: buyerUser.uid,
                        note: fnote?.value || '',
                        orderData
                    })
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Gagal membuat invoice');
                }

                currentPaymentOrderId = data.orderId;
                currentPaymentTrxId   = data.trxId;

                // Simpan ke localStorage agar halaman payment-success bisa akses dari tab baru
                localStorage.setItem('evr_current_order_id', data.orderId);
                localStorage.setItem('evr_current_trx_id',   data.trxId || '');

                // Tampilkan step invoice
                document.getElementById('payment-invoice-id').innerText = `#${data.orderId}`;
                document.getElementById('payment-amount-display').innerText = `Rp ${Number(data.amount).toLocaleString('id-ID')}`;
                if (data.expiredAt) {
                    const exp = new Date(data.expiredAt);
                    document.getElementById('payment-expires').innerText = `Berlaku hingga: ${exp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
                }

                const payLinkBtn = document.getElementById('payment-link-btn');
                if (data.paymentUrl && data.paymentUrl !== 'undefined' && data.paymentUrl !== 'null') {
                    payLinkBtn.href = data.paymentUrl;
                    payLinkBtn.removeAttribute('disabled');
                    payLinkBtn.classList.remove('opacity-50');
                } else {
                    // Jika URL tidak ada, sembunyikan tombol dan tampilkan pesan
                    payLinkBtn.href = '#';
                    payLinkBtn.setAttribute('disabled', 'disabled');
                    payLinkBtn.classList.add('opacity-50');
                    payLinkBtn.innerHTML = '<i class="fas fa-exclamation-circle text-[10px]"></i> Link pembayaran tidak tersedia';
                }

                showPaymentStep('invoice');

                // Mulai polling cek pembayaran setiap 5 detik
                startPaymentPolling(currentPaymentTrxId, currentPaymentOrderId);

            } catch (err) {
                console.error('Create payment error:', err);
                document.getElementById('payment-error-title').innerText = 'Gagal Membuat Invoice';
                document.getElementById('payment-error-msg').innerText = err.message || 'Coba lagi atau hubungi admin';
                showPaymentStep('error');
            }
        };

        function startPaymentPolling(trxId, orderId) {
            stopPaymentPolling();
            let attempts = 0;
            const maxAttempts = 72; // 72 x 5 detik = 6 menit (diproses)
            const extraAttempts = 60; // tambahan 5 menit untuk Insider yang masih processing
            let insiderAttempts = 0;

            paymentPollingInterval = setInterval(async () => {
                attempts++;
                if (attempts > maxAttempts + extraAttempts) {
                    stopPaymentPolling();
                    document.getElementById('payment-error-title').innerText = 'Waktu Habis';
                    document.getElementById('payment-error-msg').innerText = 'Invoice kadaluarsa. Buat pesanan baru atau hubungi admin.';
                    showPaymentStep('error');
                    return;
                }

                try {
                    const params = new URLSearchParams({ trxId, orderId });
                    const res = await fetch(`/api/check-payment?${params}`);
                    const data = await res.json();

                    if (!data.isPaid) return;

                    // === Cabang Insider ===
                    if (data.fulfillment === 'insider') {
                        if (data.insiderStatus === 'done') {
                            stopPaymentPolling();
                            showInsiderSuccess(data);
                            return;
                        }
                        if (data.insiderStatus === 'failed') {
                            stopPaymentPolling();
                            document.getElementById('payment-error-title').innerText = 'Top-up Gagal';
                            document.getElementById('payment-error-msg').innerText = data.reason || data.insiderNote || 'Top-up gagal diproses. Hubungi admin.';
                            showPaymentStep('error');
                            return;
                        }
                        // Status processing — lanjut polling (gunakan extraAttempts)
                        insiderAttempts++;
                        // Update UI jadi "Sedang memproses top-up..."
                        const spinner = document.getElementById('payment-checking-spinner');
                        if (spinner) {
                            const msg = spinner.parentElement.querySelector('.text-amber-700');
                            if (msg) msg.textContent = 'Top-up sedang dikirim ke tujuan...';
                        }
                        return;
                    }

                    // === Cabang Kirim Stok ===
                    if (data.isPaid && data.deliveredAccounts && data.deliveredAccounts.length > 0) {
                        stopPaymentPolling();
                        // Akun ditampilkan di modal ini juga
                        showDeliveredAccounts(data.deliveredAccounts);
                        return;
                    }

                    if (data.isPaid) {
                        stopPaymentPolling();
                        showToast("PEMBAYARAN BERHASIL! CEK TAB PEMBAYARAN.");
                        setTimeout(() => closePaymentModal(), 3000);
                    }
                } catch (e) {
                    console.warn('Polling error:', e);
                }
            }, 5000);
        }

        function showInsiderSuccess(data) {
            const container = document.getElementById('delivered-accounts-container');
            container.innerHTML = `
                <div class="bg-violet-50 border border-violet-100 rounded-2xl p-5 text-center space-y-1">
                    <div class="w-14 h-14 bg-violet-100 text-violet-600 rounded-full flex items-center justify-center mx-auto mb-3">
                        <i class="fas fa-check-circle text-2xl"></i>
                    </div>
                    <h3 class="font-black text-violet-700 uppercase text-sm">Top-up Berhasil!</h3>
                    <p class="text-[9px] text-violet-600 font-bold">Top-up telah dikirim ke ID/akun tujuan.</p>
                    ${data.insiderNote ? `<p class="text-[8px] text-violet-500 font-bold mt-1">${escapeHtml(data.insiderNote)}</p>` : ''}
                </div>
            `;
            showPaymentStep('success');
            showToast("TOP-UP BERHASIL!");
        }

        function stopPaymentPolling() {
            if (paymentPollingInterval) {
                clearInterval(paymentPollingInterval);
                paymentPollingInterval = null;
            }
        }

        function showDeliveredAccounts(accounts) {
            const container = document.getElementById('delivered-accounts-container');
            container.innerHTML = '';

            accounts.forEach((acc, i) => {
                const div = document.createElement('div');
                div.className = 'bg-indigo-50 border border-indigo-100 rounded-2xl p-4 font-mono text-xs text-indigo-800 break-all';
                div.innerHTML = `<p class="text-[8px] font-black text-indigo-400 uppercase mb-1">Akun ${i + 1}</p><p class="font-bold">${escapeHtml(acc)}</p>`;
                container.appendChild(div);
            });

            showPaymentStep('success');
            showToast("AKUN BERHASIL DITERIMA!");
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // ================================================================
        // MANAJEMEN STOK ADMIN
        // ================================================================

        // Toggle autoPayment langsung dari baris varian
        // === INLINE STOCK MANAGEMENT ===
        window.openInlineStock = async (btn) => {
            const row = btn.closest('.item-row');
            const panel = row.querySelector('.v-stock-panel');
            if (!panel) return;
            const isOpen = !panel.classList.contains('hidden');
            if (isOpen) { panel.classList.add('hidden'); return; }
            panel.classList.remove('hidden');
            if (!currentEditId) return;
            const fullCode = getVariantFullCodeFromRow(row);
            try {
                const res = await fetch(`/api/manage-stock?productId=${encodeURIComponent(currentEditId.pid)}&variantCode=${encodeURIComponent(fullCode)}`, {
                    headers: { 'Authorization': `Bearer ${getAdminToken() || ''}` }
                });
                const data = await res.json();
                row.querySelector('.v-stock-count').textContent = data.totalStock || 0;
                row.querySelector('.v-sold-count').textContent = data.totalDelivered || 0;
                // Insider section: tampilkan hanya untuk produk kategori Game
                const insiderSection = panel.querySelector('.v-insider-section');
                if (insiderSection) {
                    if (currentEditId.cat === 'topup') {
                        insiderSection.classList.remove('hidden');
                        // Update tombol toggle & SKU display
                        const toggleBtn = panel.querySelector('.v-insider-toggle');
                        const skuVal = panel.querySelector('.v-insider-sku-value');
                        if (data.insiderAuto) {
                            toggleBtn.textContent = 'ON';
                            toggleBtn.className = toggleBtn.className.replace(/bg-(slate|violet)-\d+/g, 'bg-violet-100').replace(/text-(slate|violet)-\d+/g, 'text-violet-600').replace(/border-(slate|violet)-\d+/g, 'border-violet-200');
                        } else {
                            toggleBtn.textContent = 'OFF';
                        }
                        if (skuVal) skuVal.textContent = data.insiderSku || '—';
                    } else {
                        insiderSection.classList.add('hidden');
                    }
                }
            } catch(e) { console.warn('openInlineStock error:', e); }
        };

        window.addVariantStock = async (btn) => {
            if (!currentEditId) { showToast("SIMPAN PRODUK DULU!"); return; }
            const token = getAdminToken();
            if (!token) { showToast("LOGIN ADMIN DULU!"); return; }
            const row = btn.closest('.item-row');
            const fullCode = getVariantFullCodeFromRow(row);
            const textarea = row.querySelector('.v-stock-input');
            const raw = textarea.value.trim();
            if (!raw) { showToast("ISI AKUN DULU!"); return; }
            const accounts = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (accounts.length === 0) { showToast("TIDAK ADA AKUN VALID!"); return; }
            showToast(`MENAMBAHKAN ${accounts.length} AKUN...`);
            try {
                const res = await fetch('/api/manage-stock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ action: 'add', productId: currentEditId.pid, variantCode: fullCode, accounts })
                });
                const data = await res.json();
                if (res.ok) {
                    textarea.value = '';
                    row.querySelector('.v-stock-count').textContent = data.totalStock || 0;
                    showToast(`${accounts.length} AKUN DITAMBAHKAN!`);
                } else { showToast("GAGAL: " + (data.error || 'Error')); }
            } catch(e) { showToast("GAGAL: " + e.message); }
        };

        window.clearVariantStock = async (btn) => {
            if (!currentEditId) { showToast("SIMPAN PRODUK DULU!"); return; }
            const token = getAdminToken();
            if (!token) { showToast("LOGIN ADMIN DULU!"); return; }
            const row = btn.closest('.item-row');
            const fullCode = getVariantFullCodeFromRow(row);
            confirmCancel('Hapus semua stok varian ini?', async () => {
                try {
                    const res = await fetch('/api/manage-stock', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ action: 'clear', productId: currentEditId.pid, variantCode: fullCode })
                    });
                    if (res.ok) {
                        row.querySelector('.v-stock-count').textContent = '0';
                        showToast("STOK DIHAPUS!");
                    }
                } catch(e) { showToast("GAGAL!"); }
            }, 'Ya, Hapus');
        };

        // === INSIDER AUTO-TOPUP (kategori Game) ===
        window.toggleInsiderAuto = async (btn) => {
            if (!currentEditId || currentEditId.cat !== 'topup') { showToast("Hanya untuk produk Game!"); return; }
            const token = getAdminToken();
            if (!token) { showToast("LOGIN ADMIN DULU!"); return; }
            const row = btn.closest('.item-row');
            const fullCode = getVariantFullCodeFromRow(row);
            const panel = btn.closest('.v-stock-panel');
            const skuVal = panel.querySelector('.v-insider-sku-value');
            const currentSku = (skuVal?.textContent || '').replace('—', '').trim();
            const isOn = btn.textContent.trim() === 'ON';
            const newState = !isOn;

            if (newState && !currentSku) { showToast("PILIH SKU DULU DARI KATALOG!"); return; }

            try {
                const res = await fetch('/api/manage-stock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ action: 'set-insider', productId: currentEditId.pid, variantCode: fullCode, insiderAuto: newState, insiderSku: currentSku })
                });
                const data = await res.json();
                if (res.ok) {
                    if (newState) {
                        btn.textContent = 'ON';
                        btn.className = btn.className.replace(/bg-(slate|violet)-\d+/g, 'bg-violet-100').replace(/text-(slate|violet)-\d+/g, 'text-violet-600').replace(/border-(slate|violet)-\d+/g, 'border-violet-200');
                    } else {
                        btn.textContent = 'OFF';
                        btn.className = btn.className.replace(/bg-(slate|violet)-\d+/g, 'bg-slate-100').replace(/text-(slate|violet)-\d+/g, 'text-slate-400').replace(/border-(slate|violet)-\d+/g, 'border-slate-200');
                    }
                    showToast(`Auto-topup Insider ${newState ? 'AKTIF' : 'NONAKTIF'}`);
                } else { showToast("GAGAL: " + (data.error || 'Error')); }
            } catch(e) { showToast("GAGAL: " + e.message); }
        };

        window.openInsiderPicker = async (btn) => {
            if (!currentEditId || currentEditId.cat !== 'topup') return;
            const token = getAdminToken();
            if (!token) { showToast("LOGIN ADMIN DULU!"); return; }
            // Inject modal picker
            let modal = document.getElementById('modal-insider-picker');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'modal-insider-picker';
                modal.className = 'fixed inset-0 z-[150] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-slate-900/70 backdrop-blur-sm hidden';
                modal.innerHTML = `
                    <div class="bg-white w-full max-w-md rounded-t-[2.5rem] sm:rounded-[2.5rem] shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
                        <div class="p-5 border-b flex justify-between items-center">
                            <h3 class="font-black text-violet-600 uppercase tracking-[0.15em] text-[10px]">Pilih SKU Insider</h3>
                            <button onclick="closeInsiderPicker()" class="text-slate-300 w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-50"><i class="fas fa-times"></i></button>
                        </div>
                        <div class="flex-1 overflow-y-auto p-5">
                            <div id="insider-picker-step-games" class="space-y-2">
                                <p class="text-[8px] font-black text-slate-400 uppercase mb-2">Pilih Game</p>
                                <div id="insider-games-list" class="space-y-1"><p class="text-[8px] text-slate-400">Memuat...</p></div>
                            </div>
                            <div id="insider-picker-step-products" class="space-y-2 hidden">
                                <button onclick="backInsiderGames()" class="text-[8px] font-black text-violet-500 uppercase mb-2"><i class="fas fa-chevron-left mr-1"></i> Ganti Game</button>
                                <p class="text-[8px] font-black text-slate-400 uppercase mb-2">Pilih SKU</p>
                                <div id="insider-products-list" class="space-y-1"><p class="text-[8px] text-slate-400">Memuat...</p></div>
                            </div>
                        </div>
                    </div>`;
                document.body.appendChild(modal);
            }
            modal.classList.remove('hidden');
            // Load games
            const gamesList = document.getElementById('insider-games-list');
            const stepGames = document.getElementById('insider-picker-step-games');
            const stepProducts = document.getElementById('insider-picker-step-products');
            stepGames.classList.remove('hidden'); stepProducts.classList.add('hidden');
            gamesList.innerHTML = '<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></div></div>';
            try {
                const res = await fetch('/api/insider-catalog?type=games', { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Gagal ambil games');
                gamesList.innerHTML = data.games.map(g => `
                    <button onclick="selectInsiderGame('${escapeAttr(g.code)}', '${escapeAttr(g.name)}')" class="w-full text-left bg-slate-50 p-3 rounded-xl border active:scale-[0.98] transition-all hover:border-violet-200">
                        <span class="text-[9px] font-black text-slate-700 uppercase">${g.name}</span><br>
                        <span class="text-[7px] font-bold text-slate-400">${g.code}</span>
                    </button>`).join('');
                window._insiderCache = { games: data.games };
            } catch(e) { gamesList.innerHTML = `<p class="text-[8px] text-red-400 font-bold">Gagal: ${e.message}</p>`; }
        };

        window.selectInsiderGame = async (code, name) => {
            const stepGames = document.getElementById('insider-picker-step-games');
            const stepProducts = document.getElementById('insider-picker-step-products');
            const productsList = document.getElementById('insider-products-list');
            stepGames.classList.add('hidden'); stepProducts.classList.remove('hidden');
            productsList.innerHTML = '<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></div></div>';
            const token = getAdminToken();
            try {
                const res = await fetch(`/api/insider-catalog?type=products&code=${encodeURIComponent(code)}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Gagal ambil produk');
                productsList.innerHTML = data.products.map(p => `
                    <button onclick="confirmInsiderSku('${escapeAttr(p.sku)}', '${escapeAttr(p.name)}', ${p.basePrice || 0})" class="w-full text-left bg-slate-50 p-3 rounded-xl border active:scale-[0.98] transition-all hover:border-violet-200 flex justify-between items-center">
                        <div>
                            <span class="text-[8px] font-black text-slate-700 uppercase">${p.name}</span><br>
                            <span class="text-[7px] font-bold text-slate-400">SKU: ${p.sku} · Modal: Rp ${(p.basePrice||0).toLocaleString('id-ID')}</span>
                        </div>
                        <i class="fas fa-chevron-right text-violet-300 text-xs"></i>
                    </button>`).join('');
            } catch(e) { productsList.innerHTML = `<p class="text-[8px] text-red-400 font-bold">Gagal: ${e.message}</p>`; }
        };

        window.backInsiderGames = () => {
            document.getElementById('insider-picker-step-products').classList.add('hidden');
            document.getElementById('insider-picker-step-games').classList.remove('hidden');
        };

        window.confirmInsiderSku = async (sku, name, basePrice) => {
            const token = getAdminToken();
            const panel = document.querySelector('.v-stock-panel:not(.hidden)');
            if (!panel) return;
            const fullCode = getVariantFullCodeFromRow(panel.closest('.item-row'));
            try {
                const res = await fetch('/api/manage-stock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ action: 'set-insider', productId: currentEditId.pid, variantCode: fullCode, insiderAuto: true, insiderSku: sku })
                });
                const data = await res.json();
                if (res.ok) {
                    const skuVal = panel.querySelector('.v-insider-sku-value');
                    const toggleBtn = panel.querySelector('.v-insider-toggle');
                    if (skuVal) skuVal.textContent = `${sku} (${name})`;
                    if (toggleBtn) { toggleBtn.textContent = 'ON'; toggleBtn.className = toggleBtn.className.replace(/bg-(slate|violet)-\d+/g, 'bg-violet-100').replace(/text-(slate|violet)-\d+/g, 'text-violet-600').replace(/border-(slate|violet)-\d+/g, 'border-violet-200'); }
                    closeInsiderPicker();
                    showToast(`SKU ${sku} TERPILIH! INSIDER AKTIF.`);
                } else { showToast("GAGAL: " + (data.error || 'Error')); }
            } catch(e) { showToast("GAGAL: " + e.message); }
        };

        window.closeInsiderPicker = () => {
            const modal = document.getElementById('modal-insider-picker');
            if (modal) modal.classList.add('hidden');
        };

        function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

        window.openVariantAutoPayToggle = async (btn) => {
            if (!currentEditId) { showToast("SIMPAN PRODUK DULU SEBELUM ATUR PAYMENT!"); return; }
            const row = btn.closest('.item-row');
            const fullCode = getVariantFullCodeFromRow(row);

            // Cek status saat ini
            const token = getAdminToken();
            let currentState = false;
            try {
                const res = await fetch(`/api/manage-stock?productId=${encodeURIComponent(currentEditId.pid)}&variantCode=${encodeURIComponent(fullCode)}`);
                const data = await res.json();
                currentState = data.autoPayment === true;
            } catch(e) {}

            const newState = !currentState;

            try {
                const res = await fetch('/api/toggle-autopayment', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        productId:   currentEditId.pid,
                        variantCode: fullCode,
                        autoPayment: newState
                    })
                });
                const data = await res.json();
                if (res.ok) {
                    // Update tampilan tombol
                    const label = btn.querySelector('.v-autopay-label');
                    if (newState) {
                        btn.classList.remove('bg-slate-100','text-slate-400','border-slate-200');
                        btn.classList.add('bg-violet-100','text-violet-600','border-violet-200');
                        if (label) label.textContent = 'ON';
                    } else {
                        btn.classList.remove('bg-violet-100','text-violet-600','border-violet-200');
                        btn.classList.add('bg-slate-100','text-slate-400','border-slate-200');
                        if (label) label.textContent = 'OFF';
                    }
                    showToast(`PAYMENT OTOMATIS ${newState ? 'ON ✅' : 'OFF ❌'} untuk ${fullCode}`);
                } else {
                    showToast("GAGAL: " + (data.error || 'Error'));
                }
            } catch(err) {
                showToast("GAGAL: " + err.message);
            }
        };
        // Tombol petir di kartu admin sekarang buka modal stok langsung
        // (hapus fungsi lama toggleAutoPayment yang per produk)
        window.toggleAutoPayment = (productId, category, currentState) => {
            // Arahkan ke modal stok agar toggle per varian
            showToast("BUKA MODAL STOK (📦) UNTUK ATUR PAYMENT OTOMATIS PER VARIAN");
        };

        // Update tampilan tombol bayar otomatis berdasarkan VARIAN aktif
        async function updatePaymentButtons() {
            const btnAuto    = document.getElementById('btn-pay-auto');
            const infoNoAuto = document.getElementById('no-auto-payment-info');
            if (!btnAuto || !infoNoAuto) return;

            // Sembunyikan dulu sampai cek selesai
            btnAuto.classList.add('hidden');
            infoNoAuto.classList.add('hidden');

            if (!activeProd || !activeVar) return;

            try {
                const varCode = activeVar._resolvedCode || activeVar.code || buildProductOrderCode(activeAlbum, activeVar, 'VAR');
                console.log('[AutoPay] productId:', activeProd.id, '| varCode:', varCode);

                const res = await fetch(
                    `/api/manage-stock?productId=${encodeURIComponent(activeProd.id)}&variantCode=${encodeURIComponent(varCode)}`,
                    { headers: { 'Authorization': 'Bearer public' } }
                );
                const data = await res.json();
                console.log('[AutoPay] response autoPayment:', data.autoPayment, '| variantCode dari API:', data.variantCode);

                const isSupported = data.autoPayment === true;
                if (isSupported) {
                    btnAuto.classList.remove('hidden');
                    infoNoAuto.classList.add('hidden');
                } else {
                    btnAuto.classList.add('hidden');
                    infoNoAuto.classList.remove('hidden');
                }
            } catch (e) {
                console.error('[AutoPay] Error:', e);
                btnAuto.classList.add('hidden');
                infoNoAuto.classList.remove('hidden');
            }
        }

        initHeroBanner();
        initBuyerAuth();

        // Load theme on start
        const savedTheme = localStorage.getItem('theme');
        const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(savedTheme || (systemPrefersDark ? 'dark' : 'light'));
        updateFloatingButtons();
    