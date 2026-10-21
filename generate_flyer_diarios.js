const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const pacotesDiarios = [
    { vol: '350 MB', preco: 11, desc: 'Económico', badge: '' },
    { vol: '550 MB', preco: 15, desc: 'Básico', badge: '' },
    { vol: '696 MB', preco: 18, desc: 'Redes Sociais', badge: '' },
    { vol: '800 MB', preco: 20, desc: 'Navegação Leve', badge: '' },
    { vol: '1.0 GB', preco: 23, desc: 'Mais Vendido', badge: '⚡ TOP 1', highlight: true },
    { vol: '1.2 GB', preco: 28, desc: 'Extra Dados', badge: '' },
    { vol: '1.3 GB', preco: 30, desc: 'Equilibrado', badge: '' },
    { vol: '1.6 GB', preco: 37, desc: 'Streaming', badge: '' },
    { vol: '2.0 GB', preco: 46, desc: 'Super Popular', badge: '🔥 POPULAR', highlight: true },
    { vol: '3.0 GB', preco: 69, desc: 'Vídeos & Jogos', badge: '' },
    { vol: '4.0 GB', preco: 92, desc: 'Trabalho / Estudo', badge: '' },
    { vol: '5.0 GB', preco: 115, desc: 'Super Oferta', badge: '🚀 CUSTO-BENEFÍCIO', highlight: true },
    { vol: '6.0 GB', preco: 138, desc: 'Download Rápido', badge: '' },
    { vol: '7.0 GB', preco: 161, desc: 'Heavy User', badge: '' },
    { vol: '8.0 GB', preco: 184, desc: 'Full HD', badge: '' },
    { vol: '9.0 GB', preco: 207, desc: 'Mega Volume', badge: '' },
    { vol: '10.0 GB', preco: 230, desc: 'Navegação Total VIP', badge: '👑 MÁXIMO VALOR', highlight: true }
];

const col1 = pacotesDiarios.slice(0, 9);
const col2 = pacotesDiarios.slice(9);

function renderCard(p) {
    const isHigh = p.highlight;
    return `
    <div class="pkg-card ${isHigh ? 'pkg-highlight' : ''}">
        <div class="pkg-left">
            <div class="pkg-icon ${isHigh ? 'icon-glow' : ''}">
                <i class="fa-solid ${isHigh ? (p.vol.includes('10') ? 'fa-crown' : 'fa-bolt') : 'fa-wifi'}"></i>
            </div>
            <div class="pkg-info">
                <div class="pkg-vol">${p.vol}</div>
                <div class="pkg-desc">${p.desc}</div>
            </div>
        </div>
        <div class="pkg-right">
            ${p.badge ? `<span class="pkg-badge">${p.badge}</span>` : ''}
            <div class="pkg-price">${p.preco} <span class="cur">MT</span></div>
        </div>
    </div>
    `;
}

