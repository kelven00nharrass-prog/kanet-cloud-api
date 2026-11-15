const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1080px;
    background: #060913;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
  }

  /* Efeitos de Fundo Luminosos */
  .bg-glow-top {
    position: absolute;
    width: 850px;
    height: 480px;
    top: -120px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(245, 158, 11, 0.2) 0%, rgba(217, 119, 6, 0.12) 45%, transparent 70%);
    filter: blur(55px);
    pointer-events: none;
  }

  .bg-glow-bottom {
    position: absolute;
    width: 800px;
    height: 450px;
    bottom: -100px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(0, 229, 255, 0.16) 0%, rgba(16, 185, 129, 0.12) 50%, transparent 70%);
    filter: blur(65px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(circle at center, black 40%, transparent 88%);
    pointer-events: none;
  }

  /* Content Wrapper */
  .container {
    width: 960px;
    height: 960px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    z-index: 2;
  }

  /* Header Section */
  .header {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .top-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.4);
    padding: 7px 22px;
    border-radius: 50px;
    font-size: 12px;
    font-weight: 800;
    color: #FBBF24;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(245, 158, 11, 0.25);
    margin-bottom: 12px;
  }

  .top-badge .dot {
    width: 8px;
    height: 8px;
    background: #F59E0B;
    border-radius: 50%;
    box-shadow: 0 0 10px #F59E0B;
  }

  .brand-title {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.25em;
    color: #94A3B8;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .main-heading {
    font-family: 'Outfit', sans-serif;
    font-size: 44px;
    font-weight: 900;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: -0.02em;
    margin-bottom: 8px;
  }

  .gradient-gold {
    background: linear-gradient(135deg, #FFFFFF 15%, #FDE047 60%, #F59E0B 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .gradient-cyan {
    background: linear-gradient(135deg, #00FF9D 0%, #00F0FF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subheading {
    font-size: 14.5px;
    color: #94A3B8;
    max-width: 800px;
    line-height: 1.45;
  }

  .subheading b {
    color: #F1F5F9;
    font-weight: 700;
  }

  /* 2x2 Feature Grid */
  .features-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin: 12px 0;
  }

  .feature-card {
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 22px 24px;
    display: flex;
    align-items: flex-start;
    gap: 18px;
    position: relative;
    overflow: hidden;
    backdrop-filter: blur(18px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  /* Card Accents */
  .gold-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #FBBF24, #F59E0B);
  }
  .cyan-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #00F0FF, #38BDF8);
  }
  .emerald-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #00FF9D, #10B981);
  }
  .purple-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #C084FC, #818CF8);
  }

  .icon-wrapper {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 25px;
    flex-shrink: 0;
  }

  .gold-card .icon-wrapper {
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: #FBBF24;
    box-shadow: 0 0 20px rgba(245, 158, 11, 0.2);
  }

  .cyan-card .icon-wrapper {
    background: rgba(0, 229, 255, 0.12);
    border: 1px solid rgba(0, 229, 255, 0.35);
    color: #00F0FF;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.2);
  }

  .emerald-card .icon-wrapper {
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.35);
    color: #00FF9D;
    box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);
  }

  .purple-card .icon-wrapper {
    background: rgba(168, 85, 247, 0.12);
    border: 1px solid rgba(168, 85, 247, 0.35);
    color: #C084FC;
    box-shadow: 0 0 20px rgba(168, 85, 247, 0.2);
  }

  .feature-info {
    flex: 1;
  }

  .feature-title {
    font-family: 'Outfit', sans-serif;
    font-size: 19px;
    font-weight: 800;
    color: #FFFFFF;
    margin-bottom: 5px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .badge-tag {
    font-size: 10px;
    font-weight: 800;
    padding: 3px 8px;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .badge-tag.gold {
    background: rgba(245, 158, 11, 0.18);
    color: #FBBF24;
    border: 1px solid rgba(245, 158, 11, 0.35);
  }
  .badge-tag.cyan {
    background: rgba(0, 229, 255, 0.18);
    color: #00F0FF;
    border: 1px solid rgba(0, 229, 255, 0.35);
  }
  .badge-tag.emerald {
    background: rgba(16, 185, 129, 0.18);
    color: #00FF9D;
    border: 1px solid rgba(16, 185, 129, 0.35);
  }
  .badge-tag.purple {
    background: rgba(168, 85, 247, 0.18);
    color: #C084FC;
    border: 1px solid rgba(168, 85, 247, 0.35);
  }

  .feature-desc {
    font-size: 13.5px;
    color: #94A3B8;
    line-height: 1.45;
  }

  .feature-desc b {
    color: #F1F5F9;
  }

  /* Bottom Interactive Command Box */
  .bottom-box {
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    padding: 16px 22px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .cmd-group {
    display: flex;
    gap: 16px;
  }

  .cmd-item {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .cmd-code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13.5px;
    font-weight: 700;
    color: #00F0FF;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cmd-code.gold { color: #FBBF24; }
  .cmd-code.green { color: #00FF9D; }

  .cmd-desc {
    font-size: 11px;
    color: #94A3B8;
  }

  .contact-mini {
    text-align: right;
  }

  .contact-title {
    font-size: 11px;
    color: #94A3B8;
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .contact-phones {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #F8FAFC;
    margin-top: 2px;
  }

  /* Footer */
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12px;
    color: #64748B;
  }

  .footer-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #94A3B8;
    font-weight: 700;
  }

  .footer-brand i { color: #F59E0B; }

  .footer-pills {
    display: flex;
    gap: 10px;
  }

  .footer-pill {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    color: #94A3B8;
  }
</style>
</head>
<body>

<div class="bg-glow-top"></div>
<div class="bg-glow-bottom"></div>
<div class="grid-pattern"></div>

<div class="container">
  <!-- Header -->
  <div class="header">
    <div class="top-badge">
      <div class="dot"></div>
      BENEFÍCIO EXCLUSIVO • CLIENTES FIÉIS KA-NET
    </div>
    <div class="brand-title">KA-NET SYSTEM • CRÉDITO DE INTERNET</div>
    <h1 class="main-heading">
      COMO FUNCIONA O <span class="gradient-gold">TXENECO</span><br>
      DE MEGABYTES? <span class="gradient-cyan">💸</span>
    </h1>
    <p class="subheading">
      Ficou sem saldo na hora mais urgente? Com o <b>Txeneco Axion</b> você recebe Megas na hora e paga com tranquilidade depois! Conheça todas as regras:
    </p>
  </div>

  <!-- 4 Star Feature Cards Grid -->
  <div class="features-grid">
    <!-- Card 1: O que é o Txeneco -->
    <div class="feature-card gold-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-hand-holding-dollar"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          1. O que é o Txeneco?
          <span class="badge-tag gold">INTERNET A CRÉDITO</span>
        </div>
        <p class="feature-desc">
          É a nossa <b>linha de crédito de Megas</b> para clientes habituais. Você solicita os Megabytes adiantados no WhatsApp e eles são <b>enviados em segundos</b> para o seu celular.
        </p>
      </div>
    </div>

    <!-- Card 2: Quem Tem Direito & Limites -->
    <div class="feature-card cyan-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-medal"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          2. Quem Tem Direito? (Novos Limites)
          <span class="badge-tag cyan">ESCALÕES VIP</span>
        </div>
        <p class="feature-desc">
          Benefício exclusivo conforme o seu volume de compras:<br>
          • 🥉 <b>A partir de 100 compras:</b> até <b>3 GB</b> de limite<br>
          • 🥈 <b>A partir de 200 compras:</b> até <b>5 GB</b> de limite<br>
          • 👑 <b>A partir de 800 compras:</b> Escolha livre até <b>10 GB</b>!
        </p>
      </div>
    </div>

    <!-- Card 3: Taxa de Serviço Justa -->
    <div class="feature-card emerald-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-percent"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          3. Qual é a Taxa?
          <span class="badge-tag emerald">APENAS 10%</span>
        </div>
        <p class="feature-desc">
          Taxa de serviço simples de <b>apenas 10%</b> sobre o valor normal do pacote!<br>
          💡 <b>Exemplo:</b> 1 GB custa 23 MT ➔ taxa de 10% = 3 MT ➔ <b>Total a pagar: 26 MT</b>. Sem juros acumulados!
        </p>
      </div>
    </div>

    <!-- Card 4: Quando e Como Pagar -->
    <div class="feature-card purple-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-calendar-check"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          4. Quando e Como Pagar?
          <span class="badge-tag purple">PAGUE COM CALMA</span>
        </div>
        <p class="feature-desc">
          • Pague assim que fizer a sua próxima recarga.<br>
          • Para pedir novo crédito, a dívida anterior deve estar paga.<br>
          • Pague via M-Pesa / e-Mola e envie: <b>.pagar &lt;comprovativo&gt;</b>.
        </p>
      </div>
    </div>
  </div>

  <!-- Bottom Interactive Command Box -->
  <div class="bottom-box">
    <div class="cmd-group">
      <div class="cmd-item">
        <div class="cmd-code gold"><i class="fa-solid fa-info-circle"></i> .txenecar</div>
        <div class="cmd-desc">Ver seu limite e regras</div>
      </div>
      <div class="cmd-item">
        <div class="cmd-code"><i class="fa-solid fa-bolt"></i> .txenecar 1gb 84XXXXXXX</div>
        <div class="cmd-desc">Pedir megas a crédito</div>
      </div>
      <div class="cmd-item">
        <div class="cmd-code green"><i class="fa-solid fa-receipt"></i> .pagar &lt;comprovativo&gt;</div>
        <div class="cmd-desc">Quitar dívida e liberar teto</div>
      </div>
    </div>
    <div class="contact-mini">
      <div class="contact-title">Pagamentos Oficiais</div>
      <div class="contact-phones">
        M-Pesa: 856268811<br>
        e-Mola: 879691565
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-brand">
      <i class="fa-solid fa-shield-halved"></i>
      <span>KA-NET — O sistema mais completo, rápido e confiável de Moçambique 🇲🇿</span>
    </div>
    <div class="footer-pills">
      <span class="footer-pill">⚡ Entrega Imediata</span>
      <span class="footer-pill">💸 Taxa de 10%</span>
      <span class="footer-pill">🏆 Crédito até 4GB</span>
      <span class="footer-pill">🔒 100% Automático</span>
    </div>
  </div>
</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Gerando Guia do Txeneco Axion com Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar carregamento de fontes e ícones
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'marketing_guia_txeneco.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar também para o diretório de artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'marketing_guia_txeneco.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Imagem salva com sucesso em:', outputPath);
  console.log('✅ Imagem copiada para artefatos em:', artifactPath);
})();
