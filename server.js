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
const inMemoryDevices = {
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
  const devices = Object.values(inMemoryDevices);
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
app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================================');
  console.log(`🚀 [KA-NET CLOUD API] Servidor Online na porta ${PORT}`);
  console.log('==================================================================');
});
