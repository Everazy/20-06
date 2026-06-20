// build.js — assemble the 5 storefront pages from shared partials.
// Single source of truth: shared HTML chrome + assets/store.js (engine).
// Pages reference /assets/store.js via <script src>, so the engine is shared (never duplicated).
// Shared chrome (nav, admin dashboard, all modals, bottom bar, floating buttons) is inlined here
// so each page is a plain static file that works on Vercel with no client-side fetch needed.
//
// Run:  node build.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const P = (...a) => path.join(ROOT, ...a);
const read = f => fs.readFileSync(f, 'utf8');

// --- Hand-authored shared partials ---
const head    = read(P('assets/partials/head.html'));
const nav     = read(P('assets/partials/nav.html'));
const overlay = read(P('assets/partials/overlay.html'));
const mainHome     = read(P('assets/partials/main-home.html'));
const mainCategory = read(P('assets/partials/main-category.html'));

// --- Verbatim shared chrome reused from the original monolith (admin view + all modals) ---
const admin  = read(P('assets/_regions/adminview.html'));
const modals = read(P('assets/_regions/chrome.html'));

// Engine source of truth: assets/_store_original.js (page-aware, hand-edited).
// Shipped engine assets/store.js is a copy of it, regenerated every build.
fs.copyFileSync(P('assets/_store_original.js'), P('assets/store.js'));
console.log('store.js synced from _store_original.js');

const fillHead = title => head.replace(/{{TITLE}}/g, title).replace(/{{OGTITLE}}/g, title);

function page({ title, pageName, mainHtml }) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
${fillHead(title)}
</head>
<body class="bg-slate-50 text-slate-900">

${overlay}

${nav}

${mainHtml}

    ${admin}

    ${modals}

    <script>window.EVERA_PAGE = ${JSON.stringify(pageName)};</script>
    <script type="module" src="/assets/store.js"></script>
</body>
</html>
`;
}

function categoryMain(c) {
  return mainCategory
    .replace(/{{CATLABEL}}/g, c.label)
    .replace(/{{CATICON}}/g, c.icon)
    .replace(/{{CATACCENT}}/g, c.accent)
    .replace(/{{CATTAGLINE}}/g, c.tagline);
}

const CATEGORIES = {
  game:    { title: 'Top Up Game — Everastore',    pageName: 'game',    label: 'Top Up Game',  icon: 'fa-gamepad',  accent: 'indigo',  tagline: 'Top up diamond & voucher game, proses kilat' },
  premium: { title: 'App Premium — Everastore',    pageName: 'premium', label: 'App Premium',  icon: 'fa-crown',    accent: 'amber',   tagline: 'Akun aplikasi premium bergaransi' },
  sosmed:  { title: 'Sosial Media — Everastore',   pageName: 'sosmed',  label: 'Sosial Media', icon: 'fa-users',    accent: 'blue',    tagline: 'Followers, likes & layanan sosmed' },
  lainnya: { title: 'Produk Lainnya — Everastore', pageName: 'lainnya', label: 'Lainnya',      icon: 'fa-box-open', accent: 'emerald', tagline: 'Produk digital lainnya' },
};

fs.writeFileSync(P('index.html'), page({ title: 'Everastore', pageName: 'home', mainHtml: mainHome }));
console.log('wrote index.html');

for (const [file, c] of Object.entries(CATEGORIES)) {
  fs.writeFileSync(P(file + '.html'), page({ title: c.title, pageName: c.pageName, mainHtml: categoryMain(c) }));
  console.log('wrote ' + file + '.html');
}

console.log('Build done.');
