require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const MASTER_TOKENS = new Set([
  process.env.MASTER_TOKEN || 'KaNetKelven2026Secure',
  'GitoAquinoMasterToken2025'
]);

// ----------------------------------------------------
// 1. FIREBASE INITIALIZATION
// ----------------------------------------------------
let db = null;
try {
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    const localKeyPath = path.resolve(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(localKeyPath)) {
      serviceAccount = require(localKeyPath);
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id || 'ka-net-math'}.firebaseio.com`
    });
    db = admin.firestore();
    console.log('🔥 [FIREBASE] Firestore Conectado:', serviceAccount.project_id || 'ka-net-math');
  } else {
    console.log('⚠️ [FIREBASE] Sem credenciais no momento. Operando em modo Cloud Gateway.');
  }
} catch (err) {
  console.error('❌ [FIREBASE ERRO]:', err.message);
}

// In-Memory Device & Order Store (Fallback & Instant Sync)

// In-Memory Device & Order Store
let pendingBotCommand = null;
let inMemoryMetrics = null;
const inMemoryDevices = {
  8023: { porta: 8023, carrier: 'Vodacom (Huawei)', saldo_mb: 10240, bateria: 100, online: true, livre: true, is_busy: false, lastSeen: new Date().toISOString() },
  8077: { porta: 8077, carrier: 'Vodacom (Redmi)', saldo_mb: 10240, bateria: 100, online: true, livre: true, is_busy: false, lastSeen: new Date().toISOString() }
};

// const oldInMemoryDevices = {
  8023: { porta: 8023, carrier: 'Vodacom (SIM 1)', saldo_mb: 10240, bateria: 100, online: true, livre: true, is_busy: false, lastSeen: new Date().toISOString() },
  8077: { porta: 8077, carrier: 'Vodacom (Redmi)', saldo_mb: 10240, bateria: 100, online: true, livre: true, is_busy: false, lastSeen: new Date().toISOString() }
};
const inMemoryOrders = new Map();

// ----------------------------------------------------
// 2. MIDDLEWARES
// ----------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------------------
// 3. HEALTH & ROOT ENDPOINTS
// ----------------------------------------------------
app.get(['/health', '/', '/status'], (req, res) => {
  res.json({
    status: 'online',
    service: 'Ka-Net Cloud API (Render + Firebase)',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    devices_online: Object.keys(inMemoryDevices).length
  });
});

// ----------------------------------------------------
// 4. TRANSFER ENDPOINTS (BOT & WEBHOOKS)
// ----------------------------------------------------
async function handleTransfer(req, res) {
  try {
    const { numero, quantidade, modo = 'data', remetente = 'Bot', porta = null, request_id = null } = req.body;

    if (!numero) {
      return res.status(400).json({ success: false, status: 'erro', mensagem: 'Número obrigatório' });
    }

    const orderId = request_id || `ORD-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const timestamp = new Date().toISOString();

    const orderDoc = {
      orderId,
      numero: String(numero).replace(/\D/g, ''),
      quantidade: Number(quantidade) || Number(req.body.input_val) || 0,
      modo,
      targetPort: porta ? Number(porta) : null,
      remetente,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    inMemoryOrders.set(orderId, orderDoc);

    if (db) {
      try {
        await db.collection('orders').doc(orderId).set(orderDoc);
        console.log(`📡 [FIREBASE] Pedido ${orderId} salvo na nuvem.`);
      } catch (e) {
        console.warn('⚠️ [FIREBASE] Falha ao salvar no Firestore:', e.message);
      }
    }

    // Resposta imediata para o Bot não travar
    return res.status(200).json({
      status: 'sucesso',
      success: true,
      processing: true,
      orderId,
      mensagem: 'Pedido recebido e despachado na nuvem Ka-Net'
    });
  } catch (error) {
    console.error('❌ [TRANSFER ERRO]:', error);
    return res.status(500).json({ status: 'erro', success: false, mensagem: error.message });
  }
}

app.post(['/api/transferir', '/transferir-dados', '/transferir-dados/'], handleTransfer);

// ----------------------------------------------------
// 5. DEVICE TELEMETRY & HEALTH
// ----------------------------------------------------
app.get('/api/devices', async (req, res) => {
  const now = Date.now();
  const devices = Object.values(inMemoryDevices).map(dev => {
    const lastSeen = new Date(dev.lastSeen || 0).getTime();
    const online = (now - lastSeen) < 180000; // 3 min window
    return { ...dev, online };
  });
  return res.json({ success: true, count: devices.length, devices });
});

