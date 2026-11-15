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
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=Outfit:wght@500;600;700;800;900&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1080px;
    background: #050814;
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
    width: 700px;
    height: 500px;
    top: -100px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(251, 191, 36, 0.22) 0%, rgba(245, 158, 11, 0.12) 35%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }

  .bg-glow-cyan {
    position: absolute;
    width: 650px;
    height: 450px;
    bottom: -80px;
    left: 10%;
    background: radial-gradient(circle, rgba(6, 182, 212, 0.18) 0%, rgba(59, 130, 246, 0.1) 40%, transparent 70%);
    filter: blur(65px);
    pointer-events: none;
  }

  .bg-glow-purple {
    position: absolute;
    width: 600px;
    height: 450px;
    bottom: -80px;
    right: 10%;
    background: radial-gradient(circle, rgba(168, 85, 247, 0.2) 0%, rgba(236, 72, 153, 0.12) 40%, transparent 70%);
    filter: blur(65px);
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
    padding-bottom: 12px;
  }

  .logo-area {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .logo-icon {
    width: 58px;
    height: 58px;
    background: linear-gradient(135deg, #00F0FF, #3B82F6);
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    color: #030712;
    box-shadow: 0 0 25px rgba(0, 240, 255, 0.45);
  }

  .logo-text h1 {
    font-family: 'Outfit', sans-serif;
    font-size: 32px;
    font-weight: 900;
    letter-spacing: 1px;
    background: linear-gradient(90deg, #FFFFFF, #94A3B8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .logo-text p {
    font-size: 13px;
    color: #00F0FF;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .sunday-badge {
    display: flex;
    align-items: center;
    gap: 10px;
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(245, 158, 11, 0.08));
    border: 1.5px solid rgba(251, 191, 36, 0.4);
    padding: 10px 22px;
    border-radius: 50px;
    box-shadow: 0 0 25px rgba(245, 158, 11, 0.2);
  }

  .sunday-badge i {
    color: #FBBF24;
    font-size: 18px;
    animation: pulse 2s infinite;
  }

  .sunday-badge span {
    font-size: 14px;
    font-weight: 800;
    color: #FDE68A;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  /* Hero Section */
  .hero {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .hero-tag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.4);
    padding: 6px 18px;
    border-radius: 30px;
    font-size: 13px;
    font-weight: 800;
    color: #34D399;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .hero-title {
    font-family: 'Outfit', sans-serif;
    font-size: 54px;
    font-weight: 900;
    line-height: 1.05;
    letter-spacing: -0.5px;
  }

  .hero-title .highlight-yellow {
    background: linear-gradient(90deg, #FDE68A, #F59E0B);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 35px rgba(245, 158, 11, 0.4);
  }

  .hero-title .highlight-cyan {
    background: linear-gradient(90deg, #38BDF8, #00F0FF);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 35px rgba(0, 240, 255, 0.4);
  }

  .hero-subtitle {
    font-size: 17px;
    color: #94A3B8;
    max-width: 780px;
    line-height: 1.4;
    font-weight: 500;
  }

  /* Big Reward Banner */
  .reward-card {
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.85), rgba(30, 41, 59, 0.6));
    border: 1.5px solid rgba(251, 191, 36, 0.35);
    border-radius: 28px;
    padding: 22px 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.5), inset 0 0 30px rgba(251, 191, 36, 0.08);
    position: relative;
    overflow: hidden;
  }

  .reward-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, #FBBF24, #00F0FF, #A855F7, #FBBF24);
  }

  .reward-left {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  .reward-icon-box {
    width: 82px;
    height: 82px;
    background: linear-gradient(135deg, #F59E0B, #D97706);
    border-radius: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 40px;
    color: #FFFFFF;
    box-shadow: 0 10px 25px rgba(245, 158, 11, 0.4);
  }

  .reward-info h2 {
    font-family: 'Outfit', sans-serif;
    font-size: 32px;
    font-weight: 900;
    color: #FFFFFF;
    line-height: 1.1;
  }

  .reward-info p {
    font-size: 15px;
    color: #CBD5E1;
    margin-top: 4px;
  }

  .reward-badge-huge {
    background: linear-gradient(135deg, #00F0FF, #0284C7);
    color: #030712;
    padding: 14px 28px;
    border-radius: 20px;
    text-align: center;
    box-shadow: 0 8px 25px rgba(0, 240, 255, 0.35);
  }

  .reward-badge-huge .amount {
    font-family: 'Outfit', sans-serif;
    font-size: 38px;
    font-weight: 900;
    line-height: 1;
  }

  .reward-badge-huge .label {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  /* 3 Steps Grid */
  .steps-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }

  .step-box {
    background: rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 22px;
    padding: 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: relative;
    backdrop-filter: blur(10px);
    transition: all 0.3s ease;
  }

  .step-number {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 900;
    font-family: 'Outfit', sans-serif;
  }

  .step-1 .step-number { background: rgba(56, 189, 248, 0.18); color: #38BDF8; border: 1px solid rgba(56, 189, 248, 0.35); }
  .step-2 .step-number { background: rgba(168, 85, 247, 0.18); color: #C084FC; border: 1px solid rgba(168, 85, 247, 0.35); }
  .step-3 .step-number { background: rgba(52, 211, 153, 0.18); color: #34D399; border: 1px solid rgba(52, 211, 153, 0.35); }

  .step-title {
    font-family: 'Outfit', sans-serif;
    font-size: 18px;
    font-weight: 800;
    color: #F8FAFC;
    line-height: 1.2;
  }

  .step-desc {
    font-size: 14px;
    color: #94A3B8;
    line-height: 1.45;
  }

  .code-tag {
    display: inline-block;
    background: rgba(0, 240, 255, 0.12);
    border: 1px dashed rgba(0, 240, 255, 0.45);
    color: #00F0FF;
    font-weight: 800;
    padding: 4px 10px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 15px;
    margin-top: 4px;
  }

  /* Highlights Bar */
  .features-bar {
    display: flex;
    justify-content: space-around;
    align-items: center;
    background: rgba(2, 6, 23, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 18px;
    padding: 14px 20px;
  }

  .feature-item {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 700;
    color: #CBD5E1;
  }

  .feature-item i {
    font-size: 16px;
  }

  .f-cyan i { color: #00F0FF; }
  .f-gold i { color: #FBBF24; }
  .f-green i { color: #10B981; }

  /* Footer CTA */
  .footer-cta {
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(99, 102, 241, 0.15));
    border: 1.5px solid rgba(56, 189, 248, 0.4);
    border-radius: 24px;
    padding: 18px 30px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }

  .cta-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .cta-text .main {
    font-size: 18px;
    font-weight: 800;
    color: #FFFFFF;
  }

  .cta-text .sub {
    font-size: 14px;
    color: #38BDF8;
    font-weight: 600;
  }

  .cta-button {
    background: linear-gradient(135deg, #22C55E, #16A34A);
    color: #FFFFFF;
    padding: 14px 28px;
    border-radius: 16px;
    font-family: 'Outfit', sans-serif;
    font-size: 18px;
    font-weight: 800;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 8px 25px rgba(34, 197, 94, 0.4);
    border: none;
  }

</style>
</head>
<body>

<div class="bg-glow-sun"></div>
<div class="bg-glow-cyan"></div>
<div class="bg-glow-purple"></div>
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

  <!-- Hero Section -->
  <div class="hero">
    <div class="hero-tag">
      <i class="fa-solid fa-gift"></i> Programa "Indica & Ganha"
    </div>
    <h2 class="hero-title">
      Indica <span class="highlight-yellow">3 Amigos</span> &amp;<br>
      Ganha <span class="highlight-cyan">500 MB Grátis!</span> 🚀
    </h2>
    <p class="hero-subtitle">
      Neste domingo, partilha internet rápida e barata com quem mais gostas. Amigos satisfeitos trazem amigos — e a Axion premeia-te automaticamente!
    </p>
  </div>

  <!-- Reward Card -->
  <div class="reward-card">
    <div class="reward-left">
      <div class="reward-icon-box">
        <i class="fa-solid fa-trophy"></i>
      </div>
      <div class="reward-info">
        <h2>Bónus 100% Automático</h2>
        <p>A cada 3 amigos que comprarem pela 1ª vez, recebes 500 MB na hora!</p>
      </div>
    </div>
    <div class="reward-badge-huge">
      <div class="amount">500 MB</div>
      <div class="label">Grátis no Celular</div>
    </div>
  </div>

  <!-- 3 Steps Grid -->
  <div class="steps-grid">
    <div class="step-box step-1">
      <div class="step-number">1</div>
      <div class="step-title">Pega o Teu Código</div>
      <div class="step-desc">
        No WhatsApp do robô, digita <span class="code-tag">4</span> ou <span class="code-tag">!convite</span> e recebe o teu código único exclusivo:
        <div class="code-tag">KN-XXXX</div>
      </div>
    </div>

    <div class="step-box step-2">
      <div class="step-number">2</div>
      <div class="step-title">Partilha com Amigos</div>
      <div class="step-desc">
        Envia o teu código ou link aos teus amigos e grupos. Eles compram com entrega instantânea em segundos.
      </div>
    </div>

    <div class="step-box step-3">
      <div class="step-number">3</div>
      <div class="step-title">Recebe os 500 MB</div>
      <div class="step-desc">
        Assim que 3 amigos comprarem, os <strong style="color:#34D399;">500 MB entram direto</strong> no teu número Vodacom automaticamente!
      </div>
    </div>
  </div>

  <!-- Features Bar -->
  <div class="features-bar">
    <div class="feature-item f-gold">
      <i class="fa-solid fa-infinity"></i>
      <span>Sem Limites: Ganha a cada 3 amigos</span>
    </div>
    <div class="feature-item f-cyan">
      <i class="fa-solid fa-shield-halved"></i>
      <span>Código Exclusivo &amp; Seguro</span>
    </div>
    <div class="feature-item f-green">
      <i class="fa-solid fa-bolt-lightning"></i>
      <span>Entrega USSD Instantânea 24/7</span>
    </div>
  </div>

  <!-- Footer CTA -->
  <div class="footer-cta">
    <div class="cta-text">
      <span class="main">📲 Começa agora mesmo pelo WhatsApp</span>
      <span class="sub">Digita <strong style="color: #FFFFFF;">4</strong> ou <strong style="color: #FFFFFF;">!convite</strong> para gerar o teu código!</span>
    </div>
    <button class="cta-button">
      <i class="fa-brands fa-whatsapp"></i>
      <span>Pedir Código</span>
    </button>
  </div>

</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Gerando Flyer de Bom Domingo com Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar renderização das fontes e ícones
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'flyer_bom_domingo_indicacao.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar também para o diretório de artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'flyer_bom_domingo_indicacao.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Flyer salvo com sucesso em:', outputPath);
  console.log('✅ Flyer copiado para artefatos em:', artifactPath);
})();
