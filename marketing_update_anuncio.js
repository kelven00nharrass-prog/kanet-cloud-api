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
    width: 800px;
    height: 450px;
    top: -100px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(0, 229, 255, 0.18) 0%, rgba(99, 102, 241, 0.12) 45%, transparent 70%);
    filter: blur(50px);
    pointer-events: none;
  }

  .bg-glow-bottom {
    position: absolute;
    width: 700px;
    height: 400px;
    bottom: -80px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(16, 185, 129, 0.15) 0%, rgba(0, 229, 255, 0.08) 50%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(circle at center, black 40%, transparent 85%);
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
    padding: 8px 20px;
    border-radius: 50px;
    font-size: 13px;
    font-weight: 700;
    color: #00F0FF;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(0, 229, 255, 0.2);
    margin-bottom: 14px;
  }

  .top-badge .dot {
    width: 8px;
    height: 8px;
    background: #00FF9D;
    border-radius: 50%;
    box-shadow: 0 0 10px #00FF9D;
    animation: pulse 2s infinite;
  }

  .brand-title {
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 0.25em;
    color: #94A3B8;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .main-heading {
    font-family: 'Outfit', sans-serif;
    font-size: 46px;
    font-weight: 900;
    line-height: 1.12;
    text-transform: uppercase;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
  }

  .gradient-text {
    background: linear-gradient(135deg, #FFFFFF 20%, #00F0FF 65%, #38BDF8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .highlight-tag {
    background: linear-gradient(135deg, #10B981 0%, #00F0FF 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subheading {
    font-size: 16px;
    color: #94A3B8;
    max-width: 740px;
    line-height: 1.5;
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
    margin: 18px 0;
  }

  .feature-card {
    background: rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 22px 24px;
    display: flex;
    align-items: flex-start;
    gap: 18px;
    position: relative;
    overflow: hidden;
    backdrop-filter: blur(16px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  .feature-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 4px;
    height: 100%;
    background: linear-gradient(to bottom, #00F0FF, #6366F1);
  }

  .feature-card.green-accent::before {
    background: linear-gradient(to bottom, #00FF9D, #00F0FF);
  }

  .feature-card.yellow-accent::before {
    background: linear-gradient(to bottom, #FBBF24, #F97316);
  }

  .feature-card.purple-accent::before {
    background: linear-gradient(to bottom, #A855F7, #6366F1);
  }

  .icon-wrapper {
    width: 54px;
    height: 54px;
    border-radius: 14px;
    background: rgba(0, 229, 255, 0.1);
    border: 1px solid rgba(0, 229, 255, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: #00F0FF;
    flex-shrink: 0;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);
  }

  .feature-card.green-accent .icon-wrapper {
    background: rgba(16, 185, 129, 0.1);
    border-color: rgba(16, 185, 129, 0.3);
    color: #00FF9D;
    box-shadow: 0 0 20px rgba(16, 185, 129, 0.15);
  }

  .feature-card.yellow-accent .icon-wrapper {
    background: rgba(245, 158, 11, 0.1);
    border-color: rgba(245, 158, 11, 0.3);
    color: #FBBF24;
    box-shadow: 0 0 20px rgba(245, 158, 11, 0.15);
  }

  .feature-card.purple-accent .icon-wrapper {
    background: rgba(168, 85, 247, 0.1);
    border-color: rgba(168, 85, 247, 0.3);
    color: #C084FC;
    box-shadow: 0 0 20px rgba(168, 85, 247, 0.15);
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
    background: rgba(255, 255, 255, 0.1);
    color: #94A3B8;
  }

  .badge-tag.turbo {
    background: rgba(0, 229, 255, 0.15);
    color: #00F0FF;
    border: 1px solid rgba(0, 229, 255, 0.3);
  }

  .badge-tag.auto {
    background: rgba(16, 185, 129, 0.15);
    color: #00FF9D;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .feature-desc {
    font-size: 13.5px;
    color: #94A3B8;
    line-height: 1.45;
  }

  /* Bottom Hero Banner */
  .bottom-banner {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(14, 165, 233, 0.12) 100%);
    border: 1px solid rgba(16, 185, 129, 0.35);
    border-radius: 20px;
    padding: 18px 24px;
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
    background: rgba(16, 185, 129, 0.2);
    border: 2px solid #00FF9D;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #00FF9D;
    font-size: 20px;
    box-shadow: 0 0 20px rgba(0, 255, 157, 0.4);
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
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12.5px;
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
    gap: 12px;
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
      COMUNICADO OFICIAL • ATUALIZAÇÃO CONCLUÍDA
    </div>
    <div class="brand-title">KA-NET TELECOM & SERVIÇOS DIGITAIS</div>
    <h1 class="main-heading">
      SISTEMA <span class="gradient-text">TOTALMENTE RENOVADO</span><br>
      E MUITO MAIS <span class="highlight-tag">RÁPIDO!</span> ⚡
    </h1>
    <p class="subheading">
      Informamos a todos os nossos clientes e parceiros que <b>desde ontem estávamos a trabalhar intensamente</b> na atualização e reforço da nossa infraestrutura tecnológica. Conheça as novidades:
    </p>
  </div>

  <!-- 4 Feature Cards Grid -->
  <div class="features-grid">
    <!-- Card 1: Velocidade -->
    <div class="feature-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-bolt-lightning"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Velocidade Turbo
          <span class="badge-tag turbo">3X MAIS RÁPIDO</span>
        </div>
        <p class="feature-desc">
          Novo motor de processamento instantâneo. Seus pacotes de Megabytes e recargas agora chegam no celular em segundos após a confirmação.
        </p>
      </div>
    </div>

    <!-- Card 2: 100% Automático 24/7 -->
    <div class="feature-card green-accent">
      <div class="icon-wrapper">
        <i class="fa-solid fa-robot"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          100% Automático 24/7
          <span class="badge-tag auto">SEM PAUSAS</span>
        </div>
        <p class="feature-desc">
          Atendimento e entregas ininterruptas dia e noite. Os robôs foram reprogramados para despachar pedidos imediatamente sem intervenção manual.
        </p>
      </div>
    </div>

    <!-- Card 3: Roteamento Inteligente -->
    <div class="feature-card yellow-accent">
      <div class="icon-wrapper">
        <i class="fa-solid fa-sim-card"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Multi-Chip Inteligente
          <span class="badge-tag">ROTEAMENTO DIRETO</span>
        </div>
        <p class="feature-desc">
          Direcionamento estrito de rede (Vodacom e Movitel). Elimina completamente atrasos e falhas de operadora com alternância inteligente de chips.
        </p>
      </div>
    </div>

    <!-- Card 4: Blindagem e Zero Quedas -->
    <div class="feature-card purple-accent">
      <div class="icon-wrapper">
        <i class="fa-solid fa-shield-halved"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          Estabilidade Blindada
          <span class="badge-tag">ZERO FALHAS</span>
        </div>
        <p class="feature-desc">
          Novo sistema de auto-recuperação e monitoramento contínuo. Nenhum pedido fica retido ou perdido, garantindo entrega 100% segura.
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
          Agradecemos pela paciência e confiança. Já pode enviar seus pedidos normalmente!
        </div>
      </div>
    </div>
    <div class="order-btn">
      <i class="fa-solid fa-arrow-right"></i> FAÇA SEU PEDIDO
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-brand">
      <i class="fa-solid fa-wifi"></i>
      <span>KA-NET — A sua internet favorita de Moçambique 🇲🇿</span>
    </div>
    <div class="footer-pills">
      <span class="footer-pill">⚡ Entrega Imediata</span>
      <span class="footer-pill">🔒 Segurança Total</span>
      <span class="footer-pill">💰 Melhor Preço</span>
    </div>
  </div>
</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Iniciando Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar carregamento das fontes do Google e ícones do FontAwesome
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'marketing_atualizacao_sistema.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar também para o diretório de artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'marketing_atualizacao_sistema.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Imagem salva com sucesso em:', outputPath);
  console.log('✅ Imagem copiada para artefatos em:', artifactPath);
})();
