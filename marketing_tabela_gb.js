const puppeteer = require('puppeteer');
const path = require('path');

// 1GB = 23MT
const precoPerGB = 23;
const pacotes = [];
for (let gb = 1; gb <= 10; gb++) {
  pacotes.push({ gb, preco: gb * precoPerGB });
}

// Build rows HTML
const rows = pacotes.map((p, i) => {
  const isDestaque = p.gb === 1 || p.gb === 5 || p.gb === 10;
  const highlight = isDestaque ? 'style="background: rgba(0,100,220,0.25); border-color: rgba(0,180,255,0.4);"' : '';
  const badge = p.gb === 10 ? '<span class="badge-melhor">🔥 MELHOR VALOR</span>' : (p.gb === 1 ? '<span class="badge-pop">⚡ POPULAR</span>' : '');
  return `
  <div class="row ${isDestaque ? 'destaque' : ''}" ${highlight}>
    <div class="row-gb"><span class="gb-num">${p.gb}</span><span class="gb-unit">GB</span></div>
    <div class="row-arrow">→</div>
    <div class="row-price"><span class="price-cur">MT</span><span class="price-val">${p.preco}</span></div>
    ${badge ? `<div class="row-badge">${badge}</div>` : '<div class="row-badge"></div>'}
  </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&family=Orbitron:wght@600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    width: 1080px;
    height: 1480px;
    background: #04091a;
    font-family: 'Montserrat', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .bg-glow {
    position: absolute; inset: 0;
    background:
      radial-gradient(ellipse 70% 40% at 50% 0%, rgba(0,160,255,0.2) 0%, transparent 65%),
      radial-gradient(ellipse 80% 40% at 50% 100%, rgba(0,60,180,0.2) 0%, transparent 65%);
  }

  .grid-bg {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(0,140,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,140,255,0.05) 1px, transparent 1px);
    background-size: 60px 60px;
  }

  .corner {
    position: absolute; width: 100px; height: 100px;
    border-color: rgba(0,180,255,0.45); border-style: solid;
  }
  .tl { top:25px; left:25px; border-width:3px 0 0 3px; border-radius:8px 0 0 0; }
  .tr { top:25px; right:25px; border-width:3px 3px 0 0; border-radius:0 8px 0 0; }
  .bl { bottom:25px; left:25px; border-width:0 0 3px 3px; border-radius:0 0 0 8px; }
  .br { bottom:25px; right:25px; border-width:0 3px 3px 0; border-radius:0 0 8px 0; }

  .wrap {
    position: relative; z-index: 10;
    width: 920px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }

  /* ── Header ── */
  .header {
    display: flex; align-items: center; gap: 18px;
    margin-bottom: 10px;
  }
  .logo-box {
    width: 64px; height: 64px;
    background: linear-gradient(135deg, #0090ff, #00d4ff);
    border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
    font-size: 32px;
    box-shadow: 0 0 28px rgba(0,180,255,0.55);
  }
  .brand { font-family:'Orbitron',sans-serif; font-size:40px; font-weight:900; letter-spacing:4px;
    background: linear-gradient(90deg,#fff,#00d4ff); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .tagline { font-size:12px; color:rgba(0,210,255,0.7); letter-spacing:4px; text-transform:uppercase; margin-top:-4px; }

  .div-line {
    width:100%; height:1px;
    background: linear-gradient(90deg, transparent, rgba(0,180,255,0.6), transparent);
    margin: 16px 0;
  }

  /* ── Title ── */
  .title-block { text-align: center; margin-bottom: 8px; }
  .title-label { font-size:12px; letter-spacing:5px; color:rgba(0,210,255,0.65); text-transform:uppercase; font-weight:700; margin-bottom:6px; }
  .title-main {
    font-family:'Orbitron',sans-serif; font-size:30px; font-weight:900;
    color:#fff; letter-spacing:1px;
  }
  .title-sub {
    font-size:14px; color:rgba(0,200,255,0.7); font-weight:600; margin-top:6px;
  }

  /* ── Table card ── */
  .table-card {
    width: 100%;
    background: rgba(0,20,55,0.80);
    border: 1px solid rgba(0,140,255,0.3);
    border-radius: 24px;
    padding: 10px 36px 20px;
    box-shadow: 0 0 60px rgba(0,80,200,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
    overflow: hidden;
    position: relative;
  }
  .table-card::before {
    content:''; position:absolute; top:-1px; left:15%; right:15%; height:2px;
    background: linear-gradient(90deg, transparent, #00d4ff, transparent);
  }

  /* Column headers */
  .col-header {
    display: flex; align-items: center;
    padding: 12px 0 8px;
    border-bottom: 1px solid rgba(0,140,255,0.2);
    margin-bottom: 6px;
  }
  .col-header .h-gb { flex: 0 0 220px; font-size:11px; font-weight:700; letter-spacing:3px; color:rgba(0,210,255,0.55); text-transform:uppercase; }
  .col-header .h-arrow { flex: 0 0 50px; }
  .col-header .h-price { flex: 1; font-size:11px; font-weight:700; letter-spacing:3px; color:rgba(0,210,255,0.55); text-transform:uppercase; }

  /* Row */
  .row {
    display: flex; align-items: center;
    padding: 13px 20px;
    border-radius: 14px;
    border: 1px solid rgba(0,100,200,0.15);
    margin-bottom: 8px;
    transition: background 0.2s;
    position: relative;
  }

  .row-gb {
    flex: 0 0 200px;
    display: flex; align-items: baseline; gap: 6px;
  }
  .gb-num {
    font-family:'Orbitron',sans-serif; font-size:42px; font-weight:900;
    background: linear-gradient(180deg, #ffffff 0%, #80e0ff 70%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    line-height: 1;
  }
  .gb-unit {
    font-size:20px; font-weight:800; color:rgba(0,210,255,0.8); line-height:1; padding-bottom:4px;
  }

  .row-arrow {
    flex: 0 0 50px;
    font-size: 22px; color: rgba(0,180,255,0.4); text-align:center;
  }

  .row-price {
    flex: 1;
    display: flex; align-items: baseline; gap: 6px;
  }
  .price-cur {
    font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.45); padding-bottom:2px;
  }
  .price-val {
    font-family:'Orbitron',sans-serif; font-size:38px; font-weight:900;
    color: #fff; line-height:1;
    text-shadow: 0 0 20px rgba(0,180,255,0.3);
  }

  .row-badge { flex: 0 0 160px; text-align:right; }

  .badge-melhor {
    background: linear-gradient(90deg, #ff6200, #ffaa00);
    color: #fff; font-size:11px; font-weight:800; letter-spacing:1px;
    padding: 5px 12px; border-radius:20px;
    box-shadow: 0 3px 12px rgba(255,98,0,0.4);
    white-space: nowrap;
  }
  .badge-pop {
    background: linear-gradient(90deg, #0060e0, #00b4ff);
    color: #fff; font-size:11px; font-weight:800; letter-spacing:1px;
    padding: 5px 12px; border-radius:20px;
    box-shadow: 0 3px 12px rgba(0,100,255,0.4);
    white-space: nowrap;
  }

  /* ── Per-GB callout ── */
  .per-gb-bar {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    margin: 14px 0 4px;
    background: linear-gradient(90deg, rgba(0,60,160,0.4), rgba(0,100,200,0.5), rgba(0,60,160,0.4));
    border: 1px solid rgba(0,160,255,0.3);
    border-radius: 50px;
    padding: 12px 40px;
    width: 100%;
  }
  .per-gb-text {
    font-size: 16px; font-weight: 700; color: rgba(200,235,255,0.85);
    letter-spacing: 1px;
  }
  .per-gb-price {
    font-family:'Orbitron',sans-serif; font-size:22px; font-weight:900;
    color: #00d4ff;
  }

  /* ── Payment section ── */
  .pay-section {
    width: 100%; margin-top: 14px;
    display: flex; gap: 16px;
  }
  .pay-card {
    flex: 1;
    background: rgba(0,15,45,0.85);
    border: 1px solid rgba(0,140,255,0.22);
    border-radius: 16px;
    padding: 14px 22px;
    display: flex; align-items: center; gap: 14px;
  }
  .pay-logo {
    width: 46px; height: 46px; border-radius: 12px;
    display:flex; align-items:center; justify-content:center;
    font-size:11px; font-weight:900; color:#fff; flex-shrink:0;
    letter-spacing: -0.5px;
  }
  .mpesa { background: linear-gradient(135deg,#e5001a,#ff3344); box-shadow:0 4px 14px rgba(229,0,26,0.4); }
  .emola { background: linear-gradient(135deg,#ff6200,#ffaa00); box-shadow:0 4px 14px rgba(255,98,0,0.4); }
  .pay-name { font-size:11px; font-weight:700; color:rgba(0,210,255,0.65); letter-spacing:1px; text-transform:uppercase; }
  .pay-num { font-family:'Orbitron',sans-serif; font-size:20px; font-weight:700; color:#fff; letter-spacing:1px; }

  /* ── CTA ── */
  .cta {
    width:100%; margin-top:14px;
    background: linear-gradient(90deg,#0060e0,#00b4f0,#0060e0);
    border-radius:50px; padding:18px 40px;
    text-align:center;
    box-shadow: 0 0 40px rgba(0,140,255,0.35);
  }
  .cta-main { font-size:20px; font-weight:800; color:#fff; letter-spacing:1px; text-transform:uppercase; }
  .cta-sub { font-size:13px; color:rgba(255,255,255,0.72); margin-top:3px; }

  /* ── Footer ── */
  .footer {
    width:100%; display:flex; justify-content:space-between; align-items:center;
    margin-top:16px; padding:0 8px;
  }
  .footer-info { font-size:12px; color:rgba(0,180,255,0.45); font-weight:500; }
  .footer-badge {
    background:rgba(0,70,150,0.4); border:1px solid rgba(0,160,255,0.22);
    border-radius:20px; padding:5px 16px;
    font-size:12px; font-weight:700; color:rgba(200,235,255,0.75);
  }
</style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="grid-bg"></div>
  <div class="corner tl"></div>
  <div class="corner tr"></div>
  <div class="corner bl"></div>
  <div class="corner br"></div>

  <div class="wrap">
    <!-- Brand -->
    <div class="header">
      <div class="logo-box">📡</div>
      <div>
        <div class="brand">KA-NET</div>
        <div class="tagline">Internet Rápida • Sempre Conectado</div>
      </div>
    </div>

    <div class="div-line"></div>

    <!-- Title -->
    <div class="title-block">
      <div class="title-label">Tabela de Preços</div>
      <div class="title-main">📶 Pacotes por Gigabyte</div>
      <div class="title-sub">Pague exatamente o que precisa — sem desperdício</div>
    </div>

    <div class="div-line" style="margin:10px 0 14px;"></div>

    <!-- Table -->
    <div class="table-card">
      <div class="col-header">
        <div class="h-gb">Pacote</div>
        <div class="h-arrow"></div>
        <div class="h-price">Preço</div>
        <div style="flex:0 0 160px;"></div>
      </div>
      ${rows}
    </div>

    <!-- Per-GB rate -->
    <div class="per-gb-bar">
      <div class="per-gb-text">💡 Cada 1 GB custa apenas</div>
      <div class="per-gb-price">23 MT</div>
      <div class="per-gb-text">— sem taxas escondidas</div>
    </div>

    <!-- Payment -->
    <div class="pay-section">
      <div class="pay-card">
        <div class="pay-logo mpesa">M-PESA</div>
        <div>
          <div class="pay-name">M-Pesa</div>
          <div class="pay-num">85 626 8811</div>
        </div>
      </div>
      <div class="pay-card">
        <div class="pay-logo emola">eMola</div>
        <div>
          <div class="pay-name">e-Mola</div>
          <div class="pay-num">86 488 2152</div>
        </div>
      </div>
    </div>

    <!-- CTA -->
    <div class="cta">
      <div class="cta-main">💬 Envie o comprovativo aqui!</div>
      <div class="cta-sub">Activação automática • Disponível 24 horas por dia, 7 dias por semana</div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-info">📞 Suporte: 850 401 416</div>
      <div class="footer-badge">✅ Activação Automática 24/7</div>
      <div class="footer-info">Axion System © 2026</div>
    </div>
  </div>
</body>
</html>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1480, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2500));
  const outputPath = path.resolve(__dirname, 'marketing_tabela_gb.png');
  await page.screenshot({ path: outputPath, fullPage: false });
  await browser.close();
  console.log('✅ Imagem salva em:', outputPath);
})();
