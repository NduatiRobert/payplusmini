// Builds a single-file, backend-free demo: node demo/build.js  ->  demo/index.html
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let html = read('public/index.html');
const banner = `<div class="demo-banner">DEMO · fake data, simulated ads · <button onclick="__demoAddFunds()">+$10 to test withdraw</button></div>`;
const demoCss = `.demo-banner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:90;background:#23252f;color:#ffe48a;font:600 11px Inter,sans-serif;padding:4px 10px;border-radius:0 0 10px 10px;white-space:nowrap}.demo-banner button{color:#fff;text-decoration:underline;font-size:11px;padding:0 0 0 4px}.topbar{padding-top:26px}`;
html = html
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>${read('public/styles.css')}\n${demoCss}</style>`)
  .replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', () => '')
  .replace(/\s*<!-- Monetag SDK[^]*?<\/script>/, () => '')
  .replace('<script src="i18n.js"></script>', () => `<script>${read('demo/mock-api.js')}</script>\n<script>${read('public/i18n.js')}</script>`)
  .replace('<script src="app.js"></script>', () => `<script>${read('public/app.js')}</script>`)
  .replace('<div id="app" class="app">', () => `${banner}\n  <div id="app" class="app">`)
  .replace('<title>PayPlus - Earning</title>', () => '<title>PayPlus Demo</title>')
  .replace('viewport-fit=cover', () => '');
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('demo/index.html', (html.length / 1024).toFixed(0) + ' KB');
