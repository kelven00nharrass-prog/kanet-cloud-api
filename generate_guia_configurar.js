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

  .bg-glow-top {
    position: absolute;
    width: 850px;
    height: 480px;
    top: -120px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(0, 229, 255, 0.22) 0%, rgba(99, 102, 241, 0.15) 45%, transparent 70%);
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
    background: radial-gradient(ellipse, rgba(168, 85, 247, 0.2) 0%, rgba(16, 185, 129, 0.12) 50%, transparent 70%);
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

  .container {
    width: 960px;
    height: 960px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    z-index: 2;
  }

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
    background: rgba(0, 229, 255, 0.12);
    border: 1px solid rgba(0, 229, 255, 0.4);
    padding: 7px 22px;
    border-radius: 50px;
    font-size: 12px;
    font-weight: 800;
    color: #00F0FF;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    box-shadow: 0 0 25px rgba(0, 229, 255, 0.25);
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
    font-size: 42px;
    font-weight: 900;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: -0.02em;
    margin-bottom: 8px;
  }

  .gradient-cyan {
    background: linear-gradient(135deg, #FFFFFF 15%, #00F0FF 60%, #00FF9D 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .gradient-purple {
    background: linear-gradient(135deg, #E0E7FF 0%, #C084FC 50%, #A855F7 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subheading {
    font-size: 14.5px;
    color: #94A3B8;
    max-width: 820px;
    line-height: 1.45;
  }

  .subheading b {
    color: #F1F5F9;
    font-weight: 700;
  }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin: 10px 0;
  }

  .feature-card {
    background: rgba(15, 23, 42, 0.75);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 20px;
    padding: 22px;
    display: flex;
    gap: 18px;
    align-items: flex-start;
    backdrop-filter: blur(16px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  .cyan-card {
    border-color: rgba(0, 229, 255, 0.35);
    background: linear-gradient(145deg, rgba(0, 229, 255, 0.08) 0%, rgba(15, 23, 42, 0.85) 100%);
  }

  .purple-card {
    border-color: rgba(168, 85, 247, 0.35);
    background: linear-gradient(145deg, rgba(168, 85, 247, 0.08) 0%, rgba(15, 23, 42, 0.85) 100%);
  }

  .emerald-card {
    border-color: rgba(16, 185, 129, 0.35);
    background: linear-gradient(145deg, rgba(16, 185, 129, 0.08) 0%, rgba(15, 23, 42, 0.85) 100%);
  }

  .gold-card {
    border-color: rgba(245, 158, 11, 0.35);
    background: linear-gradient(145deg, rgba(245, 158, 11, 0.08) 0%, rgba(15, 23, 42, 0.85) 100%);
  }

  .icon-wrapper {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    flex-shrink: 0;
  }

  .cyan-card .icon-wrapper {
    background: rgba(0, 229, 255, 0.12);
    border: 1px solid rgba(0, 229, 255, 0.35);
    color: #00F0FF;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.2);
  }

  .purple-card .icon-wrapper {
    background: rgba(168, 85, 247, 0.12);
    border: 1px solid rgba(168, 85, 247, 0.35);
    color: #C084FC;
    box-shadow: 0 0 20px rgba(168, 85, 247, 0.2);
  }

  .emerald-card .icon-wrapper {
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.35);
    color: #00FF9D;
    box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);
  }

  .gold-card .icon-wrapper {
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: #FBBF24;
    box-shadow: 0 0 20px rgba(245, 158, 11, 0.2);
  }

  .feature-info { flex: 1; }

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

  .badge-tag.cyan {
    background: rgba(0, 229, 255, 0.18);
    color: #00F0FF;
    border: 1px solid rgba(0, 229, 255, 0.35);
  }
  .badge-tag.purple {
    background: rgba(168, 85, 247, 0.18);
    color: #C084FC;
    border: 1px solid rgba(168, 85, 247, 0.35);
  }
  .badge-tag.emerald {
    background: rgba(16, 185, 129, 0.18);
    color: #00FF9D;
    border: 1px solid rgba(16, 185, 129, 0.35);
  }
  .badge-tag.gold {
    background: rgba(245, 158, 11, 0.18);
    color: #FBBF24;
    border: 1px solid rgba(245, 158, 11, 0.35);
  }

  .feature-desc {
    font-size: 13.5px;
    color: #94A3B8;
    line-height: 1.45;
  }

  .feature-desc b { color: #F1F5F9; }

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
    gap: 14px;
  }

  .cmd-item {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 9px 13px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .cmd-code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #00F0FF;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cmd-code.purple { color: #C084FC; }
  .cmd-code.green { color: #00FF9D; }

  .cmd-desc {
    font-size: 11px;
    color: #94A3B8;
  }

  .contact-mini { text-align: right; }

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

  .footer-brand i { color: #00F0FF; }

  .footer-pills { display: flex; gap: 10px; }

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
      RECURSO EXCLUSIVO • RECARGAS AUTOMÁTICAS 24H
    </div>
    <div class="brand-title">KA-NET SYSTEM • TECNOLOGIA & PRATICIDADE</div>
    <h1 class="main-heading">
      NUNCA MAIS ENVIE <span class="gradient-cyan">COMPROVATIVOS!</span><br>
      CONFIGURE SEU <span class="gradient-purple">NÚMERO FIXO</span> ⚡
    </h1>
    <p class="subheading">
      Vincule o seu <b>M-Pesa ou e-Mola</b> ao seu número Vodacom. Fez a transferência? Os Megabytes caem no seu celular <b>automaticamente em segundos</b>, sem precisar de enviar SMS no WhatsApp!
    </p>
  </div>

  <!-- 4 Star Feature Cards Grid -->
  <div class="features-grid">
    <!-- Card 1: Como Funciona -->
    <div class="feature-card cyan-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          1. Como Funciona a Mágica?
          <span class="badge-tag cyan">INSTANTÂNEO</span>
        </div>
        <p class="feature-desc">
          O sistema da Axion sincroniza diretamente com as operadoras. Quando o pagamento cai na nossa conta, o sistema reconhece o seu número pagador e <b>recarrega o seu telefone Vodacom na hora</b>!
        </p>
      </div>
    </div>

    <!-- Card 2: 100% Automático -->
    <div class="feature-card emerald-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-bolt-lightning"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          2. Sem WhatsApp e Sem Espera
          <span class="badge-tag emerald">ZERO ESFORÇO</span>
        </div>
        <p class="feature-desc">
          Não precisa colar comprovativo, tirar print ou esperar confirmação. Funciona <b>24 horas por dia</b>, mesmo se você estiver <b>completamente sem internet</b> ou com WhatsApp desligado!
        </p>
      </div>
    </div>

    <!-- Card 3: Múltiplas Carteiras -->
    <div class="feature-card purple-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-wallet"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          3. Múltiplas Carteiras Móveis
          <span class="badge-tag purple">M-PESA & E-MOLA</span>
        </div>
        <p class="feature-desc">
          Você pode vincular <b>1 ou 2 números pagadores</b> (ex: seu 85 M-Pesa e seu 86 e-Mola). Pagando por qualquer um deles, os Megas caem no mesmo número Vodacom configurado!
        </p>
      </div>
    </div>

    <!-- Card 4: Controle Total -->
    <div class="feature-card gold-card">
      <div class="icon-wrapper">
        <i class="fa-solid fa-sliders"></i>
      </div>
      <div class="feature-info">
        <div class="feature-title">
          4. Controle Total na sua Mão
          <span class="badge-tag gold">FLEXÍVEL</span>
        </div>
        <p class="feature-desc">
          Consulte o seu número configurado a qualquer momento com <b>.meunumero</b> ou cancele quando quiser enviando <b>.desconfigurar</b> para voltar a comprar com comprovativo manual.
        </p>
      </div>
    </div>
  </div>

  <!-- Bottom Interactive Command Box -->
  <div class="bottom-box">
    <div class="cmd-group">
      <div class="cmd-item">
        <div class="cmd-code"><i class="fa-solid fa-gear"></i> .configurar 84XXXXXXX</div>
        <div class="cmd-desc">Definir seu número Vodacom fixo</div>
      </div>
      <div class="cmd-item">
        <div class="cmd-code purple"><i class="fa-solid fa-address-card"></i> .meunumero</div>
        <div class="cmd-desc">Ver seu número cadastrado</div>
      </div>
      <div class="cmd-item">
        <div class="cmd-code green"><i class="fa-solid fa-circle-xmark"></i> .desconfigurar</div>
        <div class="cmd-desc">Voltar ao modo manual</div>
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
      <i class="fa-solid fa-network-wired"></i>
      KA-NET SYSTEM • AUTOMAÇÃO DE RECARGAS 24H
    </div>
    <div class="footer-pills">
      <div class="footer-pill">⚡ Envio em Segundos</div>
      <div class="footer-pill">🔒 100% Seguro</div>
      <div class="footer-pill">🌐 Vodacom Moçambique</div>
    </div>
  </div>
</div>

</body>
</html>`;

async function generateGuiaConfigurar() {
    console.log('🚀 Gerando Guia de Configurar Número Axion com Puppeteer...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outputPath = path.resolve(__dirname, 'marketing_guia_configurar.png');
    await page.screenshot({ path: outputPath, type: 'png' });
    await browser.close();

    console.log(`✅ Imagem salva com sucesso em: ${outputPath}`);

    // Copiar para a pasta de artefatos
    const artifactDir = path.resolve('C:/Users/Kelven/.gemini/antigravity/brain/96fbd304-c56c-4154-b7c5-70839e09bdc1');
    if (fs.existsSync(artifactDir)) {
        const artifactPath = path.join(artifactDir, 'marketing_guia_configurar.png');
        fs.copyFileSync(outputPath, artifactPath);
        console.log(`✅ Imagem copiada para artefatos em: ${artifactPath}`);
    }
}

generateGuiaConfigurar().catch(err => {
    console.error('❌ Erro ao gerar imagem:', err);
    process.exit(1);
});