const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@700;800&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1680px;
    background: #040814;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
    padding: 40px 45px 35px 45px;
  }

  /* Efeitos de Fundo Luminosos Cybernetic */
  .glow-top-left {
    position: absolute;
    width: 700px;
    height: 500px;
    top: -150px;
    left: -100px;
    background: radial-gradient(circle, rgba(0, 240, 255, 0.18) 0%, rgba(99, 102, 241, 0.12) 40%, transparent 70%);
    filter: blur(65px);
    pointer-events: none;
  }

  .glow-bottom-right {
    position: absolute;
    width: 750px;
    height: 600px;
    bottom: -150px;
    right: -100px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.22) 0%, rgba(0, 255, 157, 0.10) 45%, transparent 70%);
    filter: blur(75px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
  }

  /* Header */
  .header {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    z-index: 10;
  }

  .top-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(0, 240, 255, 0.08);
    border: 1px solid rgba(0, 240, 255, 0.35);
    padding: 6px 18px;
    border-radius: 50px;
    font-size: 13px;
    font-weight: 700;
    color: #00F0FF;
    letter-spacing: 2px;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(0, 240, 255, 0.2);
    margin-bottom: 12px;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    background: #00FF9D;
    border-radius: 50%;
    box-shadow: 0 0 10px #00FF9D;
  }

  .brand-title {
    font-family: 'Outfit', sans-serif;
    font-size: 52px;
    font-weight: 900;
    letter-spacing: -1px;
    line-height: 1.1;
    background: linear-gradient(135deg, #FFFFFF 20%, #A5F3FC 60%, #00F0FF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 4px 15px rgba(0, 240, 255, 0.3));
  }

  .category-title {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: linear-gradient(90deg, rgba(99, 102, 241, 0.2), rgba(0, 240, 255, 0.2));
    border: 1px solid rgba(0, 240, 255, 0.3);
    padding: 8px 24px;
    border-radius: 12px;
    font-family: 'Outfit', sans-serif;
    font-size: 22px;
    font-weight: 800;
    color: #F8FAFC;
    letter-spacing: 1px;
    margin-top: 10px;
  }

  .category-title i {
    color: #00F0FF;
  }

  .subtext {
    font-size: 14px;
    color: #94A3B8;
    margin-top: 8px;
    font-weight: 500;
  }

  /* Highlight Feature Pill Banner */
  .features-strip {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 18px 0;
    z-index: 10;
  }

  .feature-pill {
    flex: 1;
    background: rgba(15, 23, 42, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
    color: #CBD5E1;
  }

  .feature-pill i {
    font-size: 16px;
    color: #00F0FF;
  }

  /* Two Columns Grid */
  .grid-container {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    z-index: 10;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Package Cards */
  .pkg-card {
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
    border-radius: 14px;
    padding: 11px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: all 0.2s ease;
  }

  .pkg-highlight {
    background: linear-gradient(135deg, rgba(0, 240, 255, 0.12) 0%, rgba(99, 102, 241, 0.12) 100%);
    border: 1.5px solid rgba(0, 240, 255, 0.45);
    box-shadow: 0 0 20px rgba(0, 240, 255, 0.12);
  }

  .pkg-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .pkg-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    color: #94A3B8;
  }

  .icon-glow {
    background: rgba(0, 240, 255, 0.15);
    border-color: rgba(0, 240, 255, 0.4);
    color: #00F0FF;
    box-shadow: 0 0 12px rgba(0, 240, 255, 0.3);
  }

  .pkg-info {
    display: flex;
    flex-direction: column;
  }

  .pkg-vol {
    font-family: 'Outfit', sans-serif;
    font-size: 20px;
    font-weight: 800;
    color: #FFFFFF;
    letter-spacing: -0.5px;
  }

  .pkg-highlight .pkg-vol {
    color: #00F0FF;
    text-shadow: 0 0 12px rgba(0, 240, 255, 0.4);
  }

  .pkg-desc {
    font-size: 11px;
    color: #64748B;
    font-weight: 500;
  }

  .pkg-highlight .pkg-desc {
    color: #94A3B8;
  }

  .pkg-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .pkg-badge {
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: linear-gradient(90deg, #00F0FF, #00FF9D);
    color: #040814;
    padding: 2px 7px;
    border-radius: 6px;
  }

  .pkg-price {
    font-family: 'JetBrains Mono', monospace;
    font-size: 24px;
    font-weight: 800;
    color: #F8FAFC;
  }

  .pkg-highlight .pkg-price {
    color: #00FF9D;
    text-shadow: 0 0 10px rgba(0, 255, 157, 0.4);
  }

  .cur {
    font-size: 14px;
    font-weight: 600;
    color: #94A3B8;
  }

  /* Bottom Details Section */
  .bottom-card {
    width: 100%;
    background: rgba(15, 23, 42, 0.75);
    border: 1px solid rgba(0, 240, 255, 0.25);
    border-radius: 18px;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    z-index: 10;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }

  .bottom-grid {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 20px;
    align-items: center;
  }

  /* Payment Channels */
  .payments-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .payments-title {
    font-size: 12px;
    font-weight: 800;
    color: #00F0FF;
    letter-spacing: 1px;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .payment-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 8px 14px;
  }

  .pay-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 13px;
  }

  .dot-red { width: 10px; height: 10px; border-radius: 50%; background: #EF4444; }
  .dot-orange { width: 10px; height: 10px; border-radius: 50%; background: #F59E0B; }

  .pay-number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
    font-weight: 800;
    color: #FFFFFF;
    background: rgba(0, 0, 0, 0.3);
    padding: 3px 8px;
    border-radius: 6px;
  }

  /* Activation Steps */
  .steps-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: #CBD5E1;
  }

  .step-num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(0, 240, 255, 0.15);
    border: 1px solid rgba(0, 240, 255, 0.4);
    color: #00F0FF;
    font-size: 11px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Footer strip */
  .footer-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12px;
    color: #94A3B8;
  }

  .support-tag {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #FFFFFF;
    font-weight: 700;
  }

  .support-tag span {
    color: #00FF9D;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
  }
</style>
</head>
<body>

  <!-- Glows -->
  <div class="glow-top-left"></div>
  <div class="glow-bottom-right"></div>
  <div class="grid-pattern"></div>

  <!-- HEADER -->
  <div class="header">
    <div class="top-badge">
      <div class="pulse-dot"></div>
      Sistema Oficial Ka-Net • Ativação 24H
    </div>
    <h1 class="brand-title">KA-NET SYSTEM</h1>
    <div class="category-title">
      <i class="fa-solid fa-bolt-lightning"></i>
      TABELA DE PACOTES DIÁRIOS (24H)
    </div>
    <div class="subtext">Os melhores preços de internet Vodacom em Moçambique com recarga 100% automática</div>
  </div>

  <!-- FEATURES STRIP -->
  <div class="features-strip">
    <div class="feature-pill">
      <i class="fa-solid fa-bolt"></i>
      <span>Ativação em 10 Segundos</span>
    </div>
    <div class="feature-pill">
      <i class="fa-solid fa-shield-halved"></i>
      <span>Envio Seguro & Oficial</span>
    </div>
    <div class="feature-pill">
      <i class="fa-solid fa-clock"></i>
      <span>Disponível 24/7 sem Pausa</span>
    </div>
    <div class="feature-pill">
      <i class="fa-solid fa-credit-card"></i>
      <span>Crédito Txeneco VIP</span>
    </div>
  </div>

  <!-- TWO COLUMNS GRID -->
  <div class="grid-container">
    <!-- Coluna 1: 350MB até 2GB -->
    <div class="column">
      ${col1.map(renderCard).join('')}
    </div>

    <!-- Coluna 2: 3GB até 10GB -->
    <div class="column">
      ${col2.map(renderCard).join('')}
    </div>
  </div>

  <!-- BOTTOM CARD: PAGAMENTO & ATIVAÇÃO -->
  <div class="bottom-card">
    <div class="bottom-grid">
      <!-- Contas de Pagamento -->
      <div class="payments-box">
        <div class="payments-title">
          <i class="fa-solid fa-wallet"></i> Contas de Pagamento Oficiais
        </div>
        <div class="payment-item">
          <div class="pay-brand">
            <div class="dot-red"></div>
            <span>M-Pesa (Kelven Junior)</span>
          </div>
          <div class="pay-number">856268811</div>
        </div>
        <div class="payment-item">
          <div class="pay-brand">
            <div class="dot-orange"></div>
            <span>e-Mola (Catia Anabela)</span>
          </div>
          <div class="pay-number">864882152</div>
        </div>
      </div>

      <!-- Como Ativar -->
      <div class="steps-box">
        <div class="payments-title" style="color:#00FF9D;">
          <i class="fa-solid fa-wand-magic-sparkles"></i> Como Comprar em 3 Passos
        </div>
        <div class="step-row">
          <div class="step-num">1</div>
          <span>Transfira o valor exato do pacote desejado.</span>
        </div>
        <div class="step-row">
          <div class="step-num">2</div>
          <span>Envie o SMS de confirmação no WhatsApp.</span>
        </div>
        <div class="step-row">
          <div class="step-num">3</div>
          <span>Coloque o seu <b>número Vodacom na última linha</b>!</span>
        </div>
      </div>
    </div>

    <!-- Linha de Suporte e Recarga Automática -->
    <div class="footer-strip">
      <div>⚡ <b>Dica:</b> Envie <b>.configurar</b> para recarregar no automático sem mandar comprovativo!</div>
      <div class="support-tag">
        <i class="fa-brands fa-whatsapp"></i> Suporte Humano: <span>850401416</span>
      </div>
    </div>
  </div>

</body>
</html>`;

async function main() {
    console.log('🚀 Gerando Flyer Moderno dos Pacotes Diários Ka-Net...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1680, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outPath = path.join(__dirname, 'marketing_pacotes_diarios.png');
    await page.screenshot({ path: outPath, type: 'png' });

    console.log('✅ Flyer salvo em:', outPath);

    const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
    if (fs.existsSync(artifactDir)) {
        const artifactPath = path.join(artifactDir, 'marketing_pacotes_diarios.png');
        fs.copyFileSync(outPath, artifactPath);
        console.log('✅ Flyer copiado para artefatos em:', artifactPath);
    }

    await browser.close();
}

main().catch(err => {
    console.error('❌ Erro ao gerar flyer:', err);
    process.exit(1);
});
