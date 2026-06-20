// extract.js — slice index.html into shared assets + body regions
const fs = require('fs');
const path = require('path');
const ROOT = "D:/Download/EVERASTORE UPDATE TO AUTO TOPUP/extracted/EVERASTORE-main";
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function block(openTagStart, closeTag) {
  const a = src.indexOf(openTagStart);
  if (a < 0) throw new Error('open not found: ' + openTagStart);
  const contentStart = src.indexOf('>', a) + 1;
  const b = src.indexOf(closeTag, contentStart);
  if (b < 0) throw new Error('close not found: ' + closeTag);
  return { content: src.slice(contentStart, b), endIdx: b + closeTag.length };
}

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });

// --- CSS ---
const styleBlk = block('<style', '</style>');
fs.writeFileSync(path.join(ROOT, 'assets/styles.css'), styleBlk.content.trim() + '\n');

// --- JS module ---
const scriptBlk = block('<script type="module"', '</script>');
fs.writeFileSync(path.join(ROOT, 'assets/_store_original.js'), scriptBlk.content);

// --- Body regions ---
function slice(startMarker, endMarker, fromIdx = 0) {
  const a = src.indexOf(startMarker, fromIdx);
  const b = src.indexOf(endMarker, a) + endMarker.length;
  return { text: src.slice(a, b), a, b };
}
const nav = slice('<nav', '</nav>');
const uv = slice('<main id="user-view"', '</main>');
const av = slice('<main id="admin-view"', '</main>');
const scriptIdx = src.indexOf('<script type="module"');
const chrome = src.slice(av.b, scriptIdx).trim();

const TMP = path.join(ROOT, 'assets', '_regions');
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'nav.html'), nav.text);
fs.writeFileSync(path.join(TMP, 'userview.html'), uv.text);
fs.writeFileSync(path.join(TMP, 'adminview.html'), av.text);
fs.writeFileSync(path.join(TMP, 'chrome.html'), chrome);

console.log('OK');
console.log('css bytes', styleBlk.content.length);
console.log('js bytes', scriptBlk.content.length);
console.log('nav bytes', nav.text.length);
console.log('userview bytes', uv.text.length);
console.log('adminview bytes', av.text.length);
console.log('chrome bytes', chrome.length);
