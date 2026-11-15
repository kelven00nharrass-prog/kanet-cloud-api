const puppeteer = require('puppeteer');
const path = require('path');

async function gerarWallpaper(config) {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;600;700&display=swap');

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    width: 1080px;
    height: 1920px;
    background: ${config.bgGradient};
    overflow: hidden;
    position: relative;
    font-family: 'Rajdhani', sans-serif;
}

/* Grid pattern overlay */
.grid-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background-image: 
        linear-gradient(${config.gridColor} 1px, transparent 1px),
        linear-gradient(90deg, ${config.gridColor} 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
    z-index: 1;
}

/* Animated circuit lines */
.circuit-line {
    position: absolute;
    z-index: 2;
}

.circuit-line.h1 {
    top: 15%;
    left: 0;
    width: 100%;
    height: 2px;
    background: linear-gradient(90deg, transparent, ${config.accentColor}40, transparent);
}
.circuit-line.h2 {
    top: 45%;
    left: 0;
    width: 100%;
    height: 1px;
    background: linear-gradient(90deg, transparent, ${config.accentColor}30, transparent);
}
.circuit-line.h3 {
    top: 75%;
    left: 0;
    width: 100%;
    height: 2px;
    background: linear-gradient(90deg, transparent, ${config.accentColor}40, transparent);
}
.circuit-line.v1 {
    top: 0;
    left: 20%;
    width: 1px;
    height: 100%;
    background: linear-gradient(180deg, transparent, ${config.accentColor}25, transparent);
}
.circuit-line.v2 {
    top: 0;
    left: 50%;
    width: 1px;
    height: 100%;
    background: linear-gradient(180deg, transparent, ${config.accentColor}20, transparent);
}
.circuit-line.v3 {
    top: 0;
    left: 80%;
    width: 1px;
    height: 100%;
    background: linear-gradient(180deg, transparent, ${config.accentColor}25, transparent);
}

/* Nodes at intersections */
.node {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${config.accentColor};
    box-shadow: 0 0 10px ${config.accentColor}80, 0 0 20px ${config.accentColor}40;
    z-index: 3;
}
.node.n1 { top: 15%; left: 20%; }
.node.n2 { top: 15%; left: 80%; }
.node.n3 { top: 45%; left: 50%; }
.node.n4 { top: 75%; left: 20%; }
.node.n5 { top: 75%; left: 80%; }
.node.n6 { top: 30%; left: 35%; width: 6px; height: 6px; opacity: 0.6; }
.node.n7 { top: 60%; left: 65%; width: 6px; height: 6px; opacity: 0.6; }

/* Floating hex patterns */
.hex-pattern {
    position: absolute;
    z-index: 2;
    opacity: 0.06;
    font-family: 'Orbitron', monospace;
    font-size: 11px;
    color: ${config.codeColor};
    letter-spacing: 3px;
    line-height: 2;
    white-space: pre;
    transform: rotate(${config.codeRotation});
}
.hex-pattern.p1 { top: 5%; left: 5%; }
.hex-pattern.p2 { top: 35%; right: 5%; text-align: right; }
.hex-pattern.p3 { bottom: 15%; left: 10%; }
.hex-pattern.p4 { top: 55%; left: 3%; }
.hex-pattern.p5 { bottom: 35%; right: 3%; text-align: right; }

/* Large decorative icon */
.big-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 320px;
    opacity: 0.04;
    z-index: 2;
    color: ${config.iconColor};
    text-shadow: 0 0 60px ${config.iconColor}30;
}

/* Corner decorations */
.corner {
    position: absolute;
    width: 80px;
    height: 80px;
    z-index: 3;
    opacity: 0.4;
}
.corner.tl {
    top: 20px; left: 20px;
    border-top: 3px solid ${config.accentColor};
    border-left: 3px solid ${config.accentColor};
}
.corner.tr {
    top: 20px; right: 20px;
    border-top: 3px solid ${config.accentColor};
    border-right: 3px solid ${config.accentColor};
}
.corner.bl {
    bottom: 20px; left: 20px;
    border-bottom: 3px solid ${config.accentColor};
    border-left: 3px solid ${config.accentColor};
}
.corner.br {
    bottom: 20px; right: 20px;
    border-bottom: 3px solid ${config.accentColor};
    border-right: 3px solid ${config.accentColor};
}

/* Scattered small icons */
.scatter-icon {
    position: absolute;
    z-index: 2;
    opacity: 0.07;
    font-size: 40px;
}
.scatter-icon.s1 { top: 8%; left: 60%; transform: rotate(-15deg); }
.scatter-icon.s2 { top: 22%; left: 75%; transform: rotate(10deg); }
.scatter-icon.s3 { top: 38%; left: 8%; transform: rotate(-5deg); }
.scatter-icon.s4 { top: 52%; left: 85%; transform: rotate(20deg); }
.scatter-icon.s5 { top: 68%; left: 12%; transform: rotate(-10deg); }
.scatter-icon.s6 { top: 82%; left: 70%; transform: rotate(15deg); }
.scatter-icon.s7 { top: 90%; left: 30%; transform: rotate(-20deg); }
.scatter-icon.s8 { top: 28%; left: 45%; transform: rotate(8deg); font-size: 30px; }
.scatter-icon.s9 { top: 62%; left: 40%; transform: rotate(-12deg); font-size: 30px; }

