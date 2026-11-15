const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const pacotesColuna1 = [
  { volume: '350 MB', preco: '11 MT', badge: '' },
  { volume: '550 MB', preco: '15 MT', badge: '' },
  { volume: '800 MB', preco: '20 MT', badge: '' },
  { volume: '1.0 GB', preco: '23 MT', badge: '⚡ MAIS VENDIDO' },
  { volume: '1.5 GB', preco: '35 MT', badge: '' },
  { volume: '2.0 GB', preco: '46 MT', badge: '' }
];

const pacotesColuna2 = [
  { volume: '3.0 GB', preco: '69 MT', badge: '' },
  { volume: '4.0 GB', preco: '92 MT', badge: '' },
  { volume: '5.0 GB', preco: '115 MT', badge: '⭐ RECOMENDADO' },
  { volume: '6.0 GB', preco: '138 MT', badge: '' },
  { volume: '8.0 GB', preco: '184 MT', badge: '' },
  { volume: '10.0 GB', preco: '230 MT', badge: '🔥 SUPER VALOR' }
];

const renderRows = (list) => list.map(p => {
  const isHighlight = p.badge !== '';
  return `
    <div class="price-row ${isHighlight ? 'highlight' : ''}">
      <div class="row-left">
        <span class="vol-text">${p.volume}</span>
        ${p.badge ? `<span class="row-badge">${p.badge}</span>` : ''}
      </div>
      <div class="row-arrow"><i class="fa-solid fa-arrow-right"></i></div>
      <div class="row-price">
        <span class="currency">MT</span>
        <span class="value">${p.preco.replace(' MT', '')}</span>
      </div>
    </div>
  `;
}).join('');

