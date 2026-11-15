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
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

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
    background: radial-gradient(ellipse, rgba(0, 229, 255, 0.2) 0%, rgba(99, 102, 241, 0.15) 45%, transparent 70%);
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
    background: radial-gradient(ellipse, rgba(16, 185, 129, 0.18) 0%, rgba(245, 158, 11, 0.1) 50%, transparent 70%);
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
    background: rgba(0, 229, 255, 0.1);
    border: 1px solid rgba(0, 229, 255, 0.35);
    padding: 7px 20px;
    border-radius: 50px;
    font-size: 12px;
    font-weight: 800;
    color: #00F0FF;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(0, 229, 255, 0.2);
    margin-bottom: 12px;
  }

  .top-badge .dot {
    width: 8px;
    height: 8px;
    background: #00FF9D;
    border-radius: 50%;
    box-shadow: 0 0 10px #00FF9D;
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
    margin-bottom: 10px;
  }

  .gradient-text {
    background: linear-gradient(135deg, #FFFFFF 20%, #00F0FF 65%, #38BDF8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .highlight-tag {
    background: linear-gradient(135deg, #00FF9D 0%, #00F0FF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subheading {
    font-size: 15px;
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
    margin: 14px 0;
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
  .feature-card.gold-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #FBBF24, #F59E0B);
  }
  .feature-card.cyan-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #00F0FF, #38BDF8);
  }
  .feature-card.emerald-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #00FF9D, #10B981);
  }
  .feature-card.purple-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 5px; height: 100%;
    background: linear-gradient(to bottom, #C084FC, #818CF8);
  }

  .icon-wrapper {
    width: 58px;
    height: 58px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
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
    font-size: 20px;
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
    color: #E2E8F0;
  }

  /* Bottom Hero Banner */
  .bottom-banner {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.18) 0%, rgba(0, 229, 255, 0.14) 100%);
    border: 1px solid rgba(16, 185, 129, 0.4);
    border-radius: 20px;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    position: relative;
    overflow: hidden;
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .status-radar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: rgba(16, 185, 129, 0.25);
    border: 2px solid #00FF9D;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #00FF9D;
    font-size: 20px;
    box-shadow: 0 0 20px rgba(0, 255, 157, 0.45);
  }

  .status-text-title {
    font-family: 'Outfit', sans-serif;
    font-size: 19px;
    font-weight: 800;
    color: #FFFFFF;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-text-title .check {
    color: #00FF9D;
  }

  .status-text-desc {
    font-size: 13px;
    color: #A7F3D0;
    margin-top: 2px;
  }

  .order-btn {
    background: linear-gradient(135deg, #00FF9D 0%, #00F0FF 100%);
    color: #060913;
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 12px 24px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 0 25px rgba(0, 255, 157, 0.4);
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

  .footer-brand i {
    color: #00F0FF;
  }

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
      SUPER ATUALIZAÇÃO CONCLUÍDA COM SUCESSO
    </div>
    <div class="brand-title">KA-NET TELECOM • TECNOLOGIA INTELIGENTE</div>
    <h1 class="main-heading">
      NOVO SISTEMA <span class="gradient-text">MUITO MAIS COMPLETO</span><br>
      E CHEIO DE <span class="highlight-tag">NOVIDADES!</span> 🚀
    </h1>
    <p class="subheading">
      Estivemos a trabalhar intensamente na atualização do sistema para trazer <b>recursos revolucionários</b> e tornar os seus pedidos mais fáceis, rápidos e acessíveis:
    </p>
  </div>

  <!-- 4 Star Feature Cards Grid -->
  <div class="features-grid">
    <!-- Card 1: Empréstimos de Megabytes -->
    <div class="feature-card gold-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-hand-holding-dollar"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Empréstimo de Megas
          <span class="badge-tag gold">USE AGORA, PAGUE DEPOIS</span>
        </div>
        <p class="feature-desc">
          Ficou sem saldo no momento? Agora você pode <b>solicitar Megabytes no crédito</b> imediatamente e acertar o pagamento com calma quando puder.
        </p>
      </div>
    </div>

    <!-- Card 2: Pacote Faseado Mensal -->
    <div class="feature-card cyan-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-calendar-days"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Pacote Faseado Mensal
          <span class="badge-tag cyan">ECONOMIA GARANTIDA</span>
        </div>
        <p class="feature-desc">
          Compre o seu pacote de 30 dias com <b>entrega faseada e inteligente</b>. Garanta internet ativa durante todo o mês sem risco de desperdício.
        </p>
      </div>
    </div>

    <!-- Card 3: Leitor Inteligente de Imagens -->
    <div class="feature-card emerald-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-camera-retro"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Leitor de Comprovativos
          <span class="badge-tag emerald">RECONHECIMENTO POR FOTO</span>
        </div>
        <p class="feature-desc">
          Chega de digitar códigos! <b>Envie apenas o print ou foto</b> do comprovativo M-Pesa ou e-Mola. O robô lê os dados e ativa os seus Megas na hora.
        </p>
      </div>
    </div>

    <!-- Card 4: Escuta Inteligente de Áudios -->
    <div class="feature-card purple-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-microphone-lines"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Escutador de Áudios
          <span class="badge-tag purple">ATENDIMENTO POR VOZ</span>
        </div>
        <p class="feature-desc">
          Sem tempo para digitar? <b>Mande uma mensagem de áudio</b> no WhatsApp! A nossa Inteligência Artificial escuta, entende e processa o seu pedido.
        </p>
      </div>
    </div>
  </div>

  <!-- Bottom CTA Banner -->
  <div class="bottom-banner">
    <div class="status-left">
      <div class="status-radar">
        <i class="fa-solid fa-check"></i>
      </div>
      <div>
        <div class="status-text-title">
          SISTEMA 100% OPERACIONAL & ATIVO <span class="check">●</span>
        </div>
        <div class="status-text-desc">
          Agradecemos pela paciência e preferência de sempre. Venha experimentar!
        </div>
      </div>
    </div>
    <div class="order-btn">
      <i class="fa-solid fa-paper-plane"></i> FAÇA SEU PEDIDO
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-brand">
      <i class="fa-solid fa-shield-halved"></i>
      <span>KA-NET — A melhor e mais inovadora recarga de Moçambique 🇲🇿</span>
    </div>
    <div class="footer-pills">
      <span class="footer-pill">⚡ 100% Automático 24/7</span>
      <span class="footer-pill">📸 Leitura por Imagem</span>
      <span class="footer-pill">🎙️ Mensagens de Voz</span>
      <span class="footer-pill">💸 Empréstimo Fácil</span>
    </div>
  </div>
</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Gerando imagem completa de novidades com Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar carregamento de fontes e ícones
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'marketing_novidades_completas.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar também para o diretório de artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'marketing_novidades_completas.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Imagem salva com sucesso em:', outputPath);
  console.log('✅ Imagem copiada para artefatos em:', artifactPath);
})();