/* Glow orbs */
.glow-orb {
    position: absolute;
    border-radius: 50%;
    z-index: 1;
    filter: blur(80px);
}
.glow-orb.g1 {
    top: 10%;
    right: -5%;
    width: 300px;
    height: 300px;
    background: ${config.glow1};
}
.glow-orb.g2 {
    bottom: 20%;
    left: -10%;
    width: 400px;
    height: 400px;
    background: ${config.glow2};
}
.glow-orb.g3 {
    top: 50%;
    left: 40%;
    width: 250px;
    height: 250px;
    background: ${config.glow3};
}

/* Brand watermark - repeated subtle pattern */
.watermark {
    position: absolute;
    z-index: 2;
    font-family: 'Orbitron', monospace;
    font-weight: 900;
    font-size: 16px;
    letter-spacing: 8px;
    color: ${config.watermarkColor};
    opacity: 0.04;
    transform: rotate(-30deg);
    white-space: nowrap;
}
.watermark.w1 { top: 12%; left: -5%; }
.watermark.w2 { top: 28%; left: 15%; }
.watermark.w3 { top: 44%; left: -10%; }
.watermark.w4 { top: 60%; left: 20%; }
.watermark.w5 { top: 76%; left: -5%; }
.watermark.w6 { top: 92%; left: 10%; }

/* Status bar style header */
.status-tag {
    position: absolute;
    top: 35px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    background: ${config.tagBg};
    border: 1px solid ${config.tagBorder};
    border-radius: 20px;
    padding: 6px 24px;
    font-family: 'Orbitron', monospace;
    font-size: 11px;
    font-weight: 700;
    color: ${config.tagColor};
    letter-spacing: 4px;
    text-transform: uppercase;
    backdrop-filter: blur(10px);
}

/* Bottom brand */
.bottom-brand {
    position: absolute;
    bottom: 35px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    font-family: 'Orbitron', monospace;
    font-size: 12px;
    font-weight: 400;
    color: ${config.brandColor};
    letter-spacing: 6px;
    opacity: 0.3;
}

/* Pulse ring */
.pulse-ring {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 200px;
    border-radius: 50%;
    border: 1px solid ${config.accentColor}15;
    z-index: 2;
}
.pulse-ring.r2 {
    width: 350px;
    height: 350px;
    border-color: ${config.accentColor}10;
}
.pulse-ring.r3 {
    width: 500px;
    height: 500px;
    border-color: ${config.accentColor}08;
}

</style>
</head>
<body>

<div class="grid-overlay"></div>

<!-- Circuit lines -->
<div class="circuit-line h1"></div>
<div class="circuit-line h2"></div>
<div class="circuit-line h3"></div>
<div class="circuit-line v1"></div>
<div class="circuit-line v2"></div>
<div class="circuit-line v3"></div>

<!-- Nodes -->
<div class="node n1"></div>
<div class="node n2"></div>
<div class="node n3"></div>
<div class="node n4"></div>
<div class="node n5"></div>
<div class="node n6"></div>
<div class="node n7"></div>

<!-- Glow orbs -->
<div class="glow-orb g1"></div>
<div class="glow-orb g2"></div>
<div class="glow-orb g3"></div>

<!-- Pulse rings -->
<div class="pulse-ring"></div>
<div class="pulse-ring r2"></div>
<div class="pulse-ring r3"></div>

<!-- Big center icon -->
<div class="big-icon">${config.bigIcon}</div>

<!-- Scattered icons -->
${config.scatterIcons.map((icon, i) => `<div class="scatter-icon s${i+1}">${icon}</div>`).join('\n')}

<!-- Hex code patterns -->
<div class="hex-pattern p1">${config.codeBlock1}</div>
<div class="hex-pattern p2">${config.codeBlock2}</div>
<div class="hex-pattern p3">${config.codeBlock3}</div>
<div class="hex-pattern p4">${config.codeBlock4}</div>
<div class="hex-pattern p5">${config.codeBlock5}</div>

<!-- Watermarks -->
<div class="watermark w1">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>
<div class="watermark w2">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>
<div class="watermark w3">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>
<div class="watermark w4">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>
<div class="watermark w5">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>
<div class="watermark w6">KA-NET SYSTEM • KA-NET SYSTEM • KA-NET SYSTEM •</div>

<!-- Corners -->
<div class="corner tl"></div>
<div class="corner tr"></div>
<div class="corner bl"></div>
<div class="corner br"></div>