const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=Outfit:wght@500;600;700;800;900&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1080px;
    background: #040815;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
  }

  /* Efeitos de Luz de Fundo */
  .bg-glow-sun {
    position: absolute;
    width: 750px;
    height: 500px;
    top: -120px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(251, 191, 36, 0.22) 0%, rgba(245, 158, 11, 0.1) 40%, transparent 70%);
    filter: blur(65px);
    pointer-events: none;
  }

  .bg-glow-cyan {
    position: absolute;
    width: 600px;
    height: 450px;
    bottom: -80px;
    left: 5%;
    background: radial-gradient(circle, rgba(6, 182, 212, 0.16) 0%, transparent 65%);
    filter: blur(70px);
    pointer-events: none;
  }

  .bg-glow-blue {
    position: absolute;
    width: 600px;
    height: 450px;
    bottom: -80px;
    right: 5%;
    background: radial-gradient(circle, rgba(59, 130, 246, 0.18) 0%, transparent 65%);
    filter: blur(70px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
    background-size: 50px 50px;
    pointer-events: none;
  }

  .container {
    width: 1000px;
    height: 1000px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    z-index: 10;
    position: relative;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 8px;
  }

  .logo-area {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .logo-icon {
    width: 56px;
    height: 56px;
    background: linear-gradient(135deg, #00F0FF, #3B82F6);
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    color: #030712;
    box-shadow: 0 0 25px rgba(0, 240, 255, 0.4);
  }

  .logo-text h1 {
    font-family: 'Outfit', sans-serif;
    font-size: 30px;
    font-weight: 900;
    letter-spacing: 1px;
    background: linear-gradient(90deg, #FFFFFF, #CBD5E1);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .logo-text p {
    font-size: 12px;
    color: #00F0FF;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .sunday-badge {
    display: flex;
    align-items: center;
    gap: 10px;
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.16), rgba(245, 158, 11, 0.08));
    border: 1.5px solid rgba(251, 191, 36, 0.4);
    padding: 9px 20px;
    border-radius: 50px;
    box-shadow: 0 0 25px rgba(245, 158, 11, 0.2);
  }

  .sunday-badge i {
    color: #FBBF24;
    font-size: 16px;
  }

  .sunday-badge span {
    font-size: 13px;
    font-weight: 800;
    color: #FDE68A;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  /* Title Area */
  .title-area {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .title-tag {
    font-size: 12px;
    font-weight: 800;
    color: #38BDF8;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(56, 189, 248, 0.3);
    padding: 4px 14px;
    border-radius: 20px;
  }

  .main-title {
    font-family: 'Outfit', sans-serif;
    font-size: 44px;
    font-weight: 900;
    line-height: 1.1;
    letter-spacing: -0.5px;
  }

  .main-title .highlight-gold {
    background: linear-gradient(90deg, #FDE68A, #F59E0B);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 30px rgba(245, 158, 11, 0.3);
  }

  .main-title .highlight-cyan {
    background: linear-gradient(90deg, #38BDF8, #00F0FF);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 30px rgba(0, 240, 255, 0.3);
  }

  .subtitle {
    font-size: 15px;
    color: #94A3B8;
    font-weight: 500;
  }

  /* Pricing Grid */
  .pricing-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .col-card {
    background: rgba(15, 23, 42, 0.75);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    backdrop-filter: blur(12px);
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4);
  }

  .col-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .col-title {
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 1px;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .col-1-title { color: #38BDF8; }
  .col-2-title { color: #FBBF24; }

  .col-badge {
    font-size: 11px;
    font-weight: 700;
    color: #94A3B8;
    background: rgba(255, 255, 255, 0.05);
    padding: 3px 10px;
    border-radius: 12px;
  }

  .price-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(2, 6, 23, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 14px;
    padding: 10px 14px;
    transition: all 0.2s ease;
  }

  .price-row.highlight {
    background: linear-gradient(135deg, rgba(6, 182, 212, 0.12), rgba(59, 130, 246, 0.12));
    border: 1.5px solid rgba(0, 240, 255, 0.35);
    box-shadow: 0 4px 15px rgba(0, 240, 255, 0.15);
  }

  .row-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .vol-text {
    font-family: 'Outfit', sans-serif;
    font-size: 20px;
    font-weight: 900;
    color: #FFFFFF;
    letter-spacing: 0.5px;
  }

  .row-badge {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 6px;
    background: linear-gradient(135deg, #F59E0B, #D97706);
    color: #030712;
    text-transform: uppercase;
  }

  .row-arrow {
    color: rgba(255, 255, 255, 0.25);
    font-size: 13px;
  }

  .row-price {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .row-price .currency {
    font-size: 13px;
    font-weight: 800;
    color: #00F0FF;
  }

  .row-price .value {
    font-family: 'Outfit', sans-serif;
    font-size: 24px;
    font-weight: 900;
    color: #FFFFFF;
  }

  /* Referral Promo Banner */
  .referral-banner {
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.14), rgba(217, 119, 6, 0.08));
    border: 1.5px solid rgba(251, 191, 36, 0.35);
    border-radius: 18px;
    padding: 12px 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.35);
  }

  .ref-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .ref-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: linear-gradient(135deg, #F59E0B, #D97706);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: #FFFFFF;
    box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4);
  }

  .ref-text h3 {
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 800;
    color: #FFFFFF;
  }

  .ref-text p {
    font-size: 12px;
    color: #FDE68A;
  }

  .ref-badge {
    background: #00F0FF;
    color: #030712;
    padding: 8px 16px;
    border-radius: 12px;
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    font-weight: 900;
  }

  /* Footer CTA */
  .footer-cta {
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(30, 41, 59, 0.7));
    border: 1.5px solid rgba(56, 189, 248, 0.35);
    border-radius: 22px;
    padding: 14px 26px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .payment-methods {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .pay-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 6px 14px;
    border-radius: 30px;
    font-size: 13px;
    font-weight: 700;
    color: #CBD5E1;
  }

  .pay-pill.mpesa { border-color: rgba(239, 68, 68, 0.4); color: #FCA5A5; }
  .pay-pill.emola { border-color: rgba(245, 158, 11, 0.4); color: #FDE68A; }

  .order-btn {
    background: linear-gradient(135deg, #22C55E, #16A34A);
    color: #FFFFFF;
    padding: 12px 24px;
    border-radius: 14px;
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 800;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 6px 20px rgba(34, 197, 94, 0.35);
  }

</style>
</head>
<body>

<div class="bg-glow-sun"></div>
<div class="bg-glow-cyan"></div>
<div class="bg-glow-blue"></div>
<div class="grid-pattern"></div>

<div class="container">

  <!-- Header -->
  <div class="header">
    <div class="logo-area">
      <div class="logo-icon">
        <i class="fa-solid fa-bolt"></i>
      </div>
      <div class="logo-text">
        <h1>KA-NET</h1>
        <p>Automação de Dados</p>
      </div>
    </div>

    <div class="sunday-badge">
      <i class="fa-solid fa-sun"></i>
      <span>Feliz Domingo</span>
    </div>
  </div>

  <!-- Title Area -->
  <div class="title-area">
    <span class="title-tag">⚡ Tabela Oficial Vodacom 24H</span>
    <h2 class="main-title">
      Pacotes Diários <span class="highlight-gold">Mais Baratos</span> de <span class="highlight-cyan">Moçambique</span>!
    </h2>
    <p class="subtitle">
      Válidos por 24 horas • Ativação automática no teu número em segundos via M-Pesa e e-Mola!
    </p>
  </div>

  <!-- Pricing Grid -->
  <div class="pricing-grid">
    <!-- Coluna 1 -->
    <div class="col-card">
      <div class="col-header">
        <div class="col-title col-1-title">
          <i class="fa-solid fa-mobile-screen-button"></i>
          <span>Económicos &amp; Rápidos</span>
        </div>
        <span class="col-badge">350 MB a 2 GB</span>
      </div>
      ${renderRows(pacotesColuna1)}
    </div>

    <!-- Coluna 2 -->
    <div class="col-card">
      <div class="col-header">
        <div class="col-title col-2-title">
          <i class="fa-solid fa-rocket"></i>
          <span>Pacotes Turbo Gigas</span>
        </div>
        <span class="col-badge">3 GB a 10 GB</span>
      </div>
      ${renderRows(pacotesColuna2)}
    </div>
  </div>

  <!-- Referral Mini-Banner -->
  <div class="referral-banner">
    <div class="ref-left">
      <div class="ref-icon">
        <i class="fa-solid fa-gift"></i>
      </div>
      <div class="ref-text">
        <h3>Indica 3 Amigos &amp; Ganha 500 MB Grátis! 🚀</h3>
        <p>Pede o teu código exclusivo no WhatsApp digitando <strong>4</strong> ou <strong>!convite</strong></p>
      </div>
    </div>
    <div class="ref-badge">+500 MB BÓNUS</div>
  </div>

  <!-- Footer CTA -->
  <div class="footer-cta">
    <div class="payment-methods">
      <span style="font-size: 13px; font-weight: 700; color: #94A3B8;">Pagamentos 24/7:</span>
      <div class="pay-pill mpesa">
        <i class="fa-solid fa-money-bill-wave"></i>
        <span>M-Pesa</span>
      </div>
      <div class="pay-pill emola">
        <i class="fa-solid fa-wallet"></i>
        <span>e-Mola</span>
      </div>
    </div>

    <div class="order-btn">
      <i class="fa-brands fa-whatsapp"></i>
      <span>Comprar no WhatsApp</span>
    </div>
  </div>

</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Gerando Flyer de Domingo com Tabela Diária com Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar renderização das fontes e ícones
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'flyer_domingo_tabela_diarios.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar também para o diretório de artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'flyer_domingo_tabela_diarios.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Flyer salvo com sucesso em:', outputPath);
  console.log('✅ Flyer copiado para artefatos em:', artifactPath);
})();