app.get(['/api/devices/:port/health', '/:port/health'], (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port] || {
    status: 'ok',
    online: true,
    porta: port,
    saldo_mb: 10240,
    saldo: 10240,
    sem_saldo: false,
    livre: true,
    is_busy: false,
    bateria: 100,
    carrier: 'Vodacom'
  };
  return res.json({ status: 'ok', online: true, ...dev });
});

app.post(['/api/devices/:port/status', '/api/devices/:port/heartbeat'], (req, res) => {
  const port = Number(req.params.port);
  inMemoryDevices[port] = {
    porta: port,
    ...req.body,
    lastSeen: new Date().toISOString()
  };

  if (db) {
    db.collection('devices').doc(String(port)).set(inMemoryDevices[port], { merge: true }).catch(() => {});
  }

  return res.json({ success: true, timestamp: new Date().toISOString() });
});

// Endpoint para o Aplicativo Android buscar transferências pendentes (sem cabo)
app.get('/api/devices/:port/tasks', async (req, res) => {
  const port = Number(req.params.port);
  
  // Atualizar lastSeen do dispositivo
  if (inMemoryDevices[port]) {
    inMemoryDevices[port].lastSeen = new Date().toISOString();
  }

  // Buscar próximo pedido pendente para esta porta ou genérico
  let task = null;
  for (const [orderId, order] of inMemoryOrders.entries()) {
    if (order.status === 'pending') {
      if (!order.targetPort || order.targetPort === port) {
        order.status = 'processing';
        order.assignedToPort = port;
        order.processingAt = new Date().toISOString();
        task = order;
        break;
      }
    }
  }

  if (task) {
    console.log(`📱 [APP WIRELESS] Despachando pedido ${task.orderId} para Celular Porta ${port}: ${task.quantidade}MB para ${task.numero}`);
    return res.json({ hasTask: true, task });
  }

  return res.json({ hasTask: false });
});

// Endpoint para o Aplicativo Android confirmar conclusão de USSD
app.post('/api/devices/:port/tasks/:orderId/result', async (req, res) => {
  const { port, orderId } = req.params;
  const { success, mensagem, saldo_mb } = req.body;

  const order = inMemoryOrders.get(orderId);
  if (order) {
    order.status = success ? 'completed' : 'failed';
    order.resultMessage = mensagem || '';
    order.completedAt = new Date().toISOString();
  }

  if (db) {
    db.collection('orders').doc(orderId).set({
      status: success ? 'completed' : 'failed',
      resultMessage: mensagem || '',
      completedAt: new Date().toISOString()
    }, { merge: true }).catch(() => {});
  }

  console.log(`📲 [APP RESULT] Pedido ${orderId} finalizado pelo Celular ${port}: ${success ? 'SUCESSO' : 'FALHA'}`);
  return res.json({ success: true });
});

// ----------------------------------------------------
// 6. PAYMOZ / M-PESA WEBHOOK
// ----------------------------------------------------
app.post('/api/webhooks/paymoz', async (req, res) => {
  const payload = req.body;
  console.log('💳 [WEBHOOK PAYMOZ]:', JSON.stringify(payload));

  const { status, reference, customer_phone, metadata } = payload;
  if (status === 'successful' || status === 'COMPLETED' || payload.success === true) {
    const targetPhone = customer_phone || (metadata && metadata.phone);
    const megas = (metadata && metadata.megas) || 1024;
    if (targetPhone) {
      await handleTransfer({
        body: { numero: targetPhone, quantidade: megas, modo: 'data', remetente: `PayMoz-${reference || 'Auto'}` }
      }, { status: () => ({ json: () => {} }) });
    }
  }

  return res.status(200).json({ received: true });
});

// ----------------------------------------------------
// 7. INICIAR SERVIDOR
// ----------------------------------------------------

// ════════════════════════════════════════════════════════════════
// 6.5 KA-NET PRO ADMIN ROUTES & CLOUD PWA
// ════════════════════════════════════════════════════════════════

// Firebase DB Helper
async function fbGet(refPath) {
  try {
    if (!admin.apps.length) return null;
    const snap = await admin.database().ref(refPath).once('value');
    return snap.val();
  } catch(e) {
    return null;
  }
}
async function fbSet(refPath, data) {
  try {
    if (!admin.apps.length) return false;
    await admin.database().ref(refPath).set(data);
    return true;
  } catch(e) {
    return false;
  }
}

