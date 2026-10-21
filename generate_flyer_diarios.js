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
    { vol: '8.0 GB', preco: 184, desc: 'Full HD 24h', badge: '' },
    { vol: '9.0 GB', preco: 207, desc: 'Mega Volume', badge: '' },
    { vol: '10.0 GB', preco: 230, desc: 'VIP Total', badge: '👑 MÁXIMO VALOR', highlight: true }
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
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800;900&family=Plus+Jakarta+Sans:wght@500;600;700;800;900&family=JetBrains+Mono:wght@700;800&family=Monoton&family=Bungee+Outline&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1920px;
    background: #020718;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #FFFFFF;
    overflow: hidden;
    position: relative;
    padding: 50px 48px 45px 48px;
  }

  /* Iluminação e Efeitos Azul e Branco */
  .glow-top {
    position: absolute;
    width: 900px;
    height: 550px;
    top: -120px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(circle, rgba(0, 102, 255, 0.35) 0%, rgba(37, 99, 235, 0.20) 45%, transparent 70%);
    filter: blur(80px);
    pointer-events: none;
  }

  .glow-mid {
    position: absolute;
    width: 800px;
    height: 800px;
    top: 45%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: radial-gradient(circle, rgba(0, 149, 255, 0.15) 0%, rgba(30, 64, 175, 0.10) 50%, transparent 75%);
    filter: blur(90px);
    pointer-events: none;
  }

  .glow-bottom {
    position: absolute;
    width: 850px;
    height: 600px;
    bottom: -150px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(circle, rgba(0, 102, 255, 0.30) 0%, rgba(59, 130, 246, 0.15) 50%, transparent 70%);
    filter: blur(85px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 45px 45px;
    pointer-events: none;
  }

  /* HEADER */
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
    gap: 10px;
    background: rgba(0, 102, 255, 0.16);
    border: 1.5px solid #38BDF8;
    padding: 8px 24px;
    border-radius: 50px;
    font-size: 15px;
    font-weight: 800;
    color: #FFFFFF;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(0, 102, 255, 0.4);
    margin-bottom: 14px;
  }

  .pulse-dot {
    width: 10px;
    height: 10px;
    background: #FFFFFF;
    border-radius: 50%;
    box-shadow: 0 0 12px #38BDF8;
  }

  /* Estilo de Letra Double-Struck (Blackboard Bold ℍ𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕) */
  .brand-title-double {
    font-size: 64px;
    font-weight: 900;
    letter-spacing: 3px;
    color: #FFFFFF;
    text-shadow: 
      0 0 15px rgba(56, 189, 248, 0.8),
      0 0 35px rgba(0, 102, 255, 0.6);
    margin-bottom: 8px;
  }

  .brand-title-sub {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 4px;
    color: #38BDF8;
    text-transform: uppercase;
  }

  .category-title-box {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    background: linear-gradient(90deg, rgba(0, 102, 255, 0.35), rgba(30, 64, 175, 0.35));
    border: 2px solid #0095FF;
    padding: 12px 36px;
    border-radius: 16px;
    font-size: 28px;
    font-weight: 900;
    color: #FFFFFF;
    letter-spacing: 1.5px;
    margin-top: 14px;
    box-shadow: 0 0 30px rgba(0, 102, 255, 0.35);
  }

  .category-title-box i {
    color: #38BDF8;
    font-size: 26px;
  }

  .subtext {
    font-size: 17px;
    color: #CBD5E1;
    margin-top: 10px;
    font-weight: 600;
  }

  /* FEATURES STRIP */
  .features-strip {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 14px;
    margin: 20px 0 16px 0;
    z-index: 10;
  }

  .feature-pill {
    flex: 1;
    background: rgba(10, 25, 60, 0.75);
    border: 1.5px solid rgba(56, 189, 248, 0.3);
    backdrop-filter: blur(14px);
    border-radius: 14px;
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 700;
    color: #FFFFFF;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
  }

  .feature-pill i {
    font-size: 18px;
    color: #38BDF8;
  }

  /* GRID DE PACOTES */
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
    gap: 12px;
  }

  /* CARDS DOS PACOTES */
  .pkg-card {
    background: rgba(8, 22, 54, 0.75);
    border: 1.5px solid rgba(56, 189, 248, 0.22);
    backdrop-filter: blur(14px);
    border-radius: 16px;
    padding: 13px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .pkg-highlight {
    background: linear-gradient(135deg, rgba(0, 102, 255, 0.25) 0%, rgba(8, 22, 54, 0.9) 100%);
    border: 2px solid #38BDF8;
    box-shadow: 0 0 25px rgba(0, 102, 255, 0.35);
  }

  .pkg-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .pkg-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: rgba(0, 102, 255, 0.15);
    border: 1.5px solid rgba(56, 189, 248, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: #38BDF8;
  }

  .icon-glow {
    background: #0066FF;
    border-color: #FFFFFF;
    color: #FFFFFF;
    box-shadow: 0 0 15px rgba(0, 102, 255, 0.6);
  }

  .pkg-info {
    display: flex;
    flex-direction: column;
  }

  .pkg-vol {
    font-family: 'Outfit', sans-serif;
    font-size: 26px;
    font-weight: 900;
    color: #FFFFFF;
    letter-spacing: -0.5px;
  }

  .pkg-highlight .pkg-vol {
    color: #FFFFFF;
    text-shadow: 0 0 15px rgba(56, 189, 248, 0.8);
  }

  .pkg-desc {
    font-size: 13px;
    color: #94A3B8;
    font-weight: 600;
  }

  .pkg-highlight .pkg-desc {
    color: #38BDF8;
    font-weight: 700;
  }

  .pkg-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }

  .pkg-badge {
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    background: #FFFFFF;
    color: #0044CC;
    padding: 3px 9px;
    border-radius: 6px;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
  }

  .pkg-price {
    font-family: 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 900;
    color: #FFFFFF;
  }

  .pkg-highlight .pkg-price {
    color: #38BDF8;
    text-shadow: 0 0 15px rgba(56, 189, 248, 0.7);
  }

  .cur {
    font-size: 18px;
    font-weight: 800;
    color: #FFFFFF;
  }

  /* PAINEL INFERIOR: PAGAMENTO & ATIVAÇÃO */
  .bottom-card {
    width: 100%;
    background: rgba(6, 18, 48, 0.85);
    border: 2px solid #0077FF;
    border-radius: 22px;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    z-index: 10;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.6), 0 0 35px rgba(0, 102, 255, 0.25);
  }

  .bottom-grid {
    display: grid;
    grid-template-columns: 1.15fr 1fr;
    gap: 24px;
    align-items: center;
  }

  /* Contas */
  .payments-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .payments-title {
    font-size: 15px;
    font-weight: 900;
    color: #38BDF8;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .payment-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(0, 102, 255, 0.12);
    border: 1.5px solid rgba(56, 189, 248, 0.35);
    border-radius: 12px;
    padding: 10px 16px;
  }

  .pay-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 800;
    font-size: 15px;
    color: #FFFFFF;
  }

  .dot-blue { width: 12px; height: 12px; border-radius: 50%; background: #38BDF8; box-shadow: 0 0 8px #38BDF8; }
  .dot-white { width: 12px; height: 12px; border-radius: 50%; background: #FFFFFF; box-shadow: 0 0 8px #FFFFFF; }

  .pay-number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 20px;
    font-weight: 900;
    color: #FFFFFF;
    background: rgba(0, 0, 0, 0.4);
    padding: 4px 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  /* Passos de Ativação */
  .steps-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    font-weight: 600;
    color: #E2E8F0;
  }

  .step-num {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #0066FF;
    border: 1.5px solid #FFFFFF;
    color: #FFFFFF;
    font-size: 13px;
    font-weight: 900;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 10px rgba(0, 102, 255, 0.6);
  }

  /* Rodapé do Painel */
  .footer-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 14px;
    border-top: 1.5px solid rgba(56, 189, 248, 0.2);
    font-size: 14px;
    color: #94A3B8;
  }

  .tip-text {
    color: #E2E8F0;
    font-size: 14px;
  }

  .tip-text b {
    color: #38BDF8;
  }

  .support-tag {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #FFFFFF;
    font-weight: 800;
    font-size: 15px;
  }

  .support-tag span {
    color: #38BDF8;
    font-family: 'JetBrains Mono', monospace;
    font-size: 18px;
    background: rgba(0, 102, 255, 0.2);
    padding: 4px 12px;
    border-radius: 8px;
    border: 1px solid rgba(56, 189, 248, 0.4);
  }
