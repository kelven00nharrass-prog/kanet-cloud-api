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
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1240px;
    height: 1960px;
    background: #060913;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
    padding: 34px 38px 28px 38px;
  }

  /* Efeitos de Fundo Luminosos */
  .bg-glow-top {
    position: absolute;
    width: 900px;
    height: 500px;
    top: -150px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(0, 229, 255, 0.18) 0%, rgba(99, 102, 241, 0.12) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }

  .bg-glow-mid {
    position: absolute;
    width: 800px;
    height: 600px;
    top: 40%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: radial-gradient(ellipse, rgba(168, 85, 247, 0.08) 0%, rgba(0, 229, 255, 0.06) 50%, transparent 70%);
    filter: blur(80px);
    pointer-events: none;
  }

  .bg-glow-bottom {
    position: absolute;
    width: 900px;
    height: 450px;
    bottom: -120px;
    left: 50%;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(16, 185, 129, 0.16) 0%, rgba(0, 229, 255, 0.08) 50%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }

  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
    background-size: 50px 50px;
    mask-image: radial-gradient(circle at center, black 45%, transparent 90%);
    pointer-events: none;
  }

  /* Header */
  .header {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    position: relative;
    z-index: 2;
  }

  .top-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(0, 229, 255, 0.1);
    border: 1px solid rgba(0, 229, 255, 0.35);
    padding: 6px 18px;
    border-radius: 50px;
    font-size: 11.5px;
    font-weight: 800;
    color: #00F0FF;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.2);
    margin-bottom: 8px;
  }

  .top-pill .dot {
    width: 7px;
    height: 7px;
    background: #00FF9D;
    border-radius: 50%;
    box-shadow: 0 0 8px #00FF9D;
  }

  .main-title {
    font-family: 'Outfit', sans-serif;
    font-size: 38px;
    font-weight: 900;
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .gradient-text {
    background: linear-gradient(135deg, #FFFFFF 25%, #00F0FF 65%, #38BDF8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    font-size: 13.5px;
    color: #94A3B8;
    letter-spacing: 0.05em;
  }

  .subtitle b {
    color: #00FF9D;
  }

  /* Grid Layout */
  .grid-main {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    position: relative;
    z-index: 2;
    margin: 14px 0 10px 0;
  }

  /* Section Card Container */
  .section-card {
    background: rgba(13, 20, 36, 0.75);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 16px 18px;
    backdrop-filter: blur(16px);
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }

  .section-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
  }

  .card-diario::before { background: linear-gradient(90deg, #00F0FF, #38BDF8); }
  .card-semanal::before { background: linear-gradient(90deg, #FBBF24, #F59E0B); }
  .card-mensal::before { background: linear-gradient(90deg, #10B981, #00FF9D); }
  .card-vip::before { background: linear-gradient(90deg, #C084FC, #818CF8); }
  .card-faseado::before { background: linear-gradient(90deg, #38BDF8, #6366F1); }
  .card-ilimitado::before { background: linear-gradient(90deg, #EF4444, #F97316); }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .section-title {
    font-family: 'Outfit', sans-serif;
    font-size: 15.5px;
    font-weight: 800;
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .card-diario .section-title { color: #00F0FF; }
  .card-semanal .section-title { color: #FBBF24; }
  .card-mensal .section-title { color: #00FF9D; }
  .card-vip .section-title { color: #C084FC; }
  .card-faseado .section-title { color: #38BDF8; }
  .card-ilimitado .section-title { color: #F87171; }

  .section-badge {
    font-size: 9.5px;
    font-weight: 800;
    padding: 3px 7px;
    border-radius: 6px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: rgba(255, 255, 255, 0.08);
    color: #94A3B8;
  }

  /* List of Price Items */
  .price-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .price-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 9px;
    padding: 6.5px 10px;
    transition: all 0.2s;
  }

  .price-item.highlight {
    background: rgba(0, 229, 255, 0.06);
    border-color: rgba(0, 229, 255, 0.2);
  }

  .item-left {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    font-weight: 700;
    color: #F1F5F9;
  }

  .item-left i {
    font-size: 10px;
    color: #64748B;
  }

  .card-diario .item-left i { color: #00F0FF; }
  .card-semanal .item-left i { color: #FBBF24; }
  .card-mensal .item-left i { color: #00FF9D; }
  .card-vip .item-left i { color: #C084FC; }
  .card-faseado .item-left i { color: #38BDF8; }
  .card-ilimitado .item-left i { color: #F87171; }

  .item-right {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    color: #FFFFFF;
    background: rgba(0, 0, 0, 0.35);
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .item-right span {
    font-size: 10px;
    color: #94A3B8;
  }

  .card-diario .item-right { color: #00F0FF; border: 1px solid rgba(0, 229, 255, 0.2); }
  .card-semanal .item-right { color: #FBBF24; border: 1px solid rgba(245, 158, 11, 0.2); }
  .card-mensal .item-right { color: #00FF9D; border: 1px solid rgba(16, 185, 129, 0.25); }
  .card-vip .item-right { color: #E879F9; border: 1px solid rgba(217, 70, 239, 0.2); }
  .card-faseado .item-right { color: #38BDF8; border: 1px solid rgba(56, 189, 248, 0.2); }
  .card-ilimitado .item-right { color: #FCA5A5; border: 1px solid rgba(239, 68, 68, 0.25); }

  /* Compact 2-column list for Diários */
  .diario-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 5.5px;
  }

  .special-desc-box {
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 9px;
    background: rgba(56, 189, 248, 0.08);
    border: 1px dashed rgba(56, 189, 248, 0.3);
    font-size: 11.5px;
    color: #93C5FD;
    line-height: 1.4;
  }

  .special-desc-box b {
    color: #FFFFFF;
  }

  /* Bottom Blocks: Pagamento + Como Ativar + Suporte */
  .bottom-section {
    width: 100%;
    display: grid;
    grid-template-columns: 1.1fr 1.3fr 0.8fr;
    gap: 16px;
    position: relative;
    z-index: 2;
    margin-top: 10px;
  }

  .info-box {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 14px 18px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .info-header {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 800;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    letter-spacing: 0.04em;
  }

  .payment-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 7px 12px;
    margin-bottom: 6px;
  }

  .payment-tag {
    font-size: 12px;
    font-weight: 800;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .payment-tag.mpesa { color: #EF4444; }
  .payment-tag.emola { color: #F59E0B; }

  .payment-num {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13.5px;
    font-weight: 800;
    color: #FFFFFF;
  }

  .payment-name {
    font-size: 10px;
    color: #94A3B8;
    text-align: right;
  }

  /* Step box */
  .step-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: #CBD5E1;
    margin-bottom: 6px;
  }

  .step-num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(0, 229, 255, 0.15);
    border: 1px solid rgba(0, 229, 255, 0.4);
    color: #00F0FF;
    font-weight: 800;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .step-row b {
    color: #00FF9D;
  }

  /* Support Box */
  .support-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: calc(100% - 28px);
  }

  .support-badge {
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.35);
    padding: 8px 12px;
    border-radius: 10px;
    text-align: center;
    margin-bottom: 6px;
  }

  .support-phone {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    font-weight: 800;
    color: #00FF9D;
  }

  .support-sub {
    font-size: 10.5px;
    color: #94A3B8;
    text-align: center;
  }

  /* Footer bar */
  .footer-bar {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 11.5px;
    color: #64748B;
    position: relative;
    z-index: 2;
  }

  .footer-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #94A3B8;
    font-weight: 700;
  }

  .footer-brand i { color: #00F0FF; }

  .footer-pills {
    display: flex;
    gap: 8px;
  }

  .footer-pill {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    padding: 3px 10px;
    border-radius: 14px;
    font-size: 10.5px;
    color: #94A3B8;
    font-weight: 600;
  }
</style>
</head>
<body>

<div class="bg-glow-top"></div>
<div class="bg-glow-mid"></div>
<div class="bg-glow-bottom"></div>
<div class="grid-pattern"></div>

<!-- Header -->
<div class="header">
  <div class="top-pill">
    <div class="dot"></div>
    TABELA OFICIAL DE PREÇOS • KA-NET SYSTEM
  </div>
  <h1 class="main-title">
    PACOTES DE <span class="gradient-text">INTERNET ULTRARRÁPIDA</span> ⚡
  </h1>
  <p class="subtitle">
    O melhor preço, entrega em segundos e atendimento automático <b>24 Horas por dia</b> em Moçambique 🇲🇿
  </p>
</div>

<!-- Main 3-Column Grid -->
<div class="grid-main">

  <!-- ==================== COLUNA 1 ==================== -->
  <div style="display:flex; flex-direction:column; gap:14px;">
    <!-- PACOTES DIÁRIOS (24H) -->
    <div class="section-card card-diario" style="flex:1;">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-bolt-lightning"></i> Diários (24H)
        </div>
        <div class="section-badge">17 Opções</div>
      </div>
      <div class="price-list diario-grid">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 350 MB</div><div class="item-right">11 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 550 MB</div><div class="item-right">15 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 696 MB</div><div class="item-right">18 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 800 MB</div><div class="item-right">20 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-star" style="color:#00F0FF;"></i> 1 GB</div><div class="item-right">23 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 1.2 GB</div><div class="item-right">28 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 1.3 GB</div><div class="item-right">30 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 1.6 GB</div><div class="item-right">37 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-star" style="color:#00F0FF;"></i> 2 GB</div><div class="item-right">46 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 3 GB</div><div class="item-right">69 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 4 GB</div><div class="item-right">92 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 5 GB</div><div class="item-right">115 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 6 GB</div><div class="item-right">138 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 7 GB</div><div class="item-right">161 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 8 GB</div><div class="item-right">184 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 9 GB</div><div class="item-right">207 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-crown" style="color:#00F0FF;"></i> 10 GB</div><div class="item-right">230 <span>MT</span></div></div>
      </div>
    </div>
  </div>

  <!-- ==================== COLUNA 2 ==================== -->
  <div style="display:flex; flex-direction:column; gap:14px;">
    <!-- PACOTES SEMANAIS (7 DIAS) -->
    <div class="section-card card-semanal">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-calendar-week"></i> Semanais (7 Dias)
        </div>
        <div class="section-badge">Validade 7D</div>
      </div>
      <div class="price-list">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 1.7 GB</div><div class="item-right">47 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 2.9 GB</div><div class="item-right">80 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 3.4 GB</div><div class="item-right">90 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-star" style="color:#FBBF24;"></i> 5.3 GB</div><div class="item-right">140 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 7.2 GB</div><div class="item-right">190 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-fire" style="color:#FBBF24;"></i> 10.7 GB</div><div class="item-right">290 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 14.1 GB</div><div class="item-right">380 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 17.6 GB</div><div class="item-right">470 <span>MT</span></div></div>
      </div>
    </div>

    <!-- PLANOS ESPECIAIS VIP -->
    <div class="section-card card-vip">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-gem"></i> Especiais VIP
        </div>
        <div class="section-badge">Renovações</div>
      </div>
      <div class="price-list">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-arrows-rotate"></i> 3GB+700 (Renovação)</div><div class="item-right">76 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-arrows-rotate"></i> 5GB+700 (Renovação)</div><div class="item-right">120 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-layer-group"></i> 5GB Faseado</div><div class="item-right">130 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-arrows-rotate"></i> 8GB+700 (Renovação)</div><div class="item-right">195 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-arrows-rotate"></i> 10GB+700 (Renovação)</div><div class="item-right">240 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-layer-group"></i> 10GB Faseado</div><div class="item-right">255 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-layer-group"></i> 15GB Faseado</div><div class="item-right">381 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-layer-group"></i> 20GB Faseado</div><div class="item-right">510 <span>MT</span></div></div>
      </div>
    </div>

    <!-- FASEADO MENSAL INTERATIVO -->
    <div class="section-card card-faseado">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-sliders"></i> Faseado Interativo
        </div>
        <div class="section-badge">Personalizado</div>
      </div>
      <div class="price-list">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-calendar-check"></i> 10 GB Faseado</div><div class="item-right">232 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-calendar-check"></i> 20 GB Faseado</div><div class="item-right">461 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-calendar-check"></i> 30 GB Faseado</div><div class="item-right">700 <span>MT</span></div></div>
      </div>
      <div class="special-desc-box">
        💡 <b>Você no controle:</b> Defina quantos GB quer receber por dia. Confirme via WhatsApp, SMS ou Ka-Net Hub!
      </div>
    </div>
  </div>

  <!-- ==================== COLUNA 3 ==================== -->
  <div style="display:flex; flex-direction:column; gap:14px;">
    <!-- PACOTES MENSAIS (30 DIAS) -->
    <div class="section-card card-mensal">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-calendar-days"></i> Mensais (30 Dias)
        </div>
        <div class="section-badge">Validade 30D</div>
      </div>
      <div class="price-list">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 2.8 GB</div><div class="item-right">95 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-star" style="color:#00FF9D;"></i> 3 GB</div><div class="item-right">76 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 5 GB</div><div class="item-right">120 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 8 GB</div><div class="item-right">195 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-fire" style="color:#00FF9D;"></i> 10 GB</div><div class="item-right">232 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 13 GB</div><div class="item-right">390 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 15 GB</div><div class="item-right">381 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-crown" style="color:#00FF9D;"></i> 20 GB</div><div class="item-right">461 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 25 GB</div><div class="item-right">800 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-rocket" style="color:#00FF9D;"></i> 30 GB</div><div class="item-right">700 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 51 GB</div><div class="item-right">1455 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-circle"></i> 102 GB</div><div class="item-right">2890 <span>MT</span></div></div>
      </div>
    </div>

    <!-- ILIMITADOS (30 DIAS + LIGAÇÕES) -->
    <div class="section-card card-ilimitado" style="flex:1;">
      <div class="section-header">
        <div class="section-title">
          <i class="fa-solid fa-phone-volume"></i> Ilimitados + Minutos
        </div>
        <div class="section-badge">Vodacom 30D</div>
      </div>
      <div class="price-list">
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-sim-card"></i> Voda 11GB + Min</div><div class="item-right">450 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-sim-card"></i> Voda 9GB + Min</div><div class="item-right">469 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-star" style="color:#F87171;"></i> Voda 15GB + Min</div><div class="item-right">570 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-sim-card"></i> Voda 25GB + Min</div><div class="item-right">850 <span>MT</span></div></div>
        <div class="price-item"><div class="item-left"><i class="fa-solid fa-sim-card"></i> Voda 23GB + Min</div><div class="item-right">950 <span>MT</span></div></div>
        <div class="price-item highlight"><div class="item-left"><i class="fa-solid fa-crown" style="color:#F87171;"></i> Voda 38GB + Min</div><div class="item-right">1450 <span>MT</span></div></div>
      </div>
    </div>
  </div>

</div>

<!-- Bottom Section: Pagamentos + Como Ativar + Suporte -->
<div class="bottom-section">
  <!-- Box 1: Pagamento -->
  <div class="info-box">
    <div class="info-header" style="color:#00F0FF;">
      <i class="fa-solid fa-wallet"></i> Formas de Pagamento
    </div>
    <div class="payment-row">
      <div>
        <div class="payment-tag mpesa"><i class="fa-solid fa-mobile-screen"></i> M-Pesa</div>
        <div class="payment-num">856268811</div>
      </div>
      <div class="payment-name">Kelven Junior<br>Anabela Nharrava</div>
    </div>
    <div class="payment-row" style="margin-bottom:0;">
      <div>
        <div class="payment-tag emola"><i class="fa-solid fa-mobile-screen"></i> e-Mola</div>
        <div class="payment-num">864882152</div>
      </div>
      <div class="payment-name">Catia Anabela<br>Nharrava</div>
    </div>
  </div>

  <!-- Box 2: Como Ativar -->
  <div class="info-box">
    <div class="info-header" style="color:#00FF9D;">
      <i class="fa-solid fa-bolt"></i> Ativação Automática 24H
    </div>
    <div class="step-row">
      <div class="step-num">1</div>
      <div>Pague o valor do pacote desejado por M-Pesa ou e-Mola.</div>
    </div>
    <div class="step-row">
      <div class="step-num">2</div>
      <div>Envie o <b>comprovativo (texto ou imagem/foto)</b> aqui.</div>
    </div>
    <div class="step-row" style="margin-bottom:0;">
      <div class="step-num">3</div>
      <div>Coloque o <b>número de destino na última linha</b>.</div>
    </div>
  </div>

  <!-- Box 3: Suporte -->
  <div class="info-box">
    <div class="info-header" style="color:#FBBF24;">
      <i class="fa-solid fa-headset"></i> Apoio ao Cliente
    </div>
    <div class="support-content">
      <div class="support-badge">
        <div class="support-phone"><i class="fa-solid fa-phone"></i> 850401416</div>
      </div>
      <div class="support-sub">
        Envie <b>Suporte</b> no chat ou ligue para atendimento direto.
      </div>
    </div>
  </div>
</div>

<!-- Footer Bar -->
<div class="footer-bar">
  <div class="footer-brand">
    <i class="fa-solid fa-shield-halved"></i>
    <span>KA-NET SYSTEM • Tecnologia de Recargas Inteligentes em Moçambique 🇲🇿</span>
  </div>
  <div class="footer-pills">
    <span class="footer-pill">⚡ Entrega Instantânea</span>
    <span class="footer-pill">📸 Leitor OCR</span>
    <span class="footer-pill">🎙️ Áudio WhatsApp</span>
    <span class="footer-pill">🔒 100% Seguro</span>
  </div>
</div>

</body>
</html>`;

(async () => {
  console.log('🚀 Gerando Tabela Completa de Preços Ka-Net...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1960, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Aguardar carregamento das fontes do Google e ícones
  await new Promise(r => setTimeout(r, 2500));

  const outputPath = path.resolve(__dirname, 'tabela_precos_kanet_completa.png');
  await page.screenshot({ path: outputPath, fullPage: false });

  // Copiar para artefatos
  const artifactDir = 'C:\\Users\\Kelven\\.gemini\\antigravity\\brain\\96fbd304-c56c-4154-b7c5-70839e09bdc1';
  const artifactPath = path.join(artifactDir, 'tabela_precos_kanet_completa.png');
  fs.copyFileSync(outputPath, artifactPath);

  await browser.close();
  console.log('✅ Tabela salva em:', outputPath);
  console.log('✅ Tabela copiada para artefatos em:', artifactPath);
})();