<!-- Status tag -->
<div class="status-tag">${config.statusTag}</div>

<!-- Bottom brand -->
<div class="bottom-brand">KA-NET CLOUD</div>

</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.screenshot({ path: config.outputPath, type: 'png', fullPage: false });
    await browser.close();
    console.log(`✅ Wallpaper salvo: ${config.outputPath}`);
}

async function main() {
    // ========== WALLPAPER: GRUPO DE ERROS ==========
    await gerarWallpaper({
        outputPath: path.join(__dirname, 'wallpaper_grupo_erros.png'),
        statusTag: '⚠ LOG DE ERROS • SISTEMA',
        bigIcon: '⚠',
        bgGradient: 'linear-gradient(160deg, #0a0008 0%, #1a0a0a 20%, #120005 40%, #0d0d18 60%, #150008 80%, #0a0012 100%)',
        gridColor: 'rgba(255, 40, 40, 0.08)',
        accentColor: '#ff2d2d',
        codeColor: '#ff4444',
        iconColor: '#ff2222',
        glow1: 'radial-gradient(circle, rgba(255,30,30,0.15), transparent)',
        glow2: 'radial-gradient(circle, rgba(180,0,40,0.12), transparent)',
        glow3: 'radial-gradient(circle, rgba(255,60,20,0.08), transparent)',
        watermarkColor: '#ff3333',
        tagBg: 'rgba(255, 30, 30, 0.08)',
        tagBorder: 'rgba(255, 30, 30, 0.25)',
        tagColor: '#ff4444',
        brandColor: '#ff3333',
        codeRotation: '-2deg',
        codeBlock1: 'ERR_CONN_REFUSED\nTIMEOUT 0x4E20\nSTACK_OVERFLOW\nNULL_POINTER\nSEGFAULT 0xDEAD',
        codeBlock2: 'CRASH_DUMP\n0xFF001A2B\nHEAP_CORRUPT\nBAD_REQUEST\nFATAL_ERROR',
        codeBlock3: 'EXCEPTION 0x80\nMEM_LEAK 0xBEEF\nPANIC_KERNEL\nBUFFER_OVER\nUNHANDLED',
        codeBlock4: 'ERR_404\nTLS_FAIL\nDNS_TIMEOUT\nRETRY_LIMIT\nBAD_GATEWAY',
        codeBlock5: 'SOCKET_ERR\nASYNC_FAIL\nDB_DEADLOCK\nRACE_COND\nOOM_KILLER',
        scatterIcons: ['🐛', '❌', '💥', '🔴', '⛔', '🚨', '⚡', '🔥', '💀']
    });

    // ========== WALLPAPER: GRUPO DE NOTIFICAÇÕES ==========
    await gerarWallpaper({
        outputPath: path.join(__dirname, 'wallpaper_grupo_notificacoes.png'),
        statusTag: '🔔 NOTIFICAÇÕES • SISTEMA',
        bigIcon: '🔔',
        bgGradient: 'linear-gradient(160deg, #000814 0%, #001233 20%, #001845 40%, #000c24 60%, #001a3a 80%, #000a1f 100%)',
        gridColor: 'rgba(0, 150, 255, 0.06)',
        accentColor: '#0096ff',
        codeColor: '#00aaff',
        iconColor: '#0088ff',
        glow1: 'radial-gradient(circle, rgba(0,120,255,0.15), transparent)',
        glow2: 'radial-gradient(circle, rgba(0,60,180,0.12), transparent)',
        glow3: 'radial-gradient(circle, rgba(0,150,255,0.08), transparent)',
        watermarkColor: '#0088ff',
        tagBg: 'rgba(0, 150, 255, 0.08)',
        tagBorder: 'rgba(0, 150, 255, 0.25)',
        tagColor: '#00aaff',
        brandColor: '#0088ff',
        codeRotation: '2deg',
        codeBlock1: 'MSG_RECEIVED\nNEW_ORDER 0x01\nPAYMENT_OK\nSESSION_START\nACTIVATED ✓',
        codeBlock2: 'WEBHOOK_IN\n0x00C0FFEE\nQUEUE_PUSH\nEVENT_EMIT\nSYNC_COMPLETE',
        codeBlock3: 'NOTIFY 0xBELL\nALERT_NEW\nSUBSCRIBED\nDELIVERED ✓\nCONFIRMED',
        codeBlock4: 'LOG_INFO\nSTATUS_200\nHEALTH_OK\nUPTIME_99\nRESPONSE_MS',
        codeBlock5: 'DATA_RECV\nACK_SENT\nTASK_DONE\nBOT_ONLINE\nALL_CLEAR',
        scatterIcons: ['🔔', '📩', '✅', '📊', '💬', '🔵', '📡', '⚡', '🟢']
    });
}

main().catch(err => { console.error('ERRO:', err); process.exit(1); });