</style>
</head>
<body>

  <!-- Glows Azul e Branco -->
  <div class="glow-top"></div>
  <div class="glow-mid"></div>
  <div class="glow-bottom"></div>
  <div class="grid-pattern"></div>

  <!-- HEADER COM ESTILO DOUBLE-STRUCK (ℍ𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕) -->
  <div class="header">
    <div class="top-badge">
      <div class="pulse-dot"></div>
      𝕊𝕀𝕊𝕋𝔼𝕄𝔸 𝕆𝔽𝕀ℂ𝕀𝔸𝕃 • 𝔸𝕋𝕀𝕍𝔸ℂ̧𝔸̃𝕆 𝟚𝟜ℍ
    </div>
    <h1 class="brand-title-double">𝕂𝔸-ℕ𝔼𝕋 𝕊𝕐𝕊𝕋𝔼𝕄</h1>
    <div class="brand-title-sub">𝕀ℕ𝕋𝔼ℝℕ𝔼𝕋 𝕌𝕃𝕋ℝ𝔸 𝔽𝔸𝕊𝕋</div>
    
    <div class="category-title-box">
      <i class="fa-solid fa-bolt-lightning"></i>
      ℙ𝔸ℂ𝕆𝕋𝔼𝕊 𝔻𝕀𝔸́ℝ𝕀𝕆𝕊 (𝟚𝟜ℍ)
    </div>
    <div class="subtext">Os melhores pacotes de dados Vodacom em Moçambique com ativação 100% automática</div>
  </div>

  <!-- BARRA DE RECURSOS -->
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
      <span>24H Online sem Pausa</span>
    </div>
    <div class="feature-pill">
      <i class="fa-solid fa-credit-card"></i>
      <span>Crédito Txeneco VIP</span>
    </div>
  </div>

  <!-- GRID DE 2 COLUNAS DE PACOTES COM LETRAS GRANDES -->
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

  <!-- PAINEL INFERIOR: PAGAMENTO AZUL E BRANCO -->
  <div class="bottom-card">
    <div class="bottom-grid">
      <!-- Contas Oficiais -->
      <div class="payments-box">
        <div class="payments-title">
          <i class="fa-solid fa-wallet"></i> Contas de Pagamento Oficiais
        </div>
        <div class="payment-item">
          <div class="pay-brand">
            <div class="dot-blue"></div>
            <span>M-Pesa (Kelven Junior)</span>
          </div>
          <div class="pay-number">856268811</div>
        </div>
        <div class="payment-item">
          <div class="pay-brand">
            <div class="dot-white"></div>
            <span>e-Mola (Catia Anabela)</span>
          </div>
          <div class="pay-number">864882152</div>
        </div>
      </div>

      <!-- Como Comprar -->
      <div class="steps-box">
        <div class="payments-title" style="color:#FFFFFF;">
          <i class="fa-solid fa-wand-magic-sparkles"></i> Como Ativar em 3 Passos
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

    <!-- Linha de Dica e Suporte -->
    <div class="footer-strip">
      <div class="tip-text">⚡ <b>Dica VIP:</b> Envie <b>.configurar</b> para recarregar direto sem mandar comprovativo!</div>
      <div class="support-tag">
        <i class="fa-brands fa-whatsapp"></i> Suporte Direto: <span>850401416</span>
      </div>
    </div>
  </div>

</body>
</html>`;

async function main() {
    console.log('🚀 Gerando Novo Flyer dos Pacotes Diários (Azul & Branco, Letras Grandes, Estilo Double-Struck)...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });
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
