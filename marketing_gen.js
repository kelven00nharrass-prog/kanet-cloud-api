const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&family=Orbitron:wght@700;900&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1080px;
    background: #050d1a;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Montserrat', sans-serif;
    overflow: hidden;
  }

  .bg-glow {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 60% 50% at 50% 0%, rgba(0,180,255,0.18) 0%, transparent 70%),
      radial-gradient(ellipse 80% 60% at 50% 100%, rgba(0,80,200,0.25) 0%, transparent 70%),
      radial-gradient(circle at 10% 50%, rgba(0,120,255,0.08) 0%, transparent 50%),
      radial-gradient(circle at 90% 50%, rgba(0,200,255,0.08) 0%, transparent 50%);
  }

  /* Animated grid */
  .grid-bg {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0,150,255,0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,150,255,0.06) 1px, transparent 1px);
    background-size: 54px 54px;
  }

  /* Corner decorations */
  .corner {
    position: absolute;
    width: 120px;
    height: 120px;
    border-color: rgba(0,180,255,0.5);
    border-style: solid;
  }
  .corner-tl { top: 30px; left: 30px; border-width: 3px 0 0 3px; border-radius: 8px 0 0 0; }
  .corner-tr { top: 30px; right: 30px; border-width: 3px 3px 0 0; border-radius: 0 8px 0 0; }
  .corner-bl { bottom: 30px; left: 30px; border-width: 0 0 3px 3px; border-radius: 0 0 0 8px; }
  .corner-br { bottom: 30px; right: 30px; border-width: 0 3px 3px 0; border-radius: 0 0 8px 0; }

  .card {
    position: relative;
    z-index: 10;
    width: 880px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }

  /* Header / Brand */
  .brand-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
  }

  .logo-icon {
    width: 62px;
    height: 62px;
    background: linear-gradient(135deg, #0090ff, #00d4ff);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 25px rgba(0,180,255,0.6), inset 0 1px 1px rgba(255,255,255,0.2);
    font-size: 30px;
  }

  .brand-name {
    font-family: 'Orbitron', sans-serif;
    font-size: 38px;
    font-weight: 900;
    letter-spacing: 3px;
    background: linear-gradient(90deg, #ffffff, #00d4ff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: none;
  }

  .brand-tagline {
    font-size: 13px;
    color: rgba(0,210,255,0.75);
    letter-spacing: 4px;
    text-transform: uppercase;
    margin-top: -4px;
    text-align: center;
  }

  /* Divider */
  .divider {
    width: 100%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(0,180,255,0.6), transparent);
    margin: 18px 0;
  }

  /* Main offer box */
  .offer-box {
    width: 100%;
    background: linear-gradient(135deg,
      rgba(0,40,90,0.85) 0%,
      rgba(0,20,60,0.90) 50%,
      rgba(0,40,90,0.85) 100%);
    border: 1px solid rgba(0,180,255,0.35);
    border-radius: 24px;
    padding: 48px 60px 40px;
    position: relative;
    box-shadow:
      0 0 60px rgba(0,100,255,0.2),
      inset 0 1px 0 rgba(255,255,255,0.07);
    overflow: hidden;
  }

  .offer-box::before {
    content: '';
    position: absolute;
    top: -1px; left: 10%; right: 10%;
    height: 2px;
    background: linear-gradient(90deg, transparent, #00d4ff, transparent);
    border-radius: 2px;
  }

  /* "OFERTA ESPECIAL" badge */
  .badge {
    position: absolute;
    top: -18px;
    right: 50px;
    background: linear-gradient(90deg, #0060e0, #00aaff);
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 3px;
    text-transform: uppercase;
    padding: 6px 22px;
    border-radius: 20px;
    box-shadow: 0 4px 18px rgba(0,150,255,0.5);
  }

  .offer-label {
    font-size: 13px;
    font-weight: 700;
    color: rgba(0,210,255,0.8);
    letter-spacing: 5px;
    text-transform: uppercase;
    text-align: center;
    margin-bottom: 12px;
  }

  /* Price block */
  .price-row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .price-currency {
    font-size: 40px;
    font-weight: 800;
    color: rgba(255,255,255,0.6);
    line-height: 1;
    padding-bottom: 14px;
  }

  .price-amount {
    font-family: 'Orbitron', sans-serif;
    font-size: 130px;
    font-weight: 900;
    line-height: 1;
    background: linear-gradient(180deg, #ffffff 0%, #80e0ff 60%, #00aaff 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 30px rgba(0,180,255,0.5));
  }

  .price-suffix {
    font-size: 36px;
    font-weight: 800;
    color: rgba(255,255,255,0.5);
    line-height: 1;
    padding-bottom: 20px;
    letter-spacing: 1px;
  }

  /* Arrow + data */
  .equals-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 20px;
    margin: 16px 0 28px;
  }

  .eq-line {
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(0,180,255,0.4));
  }
  .eq-line.right {
    background: linear-gradient(90deg, rgba(0,180,255,0.4), transparent);
  }

  .data-pill {
    background: linear-gradient(90deg, #0050c0, #0090ff);
    border-radius: 50px;
    padding: 14px 40px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 0 35px rgba(0,140,255,0.45), inset 0 1px 0 rgba(255,255,255,0.2);
  }

  .data-amount {
    font-family: 'Orbitron', sans-serif;
    font-size: 48px;
    font-weight: 900;
    color: #ffffff;
    line-height: 1;
    letter-spacing: -1px;
  }

  .data-unit {
    font-size: 22px;
    font-weight: 700;
    color: rgba(255,255,255,0.75);
    line-height: 1;
  }

  /* Features row */
  .features {
    display: flex;
    justify-content: center;
    gap: 30px;
    margin-bottom: 36px;
  }

  .feature-chip {
    background: rgba(0,80,160,0.4);
    border: 1px solid rgba(0,160,255,0.3);
    border-radius: 30px;
    padding: 10px 24px;
    font-size: 14px;
    font-weight: 600;
    color: rgba(200,235,255,0.9);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .feature-icon {
    font-size: 16px;
  }

  /* Divider 2 */
  .divider2 {
    width: 100%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(0,140,255,0.3), transparent);
    margin-bottom: 28px;
  }

  /* Payment section */
  .payment-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 4px;
    color: rgba(0,210,255,0.6);
    text-transform: uppercase;
    text-align: center;
    margin-bottom: 18px;
  }

  .payment-row {
    display: flex;
    justify-content: center;
    gap: 20px;
  }

  .payment-card {
    background: rgba(0,20,50,0.8);
    border: 1px solid rgba(0,160,255,0.25);
    border-radius: 16px;
    padding: 16px 28px;
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    max-width: 360px;
  }

  .payment-logo {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 900;
    flex-shrink: 0;
  }

  .mpesa-logo {
    background: linear-gradient(135deg, #e5001a, #ff3344);
    color: #fff;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: -0.5px;
    box-shadow: 0 4px 15px rgba(229,0,26,0.4);
  }

  .emola-logo {
    background: linear-gradient(135deg, #ff6200, #ffaa00);
    color: #fff;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: -0.5px;
    box-shadow: 0 4px 15px rgba(255,98,0,0.4);
  }

  .payment-info {}
  .payment-name {
    font-size: 12px;
    font-weight: 700;
    color: rgba(0,210,255,0.7);
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .payment-number {
    font-family: 'Orbitron', sans-serif;
    font-size: 20px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: 1px;
  }

  /* CTA */
  .cta {
    margin-top: 28px;
    background: linear-gradient(90deg, #0060e0, #00b4f0, #0060e0);
    background-size: 200% 100%;
    border-radius: 50px;
    padding: 20px 60px;
    text-align: center;
    box-shadow: 0 0 40px rgba(0,140,255,0.4);
    width: 100%;
  }

  .cta-text {
    font-size: 22px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .cta-sub {
    font-size: 13px;
    color: rgba(255,255,255,0.75);
    margin-top: 4px;
    font-weight: 500;
  }

  /* Bottom bar */
  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-top: 22px;
    padding: 0 10px;
  }

  .bottom-info {
    font-size: 12px;
    color: rgba(0,180,255,0.5);
    font-weight: 500;
  }

  .validity-badge {
    background: rgba(0,80,160,0.4);
    border: 1px solid rgba(0,160,255,0.25);
    border-radius: 20px;
    padding: 6px 18px;
    font-size: 12px;
    font-weight: 700;
    color: rgba(200,235,255,0.8);
    letter-spacing: 1px;
  }
</style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="grid-bg"></div>
  <div class="corner corner-tl"></div>
  <div class="corner corner-tr"></div>
  <div class="corner corner-bl"></div>
  <div class="corner corner-br"></div>

  <div class="card">
    <!-- Brand -->
    <div class="brand-bar">
      <div class="logo-icon">📡</div>
      <div>
        <div class="brand-name">KA-NET</div>
        <div class="brand-tagline">Internet Rápida • Sempre Conectado</div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- Offer Box -->
    <div class="offer-box">
      <div class="badge">🔥 OFERTA DO DIA</div>

      <div class="offer-label">Pacote Diário</div>

      <!-- Price -->
      <div class="price-row">
        <div class="price-currency">MT</div>
        <div class="price-amount">23</div>
        <div class="price-suffix">.00</div>
      </div>

      <!-- Equals → Data -->
      <div class="equals-row">
        <div class="eq-line"></div>
        <div class="data-pill">
          <div class="data-amount">949</div>
          <div class="data-unit">MB</div>
        </div>
        <div class="eq-line right"></div>
      </div>

      <!-- Features -->
      <div class="features">
        <div class="feature-chip"><span class="feature-icon">⚡</span> Alta Velocidade</div>
        <div class="feature-chip"><span class="feature-icon">⏰</span> Válido 24 Horas</div>
        <div class="feature-chip"><span class="feature-icon">🌐</span> 4G / LTE</div>
      </div>

      <div class="divider2"></div>

      <!-- Payment -->
      <div class="payment-title">📲 Pague via</div>
      <div class="payment-row">
        <div class="payment-card">
          <div class="payment-logo mpesa-logo">M-PESA</div>
          <div class="payment-info">
            <div class="payment-name">M-Pesa</div>
            <div class="payment-number">85 626 8811</div>
          </div>
        </div>
        <div class="payment-card">
          <div class="payment-logo emola-logo">eMola</div>
          <div class="payment-info">
            <div class="payment-name">e-Mola</div>
            <div class="payment-number">86 488 2152</div>
          </div>
        </div>
      </div>

      <!-- CTA -->
      <div class="cta">
        <div class="cta-text">💬 Envie o comprovativo aqui!</div>
        <div class="cta-sub">O seu pacote é ativado automaticamente em segundos</div>
      </div>
    </div>

    <!-- Bottom -->
    <div class="bottom-bar">
      <div class="bottom-info">📞 Suporte: 850 401 416</div>
      <div class="validity-badge">✅ Activação Automática 24/7</div>
      <div class="bottom-info">Axion System © 2026</div>
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
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  // Wait for fonts
  await new Promise(r => setTimeout(r, 2500));
  const outputPath = path.resolve(__dirname, 'marketing_23mt.png');
  await page.screenshot({ path: outputPath, fullPage: false });
  await browser.close();
  console.log('✅ Imagem salva em:', outputPath);
})();