// Admin Metrics
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const data = await fbGet('admin/metrics');
    if (data) return res.json({ success: true, ...data });
    res.json({
      success: true,
      synced_at: null,
      today: { lucro: 0, vendas: 0, megas: 0 },
      week: { lucro: 0, vendas: 0, megas: 0 },
      month: { lucro: 0, vendas: 0, megas: 0 },
      chartData: [],
      recentSales: []
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin Queue
app.get('/api/admin/queue', async (req, res) => {
  try {
    const data = await fbGet('admin/queue');
    const pending = data ? Object.values(data) : [];
    res.json({ success: true, count: pending.length, pending });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/queue/cancel/:ref', async (req, res) => {
  try {
    const ref = req.params.ref;
    await fbSet(`admin/queue/${ref}/status`, 'cancelado');
    await fbSet('bot_commands/pending', { cmd: 'cancel_order', ref, issued_at: new Date().toISOString() });
    res.json({ success: true, message: `Pedido ${ref} cancelado` });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin Groups & Subscriptions
app.get('/api/admin/groups', async (req, res) => {
  try {
    const data = await fbGet('admin/groups');
    const groups = data ? Object.values(data) : [];
    res.json({ success: true, count: groups.length, groups });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/subscriptions', async (req, res) => {
  try {
    const data = await fbGet('admin/subscriptions');
    const plans = data ? Object.values(data) : [];
    res.json({ success: true, count: plans.length, plans });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Bot Status & Commands
app.get('/api/admin/bot/status', async (req, res) => {
  try {
    const status = await fbGet('admin/bot_status');
    if (!status) return res.json({ success: true, online: false, last_seen: null });
    const lastSeen = new Date(status.last_seen || 0);
    const online = (Date.now() - lastSeen.getTime()) < 90000;
    res.json({ success: true, online, ...status });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


app.post('/api/admin/transfers/reset', async (req, res) => {
  try {
    if (admin.apps.length) {
      await admin.database().ref('admin/metrics/today').set({ lucro: 0, vendas: 0, megas: 0 });
      await admin.database().ref('bot_commands/pending').set({ cmd: 'reset_transfers', issued_at: new Date().toISOString() });
    }
    res.json({ success: true, message: 'Contador de transferências zerado!' });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/bot/command', async (req, res) => {
  try {
    const { cmd } = req.body;
    if (!['start','stop','restart','reset_whatsapp'].includes(cmd)) {
      return res.status(400).json({ success: false, error: 'Comando inválido' });
    }
    pendingBotCommand = { cmd, issued_at: new Date().toISOString() };
    if (admin.apps.length) await fbSet('bot_commands/pending', pendingBotCommand);
    console.log(`🤖 [BOT CMD ENVIADO]: ${cmd}`);
    res.json({ success: true, message: `Comando '${cmd}' enviado para o bot local` });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/bot/command/pending', async (req, res) => {
  try {
    let pending = pendingBotCommand;
    if (!pending && admin.apps.length) pending = await fbGet('bot_commands/pending');
    res.json({ success: true, pending: pending || null });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/bot/command', async (req, res) => {
  try {
    pendingBotCommand = null;
    if (admin.apps.length) await admin.database().ref('bot_commands/pending').remove().catch(() => {});
    res.json({ success: true, message: 'Comando removido' });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sync from Bot Local
app.post('/api/admin/sync', async (req, res) => {
  try {
    const { metrics, queue, groups, subscriptions, bot_status } = req.body;
    if (admin.apps.length) {
      const updates = {};
      if (metrics) updates['admin/metrics'] = { ...metrics, synced_at: new Date().toISOString() };
      if (queue) updates['admin/queue'] = queue;
      if (groups) updates['admin/groups'] = groups;
      if (subscriptions) updates['admin/subscriptions'] = subscriptions;
      if (bot_status) updates['admin/bot_status'] = { ...bot_status, last_seen: new Date().toISOString() };
      await admin.database().ref('/').update(updates);
    }
    res.json({ success: true, message: 'Sincronizado' });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 7. BAILEYS WHATSAPP BOT ENGINE (24h/7d CLOUD NATIVO)
// ════════════════════════════════════════════════════════════════
let baileysEngine = null;
try {
  baileysEngine = require('./baileys_engine');
  baileysEngine.startWhatsApp((order) => {
    console.log(`📱 [WHATSAPP NUVEM] Nova ordem recebida via WhatsApp: ${order.orderId} (${order.quantidade}MB para ${order.numero})`);
    // Despacha para o canal em tempo real do celular
    const targetPort = 8023;
    if (inMemoryDevices[targetPort]) {
      inMemoryDevices[targetPort].pending_order = {
        id: order.orderId,
        orderId: order.orderId,
        numero: order.numero,
        quantidade: order.quantidade,
        modo: order.modo || 'diario',
        jid: order.jid,
        timestamp: Date.now()
      };
      console.log(`🚀 [WHATSAPP NUVEM] Ordem entregue ao canal do Celular ${targetPort}`);
    }
  });
} catch(e) {
  console.warn('⚠️ [BAILEYS] Inicializando em modo standard:', e.message);
}

// ── ROTA DO QR CODE (PÁGINA WEB PARA ESCANEAR NO CELULAR) ───
app.get('/api/whatsapp/status', (req, res) => {
  if (baileysEngine) {
    return res.json(baileysEngine.getStatus());
  }
  return res.json({ status: 'offline', hasQr: false });
});

app.get('/qr', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ka-Net WhatsApp Cloud — Conectar</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 30px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    h1 { font-size: 22px; margin-bottom: 8px; color: #38bdf8; }
    p { font-size: 14px; color: #94a3b8; margin-top: 0; line-height: 1.5; }
    .qr-box {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin: 20px 0;
      min-width: 240px;
      min-height: 240px;
    }
    .qr-box img { width: 240px; height: 240px; display: block; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-top: 10px;
    }
    .status-online { background: #064e3b; color: #34d399; }
    .status-waiting { background: #451a03; color: #fbbf24; }
    .steps {
      text-align: left;
      font-size: 13px;
      color: #cbd5e1;
      background: #0f172a;
      padding: 14px;
      border-radius: 10px;
      margin-top: 20px;
    }
    .steps ol { margin: 0; padding-left: 20px; }
    .steps li { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ Ka-Net WhatsApp Cloud</h1>
    <p>Conecte o seu WhatsApp diretamente ao servidor na Nuvem (sem computador ligado).</p>

    <div id="status-container" class="status status-waiting">
      <span>⏳ A carregar estado...</span>
    </div>

    <div id="qr-wrapper" class="qr-box">
      <div style="padding-top: 100px; color: #64748b;">A carregar QR...</div>
    </div>

    <div class="steps">
      <strong>Como conectar:</strong>
      <ol>
        <li>Abra o <b>WhatsApp</b> no celular do Bot</li>
        <li>Toque em <b>Definições / Menu (⋮)</b></li>
        <li>Selecione <b>Aparelhos Conectados</b></li>
        <li>Toque em <b>Conectar um Aparelho</b> e aponte para o QR Code acima</li>
      </ol>
    </div>
  </div>

  <script>
    async function updateQR() {
      try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        const statusBox = document.getElementById('status-container');
        const qrBox = document.getElementById('qr-wrapper');

        if (data.status === 'connected') {
          statusBox.className = 'status status-online';
          statusBox.innerHTML = '✅ WhatsApp Conectado com Sucesso! (' + (data.user || 'Online') + ')';
          qrBox.innerHTML = '<div style="padding: 60px 20px; color: #10b981; font-weight: bold; font-size: 18px;">✅ Conectado 24h na Nuvem!</div>';
        } else if (data.hasQr && data.qrImage) {
          statusBox.className = 'status status-waiting';
          statusBox.innerHTML = '📱 Aponte a câmara do WhatsApp para o QR Code';
          qrBox.innerHTML = '<img src="' + data.qrImage + '" alt="QR Code WhatsApp" />';
        } else {
          statusBox.className = 'status status-waiting';
          statusBox.innerHTML = '⏳ A gerar novo QR Code...';
        }
      } catch(e) {}
    }

    updateQR();
    setInterval(updateQR, 3000);
  </script>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================================');
  console.log(`🚀 [KA-NET CLOUD API] Servidor Online na porta ${PORT}`);
  console.log(`📱 [WHATSAPP QR CODE] Aceda a http://localhost:${PORT}/qr para conectar`);
  console.log('==================================================================');
});

