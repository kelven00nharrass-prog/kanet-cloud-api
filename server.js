require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

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

// In-Memory Device & Order Store (Dinâmico - sem dispositivos fantasmas)
let pendingBotCommand = null;
let inMemoryMetrics = null;
const inMemoryDevices = {};

const inMemoryOrders = new Map();

// ----------------------------------------------------
// 2. MIDDLEWARES
// ----------------------------------------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const compression = require('compression');
app.use(compression()); // Compressão gzip — reduz respostas JSON/HTML em 60-80%
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------------------
// 3. HEALTH & ROOT ENDPOINTS
// ----------------------------------------------------
app.get(['/health', '/', '/status'], (req, res) => {
  const now = Date.now();
  const onlineCount = Object.values(inMemoryDevices).filter(d => (now - new Date(d.lastSeen || 0).getTime()) < 35000).length;
  res.json({
    status: 'online',
    service: 'Ka-Net Cloud API (Render + Firebase)',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    devices_online: onlineCount,
    devices_total: Object.keys(inMemoryDevices).length
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

    const numLimpo = String(numero).replace(/\D/g, '');
    const orderId = (request_id || req.body.ref || req.body.id || `ORD-${Date.now()}-${uuidv4().substring(0, 8)}`).trim();
    const timestamp = new Date().toISOString();
    const qtyMb = Number(quantidade) || Number(req.body.input_val) || 0;
    const valPago = Number(req.body.valor) || Number(req.body.valor_pago) || getValorFromMb(qtyMb, modo);

    // ── 1. PROTEÇÃO CONTRA DUPLICAÇÃO POR REFERÊNCIA / ID ──
    if (inMemoryOrders.has(orderId)) {
      const existing = inMemoryOrders.get(orderId);
      if (existing.status === 'completed' || existing.status === 'sucesso') {
        console.warn(`🛡️ [DEDUPLICAÇÃO] Pedido com referência ${orderId} já foi CONCLUÍDO. Bloqueando duplicação.`);
        return res.status(200).json({
          status: 'concluido',
          success: true,
          duplicado: true,
          orderId,
          mensagem: `Este pedido com a referência ${orderId} já foi atendido e concluído anteriormente!`
        });
      }
      if (existing.status === 'assigned' || existing.status === 'processing' || existing.status === 'pending') {
        console.warn(`🛡️ [DEDUPLICAÇÃO] Pedido com referência ${orderId} já está na fila (${existing.status}). Ignorando duplicação.`);
        return res.status(200).json({
          status: 'processando',
          success: true,
          duplicado: true,
          orderId,
          mensagem: `Este pedido (${orderId}) já está na fila e a ser atendido!`
        });
      }
    }

    // ── 2. PROTEÇÃO DE REFERÊNCIA NO CACHE PERSISTENTE (caso o servidor tenha reiniciado) ──
    if (fs.existsSync(ORDERS_CACHE_FILE)) {
      try {
        const cachedList = JSON.parse(fs.readFileSync(ORDERS_CACHE_FILE, 'utf8'));
        const found = cachedList.find(([k, v]) => k === orderId);
        if (found && (found[1].status === 'completed' || found[1].status === 'sucesso')) {
          console.warn(`🛡️ [DEDUPLICAÇÃO CACHE] Referência ${orderId} já consta como CONCLUÍDA.`);
          return res.status(200).json({
            status: 'concluido',
            success: true,
            duplicado: true,
            orderId,
            mensagem: `Este pedido com a referência ${orderId} já foi atendido e concluído anteriormente!`
          });
        }
      } catch(e) {}
    }

    const orderDoc = {
      orderId,
      id: orderId,
      numero: numLimpo,
      quantidade: qtyMb,
      valor: valPago,
      valor_pago: valPago,
      modo,
      targetPort: porta ? Number(porta) : null,
      remetente,
      jid: req.body.jid || null,
      input_val: req.body.input_val || '',
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    // Aplicar regra oficial Ka-Net de divisão de pacotes Mensais (1ª oferta + resto diário)
    splitMensalOrderIfEligible(orderDoc);

    inMemoryOrders.set(orderId, orderDoc);
    saveOrdersToCache();

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

// ── ENDPOINT EXCLUSIVO PARA O ENVIO MANUAL DO KA-NET ADMIN MASTER ──
app.post('/api/send/manual', async (req, res) => {
  try {
    const { numero, volume, quantidade, modo = 'diario', porta = null } = req.body || {};
    if (!numero) {
      return res.status(400).json({ success: false, message: 'Número de telefone é obrigatório.' });
    }

    const numLimpo = String(numero).replace(/\D/g, '');
    const qtyMb = Number(quantidade) || Number(volume) || 350;
    const orderId = `MANUAL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const timestamp = new Date().toISOString();

    const orderDoc = {
      orderId,
      id: orderId,
      numero: numLimpo,
      quantidade: qtyMb,
      valor: getValorFromMb(qtyMb, modo),
      valor_pago: getValorFromMb(qtyMb, modo),
      modo: modo.toLowerCase(),
      targetPort: porta ? Number(porta) : null,
      remetente: 'Admin Master (Manual)',
      input_val: req.body.input_val || (modo === 'mensal' ? '1' : ''),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    // Aplicar regra oficial de divisão mensal (se for mensal > 2867MB)
    splitMensalOrderIfEligible(orderDoc);

    inMemoryOrders.set(orderId, orderDoc);
    saveOrdersToCache();

    if (db) {
      db.collection('orders').doc(orderId).set(orderDoc).catch(e => console.warn('Firebase manual order save err:', e.message));
    }

    console.log(`📤 [ENVIO MANUAL] Ordem ${orderId} criada pelo Admin: ${qtyMb}MB (${modo}) para ${numLimpo}`);

    return res.status(200).json({
      success: true,
      orderId,
      message: `Pacote de ${qtyMb}MB (${modo}) despachado com sucesso para ${numLimpo}!`
    });
  } catch (err) {
    console.error('❌ [ENVIO MANUAL ERRO]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
app.get('/api/devices', async (req, res) => {
  const now = Date.now();
  const devices = Object.values(inMemoryDevices).map(dev => {
    const lastSeen = new Date(dev.lastSeen || 0).getTime();
    const online = (now - lastSeen) < 35000; // 35 segundos (heartbeat a cada 3s)
    const apto = isDeviceApto(dev);
    return { ...dev, online, is_apto: apto };
  });
  return res.json({ success: true, count: devices.length, devices });
});

// ── RESET / LIBERTAR PORTA (operador) ──
app.post('/api/devices/:port/reset', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  // Resetar flags de bloqueio
  dev.sem_saldo = false;
  dev.limite_atingido = false;
  dev.livre = true;
  dev.is_apto = true;
  dev.paused = false;
  dev.pending_order = null;
  dev.currentOrder = null;
  dev.isBusy = false;
  dev._lastBlockLogTime = 0;
  dev.manual_saldo_override = Date.now();

  // Enviar comando ao celular via próximo polling (/health)
  dev.pending_commands = dev.pending_commands || {};
  dev.pending_commands.reset_counters = true;

  // Se o body tiver saldos explícitos, actualizar
  if (req.body && req.body.sim1_saldo_mb !== undefined) dev.sim1_saldo_mb = Number(req.body.sim1_saldo_mb);
  if (req.body && req.body.sim2_saldo_mb !== undefined) dev.sim2_saldo_mb = Number(req.body.sim2_saldo_mb);
  if (req.body && req.body.saldo_mb !== undefined) dev.saldo_mb = Number(req.body.saldo_mb);
  if (req.body && req.body.saldo_mt !== undefined) dev.saldo_mt = Number(req.body.saldo_mt);

  console.log(`🔓 [MANUSEIO PAINEL] Porta ${port} libertada manualmente pelo operador.`);
  return res.json({ success: true, mensagem: `Porta ${port} libertada e desbloqueada com sucesso!`, device: dev });
});

// ── AJUSTAR SALDO MANUALMENTE (operador) ──
app.post('/api/devices/:port/set-saldo', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  const { sim1_saldo_mb, sim2_saldo_mb, saldo_mb, saldo_mt } = req.body || {};
  if (sim1_saldo_mb !== undefined) dev.sim1_saldo_mb = Number(sim1_saldo_mb);
  if (sim2_saldo_mb !== undefined) dev.sim2_saldo_mb = Number(sim2_saldo_mb);
  if (saldo_mb !== undefined) dev.saldo_mb = Number(saldo_mb);
  if (saldo_mt !== undefined) dev.saldo_mt = Number(saldo_mt);

  dev.manual_saldo_override = Date.now();

  // Enviar novo saldo ao aplicativo no celular
  dev.pending_commands = dev.pending_commands || {};
  if (sim1_saldo_mb !== undefined) dev.pending_commands.set_sim1_saldo_mb = Number(sim1_saldo_mb);
  if (sim2_saldo_mb !== undefined) dev.pending_commands.set_sim2_saldo_mb = Number(sim2_saldo_mb);

  // Se o saldo configurado for >= 100MB, desmarcar sem_saldo
  const maxMb = Math.max(dev.sim1_saldo_mb || 0, dev.sim2_saldo_mb || 0, dev.saldo_mb || 0);
  if (maxMb >= 100 || (dev.saldo_mt !== undefined && dev.saldo_mt > 0)) {
    dev.sem_saldo = false;
    dev.is_apto = true;
    dev.livre = true;
  }

  console.log(`💰 [MANUSEIO PAINEL] Saldo da Porta ${port} ajustado para: SIM1=${dev.sim1_saldo_mb}MB | SIM2=${dev.sim2_saldo_mb}MB | Saldo=${dev.saldo_mb}MB / ${dev.saldo_mt}MT`);
  return res.json({ success: true, mensagem: `Saldo da Porta ${port} atualizado com sucesso!`, device: dev });
});

// ── ALTERNAR SIM ATIVO (operador) ──
app.post('/api/devices/:port/set-sim', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  const slot = Number(req.body && req.body.slot);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ success: false, mensagem: 'Slot de SIM deve ser 1 ou 2.' });
  }

  dev.active_sim_slot = slot;
  dev.carrier = dev.carrier ? dev.carrier.replace(/SIM\s*\d/, `SIM ${slot}`) : `Vodacom (SIM ${slot})`;
  dev.pending_commands = dev.pending_commands || {};
  dev.pending_commands.set_sim_slot = slot;

  console.log(`📶 [MANUSEIO PAINEL] Porta ${port} alternada para SIM ${slot}`);
  return res.json({ success: true, mensagem: `Porta ${port} configurada para usar SIM ${slot}!`, device: dev });
});

// ── PAUSAR / RETOMAR CELULAR (operador) ──
app.post('/api/devices/:port/toggle-pause', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  dev.paused = !dev.paused;
  console.log(`⏸️ [MANUSEIO PAINEL] Porta ${port} ${dev.paused ? 'PAUSADA' : 'RETOMADA'} pelo operador.`);
  return res.json({
    success: true,
    paused: dev.paused,
    mensagem: dev.paused ? `Porta ${port} pausada. Não receberá pedidos até ser retomada.` : `Porta ${port} retomada e pronta para pedidos!`,
    device: dev
  });
});

// ── FORÇAR DESPACHO DE PEDIDO PARA ESTA PORTA (operador) ──
app.post('/api/devices/:port/force-dispatch', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  if (dev.pending_order) {
    return res.status(400).json({ success: false, mensagem: `Porta ${port} já tem um pedido em processamento (${dev.pending_order.numero}).` });
  }

  // Buscar primeiro pedido pendente compatível
  let targetOrder = null;
  let targetOrderId = null;
  for (const [orderId, order] of inMemoryOrders.entries()) {
    if (order.status === 'pending') {
      const isCompat = isPortCompatibleWithModo(port, order.modo);
      if (isCompat) {
        targetOrder = order;
        targetOrderId = orderId;
        break;
      }
    }
  }

  if (!targetOrder) {
    return res.json({ success: false, mensagem: `Nenhum pedido pendente compatível na fila para a Porta ${port}.` });
  }

  targetOrder.status = 'assigned';
  targetOrder.assignedToPort = port;
  targetOrder.targetPort = port;
  targetOrder.processingAt = new Date().toISOString();

  dev.pending_order = {
    id: targetOrderId,
    orderId: targetOrderId,
    numero: targetOrder.numero,
    quantidade: targetOrder.quantidade,
    modo: targetOrder.modo || 'diario',
    input_val: targetOrder.input_val || '',
    jid: targetOrder.jid || null,
    timestamp: Date.now()
  };

  saveOrdersToCache();
  console.log(`⚡ [MANUSEIO PAINEL] Pedido ${targetOrderId} (${targetOrder.quantidade}MB -> ${targetOrder.numero}) despachado FORÇADO para Porta ${port}!`);
  return res.json({ success: true, mensagem: `Pedido ${targetOrderId} (${targetOrder.quantidade}MB) despachado para a Porta ${port}!`, order: targetOrder });
});

// ── FORÇAR DESPACHO OVERRIDE (ignora modo/compatibilidade) ──
// Usar quando portas normais estão sem saldo mas há outra porta disponível
app.post('/api/devices/:port/force-dispatch-override', (req, res) => {
  const port = Number(req.params.port);
  const dev = inMemoryDevices[port];
  if (!dev) return res.status(404).json({ success: false, mensagem: `Porta ${port} não encontrada.` });

  if (dev.pending_order) {
    return res.status(400).json({ success: false, mensagem: `Porta ${port} já tem um pedido em processamento (${dev.pending_order.numero}).` });
  }

  // Buscar pedido específico (por ID) ou primeiro pendente qualquer
  const targetOrderId = req.body && req.body.orderId;
  let foundOrder = null;
  let foundId = null;

  if (targetOrderId) {
    foundOrder = inMemoryOrders.get(targetOrderId);
    foundId = targetOrderId;
  } else {
    for (const [orderId, order] of inMemoryOrders.entries()) {
      if (order.status === 'pending') {
        foundOrder = order;
        foundId = orderId;
        break;
      }
    }
  }

  if (!foundOrder || !foundId) {
    return res.json({ success: false, mensagem: `Nenhum pedido pendente encontrado para despacho.` });
  }

  foundOrder.status = 'assigned';
  foundOrder.assignedToPort = port;
  foundOrder.targetPort = port;
  foundOrder.processingAt = new Date().toISOString();
  foundOrder._overrideDispatch = true;

  dev.sem_saldo = false;
  dev.limite_atingido = false;
  dev.livre = true;
  dev.is_apto = true;
  dev.pending_order = {
    id: foundId,
    orderId: foundId,
    numero: foundOrder.numero,
    quantidade: foundOrder.quantidade,
    modo: foundOrder.modo || 'diario',
    input_val: foundOrder.input_val || '',
    jid: foundOrder.jid || null,
    timestamp: Date.now()
  };

  saveOrdersToCache();
  console.log(`⚡ [OVERRIDE PAINEL] Pedido ${foundId} (${foundOrder.quantidade}MB -> ${foundOrder.numero}) despachado OVERRIDE para Porta ${port}!`);
  return res.json({ success: true, mensagem: `Pedido ${foundId} (${foundOrder.quantidade}MB → ${foundOrder.numero}) despachado para a Porta ${port} com override!`, order: foundOrder });
});

// ── LIBERTAR TODOS OS CELULARES (operador) ──
app.post('/api/devices/reset-all', (req, res) => {
  let count = 0;
  for (const [portStr, dev] of Object.entries(inMemoryDevices)) {
    dev.sem_saldo = false;
    dev.limite_atingido = false;
    dev.livre = true;
    dev.is_apto = true;
    dev.paused = false;
    dev.pending_order = null;
    dev.currentOrder = null;
    dev.isBusy = false;
    dev._lastBlockLogTime = 0;
    count++;
  }
  console.log(`🔓 [MANUSEIO PAINEL] Todos os ${count} celulares foram libertados e desbloqueados.`);
  return res.json({ success: true, mensagem: `Todos os ${count} celulares foram libertados e estão prontos!`, count });
});

function isPortCompatibleWithModo(port, modo) {
  const p = Number(port);
  if (p === 8090) return false; // 🚫 Porta 8090 é exclusiva para SMS e Leitura M-Pesa/e-Mola
  const m = String(modo || '').toLowerCase().trim();
  if (m === 'saldo' || m === 'credito') {
    return p === 8777;
  }
  if (m === 'semanal' || m === 'mensal' || m === 'ilimitado' || m === 'ilimitados' || m.startsWith('esp') || m.includes('seman') || m.includes('mens')) {
    return p === 8077;
  }
  // Pacotes Diários: compatível com qualquer celular diário (8021 a 8028)
  return p !== 8077 && p !== 8777 && p !== 8090;
}

function getPortForModo(modo) {
  const m = String(modo || '').toLowerCase().trim();
  if (m === 'saldo' || m === 'credito') return 8777;
  if (m === 'semanal' || m === 'mensal' || m === 'ilimitado' || m === 'ilimitados' || m.startsWith('esp') || m.includes('seman') || m.includes('mens')) return 8077;

  // Para diários: selecionar dinamicamente a melhor porta diária online e apta
  const dailyDevs = Object.values(inMemoryDevices).filter(d => {
    const port = Number(d.porta);
    return port !== 8077 && port !== 8777 && port !== 8090 && isDeviceApto(d);
  });
  if (dailyDevs.length > 0) {
    // Escolher a porta com maior saldo ou mais transferências disponíveis
    dailyDevs.sort((a, b) => (b.transfers_available || 0) - (a.transfers_available || 0));
    return Number(dailyDevs[0].porta);
  }
  // Se nenhuma porta diária estiver apta no momento, verificar qualquer porta diária registrada online
  const anyDailyDev = Object.values(inMemoryDevices).find(d => {
    const port = Number(d.porta);
    return port !== 8077 && port !== 8777 && port !== 8090;
  });
  if (anyDailyDev) return Number(anyDailyDev.porta);

  return 8025; // fallback padrão (Huawei)
}

// ── REGRA OFICIAL KA-NET: PACOTES MENSAIS (1ª Oferta Vodacom + Diferença Diária) ──
// Vodacom *162# -> 5 -> 1 entrega 2.8GB (2867MB) por 95 MT.
// Para pedidos mensais > 2867MB (ex: 5GB = 5120MB, 8GB = 8192MB, 10GB = 10240MB):
// 1ª Parte: 2867MB via Porta 8077 (Modo Mensal, Opção 1).
// 2ª Parte: (Total - 2867MB) via Portas Diárias (Modo Diário / 24hrs).
const MENSAL_BASE_MB = 2867; // 2.8 GB

function splitMensalOrderIfEligible(orderDoc) {
  if (!orderDoc) return false;
  const modo = String(orderDoc.modo || '').toLowerCase().trim();
  const qty = Number(orderDoc.quantidade) || 0;
  if (modo === 'mensal' && qty > MENSAL_BASE_MB && !orderDoc.isSplit) {
    const totalMb = qty;
    const parte1 = MENSAL_BASE_MB;
    const parte2 = totalMb - parte1;
    const parentId = orderDoc.id || orderDoc.orderId;
    const part2Id = `${parentId}-DIARIO`;

    // Configurar Parte 1: Mensal (Porta 8077)
    orderDoc.isSplit = true;
    orderDoc.splitPart = 1;
    orderDoc.splitTotalParts = 2;
    orderDoc.splitTotalMb = totalMb;
    orderDoc.splitOtherPartMb = parte2;
    orderDoc.part2Id = part2Id;
    orderDoc.quantidade = parte1;
    orderDoc.targetPort = 8077;
    orderDoc.input_val = '1'; // 1ª oferta mensal

    // Criar Parte 2: Diário (Portas Diárias)
    const orderPart2 = {
      id: part2Id,
      orderId: part2Id,
      parentOrderId: parentId,
      numero: orderDoc.numero,
      quantidade: parte2,
      modo: 'diario',
      input_val: '',
      jid: orderDoc.jid || null,
      remetente: orderDoc.remetente || 'Bot',
      targetPort: null,
      isSplit: true,
      splitPart: 2,
      splitTotalParts: 2,
      splitTotalMb: totalMb,
      splitOtherPartMb: parte1,
      status: 'waiting_part1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notified: false,
      groupNotified: false
    };

    inMemoryOrders.set(part2Id, orderPart2);
    saveOrdersToCache();

    console.log(`📦 [SPLIT MENSAL KA-NET] Pedido Mensal ${parentId} (${totalMb}MB) dividido automaticamente:`);
    console.log(`   👉 Parte 1 (Mensal): ${parte1}MB -> Porta 8077 (1ª Oferta *162#)`);
    console.log(`   👉 Parte 2 (Diário): ${parte2}MB -> Portas Diárias (Aguardando conclusão da Parte 1)`);

    return true;
  }
  return false;
}

function isDeviceApto(dev) {
  if (!dev) return false;
  if (dev.paused === true) return false; // Pausado manualmente pelo operador
  const now = Date.now();
  const lastSeen = new Date(dev.lastSeen || 0).getTime();
  const isOnline = (now - lastSeen) < 35000;
  if (!isOnline) return false;
  if (dev.pending_order) return false;
  if (dev.livre === false) return false;

  const port = Number(dev.porta);

  // ── PORTA DEDICADA DE SMS & ATENDIMENTO (8090) ──
  // Nunca atende pacotes de dados USSD (diários, semanais ou mensais)
  if (port === 8090 || dev.tipo === 'sms_dedicated') {
    return false;
  }

  // ── PORTAS ESPECIAIS (8077 - Semanais/Mensais/Ilimitados e 8777 - Saldo/Crédito) ──
  if (port === 8077 || port === 8777) {
    if (dev.sem_saldo === true) return false;
    if (dev.saldo_mt !== undefined && dev.saldo_mt <= 0) return false;
    return true;
  }

  // ── PORTAS DIÁRIAS (todas as demais portas) ──
  if (dev.limite_atingido === true) return false;
  if (dev.transfers_available !== undefined && dev.transfers_available <= 0) return false;
  const s1 = dev.sim1_saldo_mb !== undefined && dev.sim1_saldo_mb !== null ? dev.sim1_saldo_mb : 10240;
  const s2 = dev.sim2_saldo_mb !== undefined && dev.sim2_saldo_mb !== null ? dev.sim2_saldo_mb : 10240;
  // Só considera sem saldo se AMBOS os cartões estiverem zerados (<100MB) ou marcados sem saldo
  if (s1 < 100 && s2 < 100) return false;
  if (dev.sem_saldo === true && s1 < 100 && s2 < 100) return false;
  return true;
}

const MIN_TRANSFER_MB = 100;

function getDeviceAvailableMb(dev) {
  if (!dev) return 0;
  const port = Number(dev.porta);
  if (port === 8077 || port === 8777) return 102400; // Planos ilimitados/semanais/mensais/saldo

  const slot = dev.active_sim_slot || 1;
  const slotSaldo = slot === 2 ? dev.sim2_saldo_mb : dev.sim1_saldo_mb;
  if (slotSaldo !== undefined && Number(slotSaldo) > 0) {
    return Number(slotSaldo);
  }
  if (dev.saldo_mb !== undefined && Number(dev.saldo_mb) > 0) {
    return Number(dev.saldo_mb);
  }
  return 10240;
}

app.get(['/api/devices/:port/health', '/:port/health'], (req, res) => {
  const port = Number(req.params.port);
  let dev = inMemoryDevices[port];
  if (!dev) {
    // Auto-registar qualquer novo celular que reporte pela primeira vez
    const carrierName = port === 8023 ? 'Vodacom (Huawei)' :
                        port === 8025 ? 'Vodacom (Huawei 8025)' :
                        port === 8077 ? 'Movitel (Xiaomi 8077)' :
                        port === 8777 ? 'Vodacom (Saldo)' :
                        `Vodacom (Celular ${port})`;
    dev = {
      porta: port,
      carrier: carrierName,
      saldo_mb: 0,
      sem_saldo: false,
      livre: true,
      is_busy: false,
      pending_order: null,
      lastSeen: new Date().toISOString()
    };
    inMemoryDevices[port] = dev;
    console.log(`📱 [NOVO DISPOSITIVO] Celular Porta ${port} registado automaticamente! (${carrierName})`);
  }

  // ── AUTO-DISPATCH DE PEDIDOS PENDENTES DA FILA (ROTEAMENTO ESTRITO & APTIDÃO) ──
  // - Portas Diárias (8025, 8023, 8024): Exclusivas para pacotes diários (24hrs)
  // - Porta 8077: Exclusiva para pacotes semanais, mensais e ilimitados (NUNCA assume diários)
  // - Porta 8777: Exclusiva para recargas de saldo/crédito
  // - SÓ atribui pedidos se o celular estiver 100% APTO (com saldo >= 100MB e sem ter atingido limite diário)
  if (isDeviceApto(dev)) {
    for (const [orderId, order] of inMemoryOrders.entries()) {
        if (order.status !== 'pending') continue;

        // TTL / Validade máxima do pedido: 45 minutos (evita que pedidos velhos repitam horas depois)
        if (order.createdAt) {
          const ageMs = Date.now() - new Date(order.createdAt).getTime();
          if (ageMs > 45 * 60 * 1000) { // > 45 minutos
            order.status = 'expired';
            order.lastError = 'Pedido expirado (mais de 45 minutos na fila)';
            order.completedAt = new Date().toISOString();
            console.warn(`⏰ [EXPIRAÇÃO] Pedido ${orderId} (${order.quantidade}MB -> ${order.numero}) expirou após 45m na fila.`);
            continue;
          }
        }

        // Aplicar regra oficial Ka-Net de divisão de pacotes Mensais (1ª oferta + resto diário)
        splitMensalOrderIfEligible(order);

        let isCompatible = order.targetPort ? (order.targetPort === port) : isPortCompatibleWithModo(port, order.modo);
        // GARANTIA ABSOLUTA: Porta 8077 aceita APENAS semanal, mensal ou ilimitado (NUNCA diários)
        if (port === 8077) {
          const m = String(order.modo || '').toLowerCase().trim();
          const isEspecial = m === 'semanal' || m === 'mensal' || m === 'ilimitado' || m === 'ilimitados' || m.startsWith('esp') || m.includes('seman') || m.includes('mens') || m.includes('top');
          if (!isEspecial) {
            isCompatible = false;
          }
        }
        if (isCompatible) {
          const orderMb = Number(order.quantidade) || 0;
          const availableMb = getDeviceAvailableMb(dev);
          const isDataMode = (order.modo || 'diario').toLowerCase().trim() !== 'saldo' && (order.modo || 'diario').toLowerCase().trim() !== 'credito';

          // ── DIVISÃO INTELIGENTE DE PACOTE (SPLIT-TRANSFER ENTRE PORTAS) ──
          // Se a porta tem menos que o pedido, mas >= 50MB, e o restante também é >= 50MB,
          // e há outra porta compatível online para assumir a segunda parte:
          const canSplit = !order.isSplit &&
                           isDataMode &&
                           orderMb > availableMb &&
                           availableMb >= MIN_TRANSFER_MB &&
                           (orderMb - availableMb) >= MIN_TRANSFER_MB;

          if (canSplit) {
            const otherCandidateOnline = Object.values(inMemoryDevices).some(d => {
              if (Number(d.porta) === port) return false;
              const now = Date.now();
              const lastSeen = new Date(d.lastSeen || 0).getTime();
              const isOnline = (now - lastSeen) < 180000;
              return isOnline && !d.sem_saldo && !d.limite_atingido && isPortCompatibleWithModo(Number(d.porta), order.modo);
            });

            if (otherCandidateOnline) {
              const totalMb = orderMb;
              const parte1 = Math.floor(availableMb);
              const parte2 = totalMb - parte1;
              const parentId = order.id || order.orderId || orderId;
              const part2Id = `${parentId}-P2`;

              // Configurar Parte 1 nesta ordem
              order.isSplit = true;
              order.splitPart = 1;
              order.splitTotalParts = 2;
              order.splitTotalMb = totalMb;
              order.splitOtherPartMb = parte2;
              order.part2Id = part2Id;
              order.quantidade = parte1;
              order.status = 'assigned';
              order.targetPort = port;
              order.assignedToPort = port;
              order.processingAt = new Date().toISOString();

              // Criar Parte 2 aguardando a conclusão da Parte 1
              const orderPart2 = {
                id: part2Id,
                orderId: part2Id,
                parentOrderId: parentId,
                numero: order.numero,
                quantidade: parte2,
                modo: order.modo || 'diario',
                input_val: '', // ⚠️ Limpar input_val para que a Parte 2 use estritamente a quantidade restante (parte2)
                jid: order.jid || null,
                remetente: order.remetente || 'Bot',
                targetPort: null,
                isSplit: true,
                splitPart: 2,
                splitTotalParts: 2,
                splitTotalMb: totalMb,
                splitOtherPartMb: parte1,
                status: 'waiting_part1',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                notified: false,
                groupNotified: false
              };
              inMemoryOrders.set(part2Id, orderPart2);
              saveOrdersToCache();

              dev.pending_order = {
                id: order.id || order.orderId || orderId,
                orderId: order.id || order.orderId || orderId,
                numero: order.numero,
                quantidade: parte1,
                modo: order.modo || 'diario',
                input_val: '', // ⚠️ Limpar input_val para que a Parte 1 envie estritamente a quantidade da parte1
                jid: order.jid || null,
                timestamp: Date.now()
              };

              console.log(`🔀 [ENVIO INTELIGENTE DIVIDIDO] Pedido ${parentId} de ${totalMb}MB dividido em 2 partes:`);
              console.log(`   👉 Parte 1: ${parte1}MB atribuído à Porta ${port}`);
              console.log(`   👉 Parte 2: ${parte2}MB aguardando conclusão da Parte 1 para despacho por outra porta.`);

              // Notificar cliente via WhatsApp sobre a divisão
              let clientJid = order.jid;
              if (!clientJid && baileysEngine && typeof baileysEngine.getJidForOrder === 'function') {
                clientJid = baileysEngine.getJidForOrder(parentId);
              }
              if (clientJid && baileysEngine && !order.splitAnnounced) {
                order.splitAnnounced = true;
                baileysEngine.sendTextMessage(clientJid,
                  `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                  `  📦 *ENVIO DE PACOTE EM 2 PARTES* 📶\n` +
                  `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                  `Olá! Para agilizar a entrega do seu pacote de *${totalMb} MB*, ele será transferido em *2 partes* usando as nossas linhas disponíveis:\n\n` +
                  `1️⃣ *1ª Parte:* *${parte1} MB* (A enviar agora...)\n` +
                  `2️⃣ *2ª Parte:* *${parte2} MB* (A enviar logo a seguir por outra linha)\n\n` +
                  `📲 *Destino:* *${order.numero}*\n` +
                  `✨ *Total:* *${totalMb} MB*\n\n` +
                  `⚡ _Você receberá a confirmação de cada parte assim que for concluída!_`
                );
                console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} informado sobre divisão em 2 partes do pedido ${parentId}`);
              }

              break;
            }
          }

          // Atribuição padrão (sem divisão)
          order.status = 'assigned';
          order.targetPort = port;
          order.assignedToPort = port;
          order.processingAt = new Date().toISOString();
          saveOrdersToCache();

          dev.pending_order = {
            id: order.id || order.orderId,
            orderId: order.id || order.orderId,
            numero: order.numero,
            quantidade: order.quantidade,
            modo: order.modo || 'diario',
            input_val: order.input_val || '',
            jid: order.jid || null,
            timestamp: Date.now()
          };
          console.log(`📦 [FILA NUVEM] Atribuindo pedido ${orderId} (${order.quantidade}MB [${order.modo || 'diario'}] -> ${order.numero}) ao Celular Apto Porta ${port}`);
          break;
        }
      }
  } else if (dev.limite_atingido || dev.sem_saldo || (dev.transfers_available !== undefined && dev.transfers_available <= 0)) {
    // ── LÓGICA DE FALLBACK: redirecionar pedidos desta porta para outra porta disponível ──
    const now2 = Date.now();
    const lastBlockLog = dev._lastBlockLogTime || 0;
    if (now2 - lastBlockLog > 30000) { // logar máx 1x a cada 30s por porta
      dev._lastBlockLogTime = now2;
      console.log(`⏸️ [PAUSA OPERACIONAL] Celular Porta ${port} sem saldo ou atingiu o limite. A verificar portas alternativas...`);
    }

    for (const [orderId, order] of inMemoryOrders.entries()) {
      if (order.status === 'pending') {
        const designatedPort = order.targetPort || getPortForModo(order.modo);
        if (designatedPort !== port) continue; // não é desta porta, ignorar

        // Procurar outra porta disponível que suporte o mesmo modo
        const modoOrder = (order.modo || 'diario').toLowerCase().trim();
        let fallbackDev = null;
        let fallbackPort = null;

        for (const [candidatePortStr, candidateDev] of Object.entries(inMemoryDevices)) {
          const candidatePort = Number(candidatePortStr);
          if (candidatePort === port) continue; // não usar a porta esgotada
          if (!isDeviceApto(candidateDev)) continue; // deve estar apto

          // Verificar se a porta candidata é compatível com o modo do pedido
          const candidateDesignated = getPortForModo(modoOrder);
          // Aceitar apenas se o candidato for a porta correta para esse modo
          // Exceção: se a porta original for 8077 e não houver outra 8077, mas houver 8023 disponível e ambos forem vodacom
          // → Para pacotes diários (8023) → fallback: outra porta vodacom disponível  
          // → Para semanais/mensais (8077) → fallback: outra porta vodacom disponível
          // → Para saldo (8777) → sem fallback (porta específica)
          if (candidateDesignated === candidatePort) {
            // porta perfeita para o modo
            fallbackDev = candidateDev;
            fallbackPort = candidatePort;
            break;
          }

          // ── FALLBACK ESTRITO: manter compatibilidade de modo ──
          // Diários (8024/8025/8023) → só fallback para outras portas diárias (NUNCA 8077 nem 8777)
          // Semanais/Mensais/Ilimitados (8077) → só fallback para portas não-diárias e não-8777
          // Saldo (8777) → sem fallback
          const isOrderDaily = modoOrder === 'diario' || modoOrder === '24hrs' || modoOrder === '24h';
          const candidateIsDaily = candidatePort !== 8077 && candidatePort !== 8777;
          if (modoOrder !== 'saldo' && modoOrder !== 'credito' && candidatePort !== 8777) {
            // Pedido diário → candidato deve ser porta diária (não 8077)
            if (isOrderDaily && !candidateIsDaily) continue; // ← BLOQUEAR 8077 para pedidos diários
            // Pedido semanal/mensal → candidato deve ser porta não-diária (8077 ou similar)
            if (!isOrderDaily && candidateIsDaily && candidatePort !== port) {
              // aceitar só se não houver opção 8077 apta (já verificado acima)
            }
            if (!fallbackDev) {
              fallbackDev = candidateDev;
              fallbackPort = candidatePort;
            }
          }
        }

        if (fallbackDev && fallbackPort) {
          // Redirecionar pedido para a porta de fallback
          const rawQty = order.quantidade || 0;
          const volStr = rawQty < 1024 ? `${rawQty} MB` : `${(rawQty / 1024).toFixed(1)} GB`;
          const horaAgora = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

          order.status = 'assigned';
          order.targetPort = fallbackPort;
          order.assignedToPort = fallbackPort;
          order.originalPort = port;
          order.redirected = true;
          order.processingAt = new Date().toISOString();

          fallbackDev.pending_order = {
            id: order.orderId || order.id,
            orderId: order.orderId || order.id,
            numero: order.numero,
            quantidade: order.quantidade,
            modo: order.modo || 'diario',
            input_val: order.input_val || '',
            jid: order.jid || null,
            timestamp: Date.now()
          };

          console.log(`🔀 [REDIRECIONAMENTO] Pedido ${orderId} redirecionado: Porta ${port} (cheia/sem saldo) → Porta ${fallbackPort} (apta)`);

          // Notificar o grupo de notificações sobre o redirecionamento
          if (baileysEngine && typeof baileysEngine.enviarNotificacaoGrupo === 'function') {
            baileysEngine.enviarNotificacaoGrupo(
              `🔀 *REDIRECIONAMENTO AUTOMÁTICO DE PEDIDO*\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `📋 *Ref:* \`${orderId}\`\n` +
              `📲 *Destino:* *${order.numero}*\n` +
              `📦 *Volume:* *${volStr}*\n` +
              `⚠️ *Porta Original:* Celular ${port} (Sem saldo / Limite atingido)\n` +
              `✅ *Redirecionado Para:* Celular ${fallbackPort} (Disponível)\n` +
              `🕒 *Hora:* ${horaAgora}\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `♻️ O pedido será processado automaticamente pelo celular alternativo.`
            );
          }
          break; // só redirecionar 1 por vez
        } else {
          // Nenhuma porta disponível para este modo — avisar grupo (1x por pedido)
          if (!order._noFallbackNotified) {
            order._noFallbackNotified = true;
            const rawQty = order.quantidade || 0;
            const volStr = rawQty < 1024 ? `${rawQty} MB` : `${(rawQty / 1024).toFixed(1)} GB`;
            const horaAgora = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });
            if (baileysEngine && typeof baileysEngine.enviarErroGrupo === 'function') {
              baileysEngine.enviarErroGrupo(
                `🚨 *PEDIDO EM ESPERA — SEM CELULAR DISPONÍVEL* 🚨\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📋 *Ref:* \`${orderId}\`\n` +
                `📲 *Destino:* *${order.numero}*\n` +
                `📦 *Volume:* *${volStr}*\n` +
                `🔌 *Porta Necessária:* Celular ${port}\n` +
                `🕒 *Hora:* ${horaAgora}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `⚠️ Todos os celulares disponíveis para este tipo de pacote estão sem saldo ou atingiram o limite.\n` +
                `💡 *Solução:* Abra o *Slim SIM Card* para zerar os contadores ou troque os cartões.`
              );
            }
            console.log(`⚠️ [SEM FALLBACK] Pedido ${orderId} (${volStr}) em espera — nenhum celular disponível para Porta ${port}.`);
          }
          break;
        }
      }
    }
  }

  const now = Date.now();
  const lastSeen = new Date(dev.lastSeen || 0).getTime();
  const isOnline = (now - lastSeen) < 180000; // 3 min window

  const pendingCmds = dev.pending_commands || {};
  dev.pending_commands = null; // consumido

  let pendingSms = null;
  if ((port === 8077 || port === 8090 || dev.tipo === 'sms_dedicated' || dev.tipo === 'sms_and_ussd') && smsSalesEngine && typeof smsSalesEngine.getNextPendingSms === 'function') {
    pendingSms = smsSalesEngine.getNextPendingSms();
  }

  return res.json({
    status: isOnline ? 'ok' : 'offline',
    online: isOnline,
    pending_sms: pendingSms,
    ...pendingCmds,
    ...dev
  });
});

app.post(['/api/devices/:port/status', '/api/devices/:port/heartbeat'], (req, res) => {
  const port = Number(req.params.port);
  const currentDev = inMemoryDevices[port] || {};

  // Preservar pending_order existente se o heartbeat não enviou pending_order explicitamente
  let pendingOrder = currentDev.pending_order;
  if ('pending_order' in req.body) {
    pendingOrder = req.body.pending_order;
  }

  // ── FIX SALDO NULL: Nunca sobrescrever saldo conhecido com null/undefined ──
  // O app Android envia null quando o saldo ainda não foi consultado via USSD.
  // Preservar o último saldo real para não confundir o roteador de pedidos.
  const bodyClean = { ...req.body };
  const saldoFields = ['sim1_saldo_mb', 'sim2_saldo_mb', 'saldo_mb'];
  for (const field of saldoFields) {
    if (field in bodyClean && (bodyClean[field] === null || bodyClean[field] === undefined || bodyClean[field] < 0)) {
      // Manter o valor anterior se existir; caso contrário remover para não poluir
      if (currentDev[field] !== null && currentDev[field] !== undefined && currentDev[field] >= 0) {
        bodyClean[field] = currentDev[field]; // preservar saldo real anterior
      } else {
        delete bodyClean[field]; // nunca havia saldo, não definir
      }
    }
  }

  // Se o operador definiu o saldo manualmente pelo painel nos últimos 5 minutos,
  // não deixar o celular sobrescrever com saldo menor/sem_saldo antes que o novo saldo seja aplicado
  const isManualOverride = currentDev.manual_saldo_override && (Date.now() - currentDev.manual_saldo_override < 300000);
  if (isManualOverride) {
    if (bodyClean.sim1_saldo_mb !== undefined && bodyClean.sim1_saldo_mb < 100 && (currentDev.sim1_saldo_mb || 0) >= 100) {
      bodyClean.sim1_saldo_mb = currentDev.sim1_saldo_mb;
      bodyClean.saldo_mb = currentDev.saldo_mb;
      bodyClean.sem_saldo = false;
      bodyClean.is_apto = true;
      bodyClean.livre = true;
    }
  }

  // Auto-expirar currentOrder preso por mais de 10 min
  if (currentDev.currentOrder && currentDev.currentOrder.timestamp) {
    if (Date.now() - Number(currentDev.currentOrder.timestamp) > 10 * 60 * 1000) {
      currentDev.currentOrder = null;
      currentDev.isBusy = false;
    }
  }
  if (req.body.last_result) {
    currentDev.currentOrder = null;
    currentDev.isBusy = false;
    pendingOrder = null;
  }

  inMemoryDevices[port] = {
    ...currentDev,
    ...bodyClean,
    porta: port,
    pending_order: pendingOrder,
    lastSeen: new Date().toISOString()
  };

  // ── FIX PEDIDOS FANTASMA: TTL de 10 min para pedidos presos em 'assigned'/'processing' ──
  // Se o celular pegou o pedido mas nunca reportou resultado (crash, offline, etc.),
  // o pedido fica travado. Após 10 min sem resultado, volta automaticamente para 'pending'.
  const PROCESSING_TTL_MS = 10 * 60 * 1000; // 10 minutos
  for (const [orderId, order] of inMemoryOrders.entries()) {
    if ((order.status === 'assigned' || order.status === 'processing') &&
        order.assignedToPort === port && order.processingAt) {
      const processingAge = Date.now() - new Date(order.processingAt).getTime();
      if (processingAge > PROCESSING_TTL_MS) {
        order.status = 'pending';
        order.assignedToPort = null;
        order.processingAt = null;
        order.targetPort = null;
        order.lastError = `Timeout: celular porta ${port} não reportou resultado em ${Math.round(processingAge/60000)}min`;
        order.retryCount = (order.retryCount || 0) + 1;
        order.notified = false;
        order.groupNotified = false;
        saveOrdersToCache();
        console.warn(`⏰ [TIMEOUT PEDIDO] Pedido ${orderId} estava em ${order.status} na Porta ${port} há ${Math.round(processingAge/60000)}min sem resultado. Devolvido à fila.`);
      }
    }
  }

  // Notificar cliente no WhatsApp assim que o celular finalizar o envio USSD
  // Notificar cliente no WhatsApp e grupos assim que o celular finalizar o envio USSD
  if (req.body.last_result && req.body.last_result.id) {
    const resId = req.body.last_result.id;
    const order = inMemoryOrders.get(resId);
    const success = !!req.body.last_result.success;
    const targetNum = (order && order.numero) || req.body.last_result.numero || 'N/A';
    const rawQty = (order && order.quantidade) || req.body.last_result.quantidade || 1024;
    const volStr = rawQty < 1024 ? `${rawQty} MB` : `${rawQty / 1024} GB`;
    const horaAgora = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

    // Resolver JID do cliente com máxima resiliência (do pedido em cache, do body ou do histórico Baileys)
    let clientJid = (order && order.jid) || req.body.last_result.jid || null;
    if (!clientJid && resId && baileysEngine && typeof baileysEngine.getJidForOrder === 'function') {
      clientJid = baileysEngine.getJidForOrder(resId);
    }

    if (clientJid && (!order || !order.notified) && baileysEngine) {
      if (order) order.notified = true;
      if (success) {
        if (order && order.isSplit && order.splitPart === 1) {
          baileysEngine.sendTextMessage(clientJid,
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  ✅ *1ª PARTE ENTREGUE COM SUCESSO!* (1/2) 📶\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `📲 *Destino:* *${targetNum}*\n` +
            `📦 *Transferido agora:* *${volStr}* (1ª parte)\n` +
            `🔖 *Ref:* \`${resId}\`\n\n` +
            `⚡ *A 1ª parte já está na sua conta!*\n` +
            `⏳ *A enviar a 2ª parte de ${order.splitOtherPartMb} MB por outra linha disponível...*\n\n` +
            `📞 *Suporte / Dúvidas:* Envie *Suporte*`
          );
          console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} notificado de SUCESSO na Parte 1 do pedido ${resId}`);
        } else if (order && order.isSplit && order.splitPart === 2) {
          baileysEngine.sendTextMessage(clientJid,
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  🎉 *PACOTE 100% CONCLUÍDO!* (2/2) 📶\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `📲 *Destino:* *${targetNum}*\n` +
            `📦 *2ª Parte entregue:* *${volStr}*\n` +
            `✨ *Total recebido:* *${order.splitTotalMb} MB*\n` +
            `🔖 *Ref:* \`${resId}\`\n\n` +
            `⚡ *Todas as partes do seu pacote foram entregues com sucesso e já estão prontas para uso!*\n` +
            `_Obrigado pela preferência e confiança no nosso serviço!_ 🙏\n\n` +
            `📞 *Suporte / Dúvidas:* Envie *Suporte*`
          );
          console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} notificado de CONCLUSÃO TOTAL (Parte 2) do pedido ${resId}`);
        } else {
          const modoStr = String((order && order.modo) || req.body.last_result.modo || 'diario').toLowerCase().trim();
          let headerText = 'PACOTE ATIVADO COM SUCESSO! 📶';
          let modoBadge = '';
          let duracaoText = 'A sua recarga já está pronta para uso!';

          if (modoStr === 'semanal') {
            headerText = 'PACOTE SEMANAL ATIVADO! 🗓️';
            modoBadge = ' (Semanal - 7 Dias)';
            duracaoText = 'O seu pacote Semanal de 7 Dias já está ativo e pronto para uso!';
          } else if (modoStr === 'mensal') {
            headerText = 'PACOTE MENSAL ATIVADO! 📅';
            modoBadge = ' (Mensal - 30 Dias)';
            duracaoText = 'O seu pacote Mensal de 30 Dias já está ativo e pronto para uso!';
          } else if (modoStr === 'tudo_top' || modoStr === 'ilimitado') {
            headerText = 'PACOTE TUDO TOP ATIVADO! 💎';
            modoBadge = ' (Tudo Top / Ilimitado)';
            duracaoText = 'O seu pacote Tudo Top já está ativo e pronto para uso!';
          }

          baileysEngine.sendTextMessage(clientJid,
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  🎉 *${headerText}*\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `📲 *Destino:* *${targetNum}*\n` +
            `📦 *Volume:* *${volStr}*${modoBadge}\n` +
            `🔖 *Ref:* \`${resId}\`\n\n` +
            `⚡ *${duracaoText}*\n` +
            `_Obrigado pela preferência e confiança no nosso serviço!_ 🙏\n\n` +
            `📞 *Suporte / Dúvidas:* Envie *Suporte*`
          );
          console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} notificado de SUCESSO (${modoStr}) no pedido ${resId}`);
        }
      } else {
        baileysEngine.sendTextMessage(clientJid,
          `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
          `  ⚠️ *AVISO DE ENVIO DE DADOS* ⚠️\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
          `📲 *Destino:* *${targetNum}*\n` +
          `📦 *Volume:* *${volStr}*\n\n` +
          `Detectamos uma instabilidade temporária na rede da operadora ao processar a recarga.\n` +
          `⚡ O sistema tentará reenviar automaticamente em instantes!\n\n` +
          `📞 Caso precise de assistência imediata, envie *Suporte*!`
        );
        console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} notificado de FALHA no pedido ${resId}`);
      }
    }

    // ── NOTIFICAÇÕES PARA OS GRUPOS DO SISTEMA (Anti-duplicação) ──
    if (order) {
      const isParcial = !!req.body.last_result.parcial;
      const qtdEntregue = Number(req.body.last_result.quantidade) || 0;
      const qtdPedida = Number(req.body.last_result.quantidade_solicitada) || Number(order.quantidade) || 0;

      if (success) {
        order.status = 'completed';
        order.completedAt = new Date().toISOString();
        order.lastError = null;
        console.log(`🎉 [PEDIDO SUCESSO] Pedido ${resId} concluído com sucesso pelo Celular Porta ${port}!`);

        if (smsSalesEngine) {
          smsSalesEngine.notifyOrderCompleted(order);
        }

        // Se este pedido foi a Parte 1 de uma divisão inteligente, liberar a Parte 2 na fila
        if (order.isSplit && order.splitPart === 1 && order.part2Id) {
          const part2Order = inMemoryOrders.get(order.part2Id);
          if (part2Order && part2Order.status === 'waiting_part1') {
            part2Order.status = 'pending';
            part2Order.updatedAt = new Date().toISOString();
            console.log(`🚀 [PARTE 2 LIBERADA] Parte 2 (${part2Order.id} - ${part2Order.quantidade}MB) liberada para envio imediato por outra porta!`);
          }
        }
      } else if (isParcial && qtdEntregue > 0 && qtdPedida > qtdEntregue) {
        // 💡 ENVIO PARCIAL CONCLUÍDO NO CELULAR: A primeira parte foi entregue!
        const restanteMb = qtdPedida - qtdEntregue;
        order.status = 'completed';
        order.quantidade = qtdEntregue;
        order.completedAt = new Date().toISOString();
        order.lastError = `Parcial entregue: ${qtdEntregue}MB de ${qtdPedida}MB`;

        if (smsSalesEngine) {
          smsSalesEngine.notifyOrderCompleted(order);
        }

        // Criar uma nova ordem pendente para o restante dos Megas ser atendido por outra porta
        const restanteId = `${resId}-RESTANTE`;
        const orderRestante = {
          id: restanteId,
          orderId: restanteId,
          parentOrderId: resId,
          numero: order.numero,
          quantidade: restanteMb,
          modo: order.modo || 'diario',
          input_val: '', // ⚠️ Limpar input_val para que envie estritamente a diferença restante (restanteMb)
          jid: order.jid || null,
          remetente: order.remetente || 'Bot',
          targetPort: null,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          notified: false,
          groupNotified: false
        };
        inMemoryOrders.set(restanteId, orderRestante);
        console.log(`🔀 [ENVIO PARCIAL REGISTADO] Pedido ${resId} entregou ${qtdEntregue}MB. Criado pedido ${restanteId} de ${restanteMb}MB na fila para conclusão!`);
      } else {
        const errorMsg = (req.body.last_result && req.body.last_result.error) || 'Falha USSD / Timeout';
        order.lastError = errorMsg;
        order.retryCount = (order.retryCount || 0) + 1;
        order.failedPorts = order.failedPorts || [];
        if (!order.failedPorts.includes(port)) order.failedPorts.push(port);

        // 🛡️ PROTEÇÃO ANTI-DUPLICAÇÃO FINANCEIRA:
        // Apenas repassar para outra porta se o celular reportou que NÃO TINHA SALDO ou limite atingido.
        // NUNCA fazer reenvio automático se o celular chegou a discar USSD e deu timeout ou falha de leitura,
        // pois a Vodacom frequentemente conclui o envio mesmo com timeout! Reenvio só manual pelo operador.
        const errorLower = errorMsg.toLowerCase();
        const isSaldoError = errorLower.includes('saldo') || errorLower.includes('limite') || errorLower.includes('inapto') || errorLower.includes('insuficiente');

        if (isSaldoError && order.retryCount < 3) {
          order.status = 'pending';
          order.assignedToPort = null;
          order.processingAt = null;
          order.targetPort = null;
          order.notified = false;
          order.groupNotified = false;
          console.log(`🔄 [FAILOVER SALDO] Celular ${port} sem saldo para ${resId}. Repassando para porta com saldo (Tentativa #${order.retryCount})`);
        } else {
          order.status = 'failed';
          order.completedAt = new Date().toISOString();
          console.warn(`🛑 [PROTEÇÃO ANTI-REPETIÇÃO] Pedido ${resId} marcado como falhado (${errorMsg}) para evitar repetição acidental de saldo. Reenvio apenas se o operador solicitar no painel.`);

          // Se a Parte 1 falhou, cancelar a Parte 2
          if (order.isSplit && order.splitPart === 1 && order.part2Id) {
            const part2Order = inMemoryOrders.get(order.part2Id);
            if (part2Order && part2Order.status === 'waiting_part1') {
              part2Order.status = 'cancelled';
              part2Order.completedAt = new Date().toISOString();
              part2Order.lastError = 'Cancelado devido a falha na Parte 1';
              console.warn(`🛑 [PARTE 2 CANCELADA] Parte 2 ${part2Order.id} cancelada devido à falha da Parte 1.`);
            }
          }
        }
      }
      saveOrdersToCache();

      if (db) {
        const orderIdToSave = order.orderId || order.id || resId;
        const valToSave = Number(order.valor || order.valor_pago) || getValorFromMb(order.quantidade, order.modo);
        db.collection('orders').doc(orderIdToSave).set({
          ...order,
          status: order.status,
          completedAt: order.completedAt || null,
          assignedToPort: port,
          valor: valToSave,
          valor_pago: valToSave,
          updatedAt: new Date().toISOString()
        }, { merge: true }).catch(e => {
          console.warn('⚠️ [FIREBASE] Erro ao sincronizar status do pedido no Firestore:', e.message);
        });
      }
    }

    const jaNotificadoGrupo = !!(order && order.groupNotified);
    if (baileysEngine && !jaNotificadoGrupo) {
      if (order) order.groupNotified = true;
      if (success) {
        if (typeof baileysEngine.enviarNotificacaoGrupo === 'function') {
          if (order && order.isSplit && order.splitPart === 1) {
            baileysEngine.enviarNotificacaoGrupo(
              `✅ *1ª PARTE ENTREGUE (1/2)* 📦\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `📋 *Ref:* \`${resId}\`\n` +
              `📲 *Destino:* *${targetNum}*\n` +
              `📦 *Volume:* *${volStr}* (Total: ${order.splitTotalMb} MB)\n` +
              `🔌 *Porta:* Celular ${port}\n` +
              `🕒 *Hora:* ${horaAgora}\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `⏳ *Status:* 1ª parte entregue! 2ª parte (${order.splitOtherPartMb} MB) liberada para envio imediato.`
            );
          } else if (order && order.isSplit && order.splitPart === 2) {
            baileysEngine.enviarNotificacaoGrupo(
              `🎉 *PACOTE 100% CONCLUÍDO (2/2)* 📦\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `📋 *Ref:* \`${resId}\`\n` +
              `📲 *Destino:* *${targetNum}*\n` +
              `📦 *Volume:* *${volStr}* (Total: ${order.splitTotalMb} MB)\n` +
              `🔌 *Porta:* Celular ${port}\n` +
              `🕒 *Hora:* ${horaAgora}\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `✨ *Status:* Pedido dividido totalmente finalizado com sucesso!`
            );
          } else {
            baileysEngine.enviarNotificacaoGrupo(
              `✅ *PACOTE ATIVADO COM SUCESSO!* 🎉\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `📋 *Ref:* \`${resId}\`\n` +
              `📲 *Destino:* *${targetNum}*\n` +
              `📦 *Volume:* *${volStr}*\n` +
              `🔌 *Porta:* Celular ${port}\n` +
              `🕒 *Hora:* ${horaAgora}\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `✨ *Status:* Concluído e confirmado pela operadora`
            );
          }
        }
      } else {
        if (typeof baileysEngine.enviarErroGrupo === 'function') {
          const errMsg = (req.body.last_result && (req.body.last_result.error || req.body.last_result.message)) || 'Falha no disparo USSD';
          baileysEngine.enviarErroGrupo(
            `🚨 *ERRO DETECTADO [NORMAL]* 🚨\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📋 *Referência:* \`${resId}\`\n` +
            `📞 *Número:* *${targetNum}*\n` +
            `📊 *Tipo:* ${(order && order.modo) || 'diario'}${order && order.isSplit ? ` (Parte ${order.splitPart}/2)` : ''}\n` +
            `🔌 *Porta:* Celular ${port}\n` +
            `📦 *Volume:* ${volStr}\n` +
            `🕒 *Data/Hora:* ${horaAgora}\n` +
            `❌ *Erro:* ${errMsg}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ *Status:* Aguardando verificação / intervenção manual`
          );
        }
      }
    }
  }

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
  const isPortDaily = isDailyPort(port);

  for (const [orderId, order] of inMemoryOrders.entries()) {
    if (order.status === 'pending') {
      const modo = (order.modo || 'diario').toLowerCase().trim();
      const isOrderDaily = modo === 'diario' || modo === '24hrs' || modo === '24h';

      // 🛑 REGRA ESTRITA: Porta 8077 NUNCA pode pegar pedidos diários!
      if (port === 8077 && isOrderDaily) continue;
      // 🛑 REGRA ESTRITA: Portas diárias NUNCA podem pegar pedidos semanais, mensais ou saldo!
      if (isPortDaily && !isOrderDaily) continue;

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
    if (success) {
      order.status = 'completed';
      order.resultMessage = mensagem || '';
      order.completedAt = new Date().toISOString();
      order.lastError = null;
    } else {
      order.retryCount = (order.retryCount || 0) + 1;
      order.failedPorts = order.failedPorts || [];
      if (!order.failedPorts.includes(Number(port))) order.failedPorts.push(Number(port));

      if (order.retryCount < 5) {
        order.status = 'pending';
        order.assignedToPort = null;
        order.processingAt = null;
        order.targetPort = null;
        order.lastError = mensagem || 'Falha USSD / Timeout';
        console.log(`🔄 [APP RESULT RETRY] Pedido ${orderId} falhou no Celular ${port} (${order.lastError}). Devolvido à fila como PENDENTE para outro cartão/porta (Tentativa #${order.retryCount})`);
      } else {
        order.status = 'failed';
        order.resultMessage = mensagem || '';
        order.completedAt = new Date().toISOString();
        console.warn(`🛑 [APP RESULT ESGOTADO] Pedido ${orderId} atingiu 5 tentativas e falhou definitivamente.`);
      }
    }
    saveOrdersToCache();
  }

  if (db) {
    db.collection('orders').doc(orderId).set({
      status: order ? order.status : (success ? 'completed' : 'failed'),
      resultMessage: mensagem || '',
      completedAt: (order && order.completedAt) || (success ? new Date().toISOString() : null),
      retryCount: (order && order.retryCount) || 0
    }, { merge: true }).catch(() => {});
  }

  console.log(`📲 [APP RESULT] Pedido ${orderId} finalizado pelo Celular ${port}: ${success ? 'SUCESSO' : 'FALHA'}`);
  return res.json({ success: true });
});

// ── PERSISTÊNCIA DE PEDIDOS EM CACHE LOCAL ──
const ORDERS_CACHE_FILE = path.resolve(__dirname, 'orders_cache.json');

function saveOrdersToCache() {
  try {
    const list = Array.from(inMemoryOrders.entries()).slice(-100);
    fs.writeFileSync(ORDERS_CACHE_FILE, JSON.stringify(list), 'utf8');
  } catch(e) {}
}

function loadOrdersFromCache() {
  try {
    if (fs.existsSync(ORDERS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ORDERS_CACHE_FILE, 'utf8'));
      if (Array.isArray(data)) {
        data.forEach(([k, v]) => inMemoryOrders.set(k, v));
        console.log(`📦 [CACHE PEDIDOS] ${inMemoryOrders.size} pedidos restaurados do histórico.`);
      }
    }
  } catch(e) {}
}

loadOrdersFromCache();

// ── ENDPOINTS DE FILA PARA O PAINEL CLOUD ──
app.get('/api/orders', (req, res) => {
  const showAll = req.query.all === 'true';
  const now = Date.now();

  const allOrders = Array.from(inMemoryOrders.entries()).map(([id, o]) => {
    const createdMs = o.createdAt ? new Date(o.createdAt).getTime() : 0;
    const processingMs = o.processingAt ? new Date(o.processingAt).getTime() : 0;
    const ageSeconds = createdMs ? Math.round((now - createdMs) / 1000) : null;
    const processingSeconds = processingMs ? Math.round((now - processingMs) / 1000) : null;
    const mbVal = Number(o.quantidade) || 0;
    const volStr = mbVal < 1024 ? `${mbVal}MB` : `${(mbVal/1024).toFixed(1)}GB`;

    // Detectar pedidos potencialmente fantasmas (assigned há mais de 5 min sem resultado)
    const isPhantom = (o.status === 'assigned' || o.status === 'processing') &&
                      processingSeconds !== null && processingSeconds > 300;

    return {
      id,
      ref: id,
      numero: o.numero || '?',
      volume: volStr,
      quantidade: mbVal,
      modo: o.modo || 'diario',
      status: o.status,
      porta: o.assignedToPort || o.targetPort || null,
      tentativas: o.retryCount || 0,
      erro: o.lastError || null,
      criado_ha: ageSeconds !== null ? `${Math.floor(ageSeconds/60)}m${ageSeconds%60}s` : null,
      processando_ha: processingSeconds !== null ? `${Math.floor(processingSeconds/60)}m${processingSeconds%60}s` : null,
      fantasma: isPhantom,
      createdAt: o.createdAt || null,
      completedAt: o.completedAt || null,
      isSplit: o.isSplit || false,
      splitPart: o.splitPart || null
    };
  });

  // Separar por grupo de status
  const active    = allOrders.filter(o => o.status === 'assigned' || o.status === 'processing');
  const pending   = allOrders.filter(o => o.status === 'pending');
  const waiting   = allOrders.filter(o => o.status === 'waiting_part1');
  const completed = allOrders.filter(o => o.status === 'completed').sort((a,b) => new Date(b.completedAt||0) - new Date(a.completedAt||0)).slice(0, 20);
  const failed    = allOrders.filter(o => o.status === 'failed').sort((a,b) => new Date(b.completedAt||0) - new Date(a.completedAt||0)).slice(0, 10);
  const expired   = allOrders.filter(o => o.status === 'expired' || o.status === 'cancelled');
  const phantoms  = active.filter(o => o.fantasma);

  const summary = {
    total: allOrders.length,
    activos: active.length,
    pendentes: pending.length,
    aguardando: waiting.length,
    concluidos: completed.length,
    falhados: failed.length,
    expirados: expired.length,
    fantasmas: phantoms.length
  };

  if (showAll) {
    return res.json({ success: true, summary, orders: allOrders, active, pending, waiting, completed, failed, expired, phantoms });
  }

  // Por defeito: mostrar ativos, pendentes, aguardando e falhados
  const displayOrders = [...active, ...pending, ...waiting, ...failed.slice(0, 10)];
  return res.json({
    success: true,
    summary,
    orders: displayOrders,
    all_orders: allOrders,
    active,      // Em processamento agora
    pending,     // À espera de celular
    waiting,     // À espera da parte 1 (split)
    completed: completed.slice(0, 10),
    failed: failed.slice(0, 10),   // Últimos falhados
    phantoms     // Pedidos potencialmente travados (>5min sem resultado)
  });
});

// Repetir / Tentar de Novo um pedido que falhou ou travou
app.post('/api/orders/:orderId/retry', (req, res) => {
  const { orderId } = req.params;
  const targetPort = req.body && req.body.targetPort ? Number(req.body.targetPort) : null;
  const order = inMemoryOrders.get(orderId);

  if (!order) {
    return res.status(404).json({ success: false, mensagem: 'Pedido não encontrado na fila.' });
  }

  // Desocupar qualquer celular que estivesse com este pedido preso
  for (const dev of Object.values(inMemoryDevices)) {
    if (dev.pending_order && (dev.pending_order.id === orderId || dev.pending_order.orderId === orderId)) {
      dev.pending_order = null;
    }
  }

  order.status = 'pending';
  order.retryCount = (order.retryCount || 0) + 1;
  order.assignedToPort = null;
  order.processingAt = null;
  order.completedAt = null;
  order.lastError = null;
  if (targetPort) {
    order.targetPort = targetPort;
  }
  order.updatedAt = new Date().toISOString();

  saveOrdersToCache();
  console.log(`🔄 [PAINEL] Pedido ${orderId} re-enfileirado para reprocessamento imediato! (Tentativa #${order.retryCount})`);
  return res.json({ success: true, mensagem: `Pedido ${orderId} recolocado na fila com status PENDENTE!`, order });
});

// Cancelar pedido
app.post(['/api/orders/:orderId/cancel', '/api/orders/:orderId/cancelar'], (req, res) => {
  const { orderId } = req.params;
  const order = inMemoryOrders.get(orderId);

  if (order) {
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
  }

  // Desocupar qualquer celular
  for (const dev of Object.values(inMemoryDevices)) {
    if (dev.pending_order && (dev.pending_order.id === orderId || dev.pending_order.orderId === orderId)) {
      dev.pending_order = null;
    }
  }

  saveOrdersToCache();
  console.log(`❌ [PAINEL] Pedido ${orderId} cancelado pelo operador.`);
  return res.json({ success: true, mensagem: `Pedido ${orderId} cancelado.` });
});

app.post('/api/orders/clear', (req, res) => {
  const type = (req.body && req.body.type) || req.query.type || 'finalized';
  let cleared = 0;
  for (const [id, order] of inMemoryOrders.entries()) {
    if (type === 'all') {
      inMemoryOrders.delete(id);
      cleared++;
    } else if (type === 'failed') {
      if (order.status === 'failed' || order.status === 'cancelled' || order.status === 'expired') {
        inMemoryOrders.delete(id);
        cleared++;
      }
    } else {
      // finalized / default
      if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'expired') {
        inMemoryOrders.delete(id);
        cleared++;
      }
    }
  }
  saveOrdersToCache();
  console.log(`🧹 [PAINEL] Fila limpa (${type}): ${cleared} pedidos removidos.`);
  return res.json({ success: true, cleared, remaining: inMemoryOrders.size });
});

app.delete('/api/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  const existed = inMemoryOrders.has(orderId);
  if (existed) inMemoryOrders.delete(orderId);
  saveOrdersToCache();
  return res.json({ success: existed, message: existed ? `Pedido ${orderId} removido.` : 'Pedido não encontrado.' });
});

// ══════════════════════════════════════════════════════════════════
// 📊 KA-NET ADMIN MASTER API: RELATÓRIOS & EXTRATO DE RECEBIMENTOS
// ══════════════════════════════════════════════════════════════════

// In-Memory Payments store for M-Pesa & e-Mola receipts
const adminReceiptsHistory = [];
const PAYMENTS_CACHE_FILE = path.resolve(__dirname, 'payments_cache.json');

function savePaymentsToCache() {
  try {
    const keep = adminReceiptsHistory.slice(-200);
    fs.writeFileSync(PAYMENTS_CACHE_FILE, JSON.stringify(keep), 'utf8');
  } catch(e) {}
}

function loadPaymentsFromCache() {
  try {
    if (fs.existsSync(PAYMENTS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAYMENTS_CACHE_FILE, 'utf8'));
      if (Array.isArray(data)) {
        adminReceiptsHistory.push(...data);
      }
    }
  } catch(e) {}
}
loadPaymentsFromCache();

// 1. Extrato de Pagamentos Recebidos (M-Pesa / e-Mola)
app.get('/api/admin/payments', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  // Derivar também pagamentos a partir dos pedidos concluídos/processados
  const fromOrders = Array.from(inMemoryOrders.values())
    .filter(o => o.valor || o.valor_pago)
    .map(o => ({
      id: o.orderId || o.id,
      ref: o.orderId || o.id,
      operadora: (o.modo === 'saldo' || (o.numero && o.numero.startsWith('86') || o.numero && o.numero.startsWith('87'))) ? 'e-Mola' : 'M-Pesa',
      valor: Number(o.valor || o.valor_pago || 0),
      numero: o.numero || '',
      remetente: o.remetente || '',
      timestamp: o.createdAt || new Date().toISOString(),
      orderId: o.orderId || o.id,
      status: o.status === 'completed' ? 'ativado' : (o.status === 'failed' ? 'falhou' : 'processando'),
      detalhes: `${o.quantidade}MB [${o.modo || 'diario'}]`
    }));

  // Unir e ordenar do mais recente ao mais antigo
  const combined = [...adminReceiptsHistory, ...fromOrders];
  const uniqueMap = new Map();
  combined.forEach(p => {
    if (p.ref && !uniqueMap.has(p.ref)) {
      uniqueMap.set(p.ref, p);
    }
  });

  const sorted = Array.from(uniqueMap.values())
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, limit);

  const totalValor = sorted.reduce((acc, curr) => acc + (Number(curr.valor) || 0), 0);

  return res.json({
    success: true,
    total_registos: sorted.length,
    total_faturado_lista: totalValor,
    payments: sorted
  });
});

// Endpoint para registrar recebimento de SMS M-Pesa / e-Mola via Bot ou Celular
app.post('/api/admin/payments/register', (req, res) => {
  const { ref, operadora, valor, numero, remetente, status, detalhes } = req.body || {};
  if (!ref || !valor) {
    return res.status(400).json({ success: false, mensagem: 'Ref e Valor são obrigatórios.' });
  }

  const paymentDoc = {
    id: ref,
    ref,
    operadora: operadora || 'M-Pesa',
    valor: Number(valor),
    numero: numero || '',
    remetente: remetente || '',
    timestamp: new Date().toISOString(),
    status: status || 'recebido',
    detalhes: detalhes || ''
  };

  const existingIdx = adminReceiptsHistory.findIndex(p => p.ref === ref);
  if (existingIdx >= 0) {
    adminReceiptsHistory[existingIdx] = paymentDoc;
  } else {
    adminReceiptsHistory.unshift(paymentDoc);
  }
  savePaymentsToCache();

  return res.json({ success: true, payment: paymentDoc });
});

// 2. Relatórios de Vendas (Diário, Semanal, Mensal, Trimestral, Semestral, Anual)
app.get('/api/admin/reports', (req, res) => {
  const period = (req.query.period || 'today').toLowerCase(); // today, week, month, quarter, semester, year
  const now = new Date();
  
  let startTime = new Date();
  if (period === 'today' || period === 'diario') {
    startTime.setHours(0, 0, 0, 0);
  } else if (period === 'week' || period === 'semanal') {
    startTime.setDate(now.getDate() - 7);
  } else if (period === 'month' || period === 'mensal') {
    startTime.setDate(now.getDate() - 30);
  } else if (period === 'quarter' || period === 'trimestral') {
    startTime.setDate(now.getDate() - 90);
  } else if (period === 'semester' || period === 'semestral') {
    startTime.setDate(now.getDate() - 180);
  } else if (period === 'year' || period === 'anual') {
    startTime.setDate(now.getDate() - 365);
  } else {
    startTime.setHours(0, 0, 0, 0);
  }

  const startMs = startTime.getTime();
  const allOrders = Array.from(inMemoryOrders.values());

  const filteredOrders = allOrders.filter(o => {
    const t = o.createdAt ? new Date(o.createdAt).getTime() : 0;
    return t >= startMs;
  });

  const completed = filteredOrders.filter(o => o.status === 'completed');
  const failed = filteredOrders.filter(o => o.status === 'failed');
  const pending = filteredOrders.filter(o => o.status === 'pending' || o.status === 'assigned');

  const totalFaturadoMT = completed.reduce((acc, o) => acc + (Number(o.valor || o.valor_pago) || 0), 0);
  const totalVolumeMB = completed.reduce((acc, o) => acc + (Number(o.quantidade) || 0), 0);
  const totalVolumeGB = (totalVolumeMB / 1024).toFixed(1);

  // Agrupamento por pacote mais vendido
  const pacotesMap = {};
  completed.forEach(o => {
    const key = `${o.quantidade}MB [${o.modo || 'diario'}]`;
    pacotesMap[key] = (pacotesMap[key] || 0) + 1;
  });

  const pacotesMaisVendidos = Object.entries(pacotesMap)
    .map(([pacote, total]) => ({ pacote, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return res.json({
    success: true,
    periodo: period,
    data_inicio: startTime.toISOString(),
    data_fim: now.toISOString(),
    metricas: {
      total_faturado_mt: totalFaturadoMT,
      total_pedidos: filteredOrders.length,
      pedidos_concluidos: completed.length,
      pedidos_falhados: failed.length,
      pedidos_pendentes: pending.length,
      taxa_sucesso_pct: filteredOrders.length > 0 ? Math.round((completed.length / filteredOrders.length) * 100) : 100,
      total_volume_mb: totalVolumeMB,
      total_volume_gb: totalVolumeGB
    },
    pacotes_mais_vendidos: pacotesMaisVendidos,
    ultimas_vendas: completed.slice(-15).reverse()
  });
});

const ADB_DEVICE_MAP = {
  '8024': { serial: 'DWH9X17405W12389', name: 'Huawei DIG-L21 (SIM 2)', width: 720, height: 1280, defaultSim: 2 },
  '8077': { serial: 'WOZTG6X455DMXG99', name: 'Xiaomi M2006C3LG (Movitel)', width: 720, height: 1600, defaultSim: 1 },
  '8023': { serial: '192.168.43.190:5555', name: 'Huawei DIG-L21 (SIM 1)', width: 720, height: 1280, defaultSim: 1 },
  '8777': { serial: '192.168.43.192:5555', name: 'Celular 8777 (Saldo/M-Pesa)', width: 720, height: 1280, defaultSim: 1 }
};

const SCRCPY_PATHS = [
  'C:\\Users\\Kelven\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.1\\scrcpy.exe',
  'D:\\Kelven\\KaNet\\Kelven System\\scrcpy-win64-v2.4\\scrcpy.exe',
  'scrcpy'
];

function getScrcpyExecutable() {
  for (const p of SCRCPY_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return 'scrcpy';
}

function resolveDeviceConfig(portOrSerial) {
  const pStr = String(portOrSerial).trim();
  if (ADB_DEVICE_MAP[pStr]) return { port: pStr, ...ADB_DEVICE_MAP[pStr] };
  for (const [p, dev] of Object.entries(ADB_DEVICE_MAP)) {
    if (dev.serial === pStr) return { port: p, ...dev };
  }
  return { port: pStr, serial: pStr, name: `Celular (${pStr})`, width: 720, height: 1280 };
}

// 1. Listar celulares disponíveis para controle remoto
app.get('/api/remote/devices', (req, res) => {
  try {
    exec('adb devices -l', { timeout: 3000 }, (err, stdout, stderr) => {
      const lines = (!err && stdout) ? stdout.split('\n').filter(l => l.includes('device product:')) : [];
      const connectedSerials = new Set();
      lines.forEach(l => {
        const parts = l.trim().split(/\s+/);
        if (parts[0]) connectedSerials.add(parts[0]);
      });

      const devices = Object.entries(ADB_DEVICE_MAP).map(([port, dev]) => {
        const isAdbOnline = connectedSerials.has(dev.serial);
        const inMem = inMemoryDevices[port] || {};
        return {
          port: Number(port),
          name: dev.name,
          serial: dev.serial,
          width: dev.width,
          height: dev.height,
          adbOnline: isAdbOnline,
          cloudOnline: !!inMem.online,
          isApto: inMem.is_apto !== false,
          saldo_mb: inMem.saldo_mb || 0,
          activeSim: inMem.active_sim || dev.defaultSim || 1
        };
      });

      return res.json({ success: true, devices });
    });
  } catch (err) {
    const devices = Object.entries(ADB_DEVICE_MAP).map(([port, dev]) => {
      const inMem = inMemoryDevices[port] || {};
      return {
        port: Number(port),
        name: dev.name,
        serial: dev.serial,
        width: dev.width,
        height: dev.height,
        adbOnline: false,
        cloudOnline: !!inMem.online,
        isApto: inMem.is_apto !== false,
        saldo_mb: inMem.saldo_mb || 0,
        activeSim: inMem.active_sim || dev.defaultSim || 1
      };
    });
    return res.json({ success: true, devices });
  }
});

// 2. Captura de tela sob demanda (JPEG/PNG)
app.get('/api/remote/:port/screen', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);

  try {
    const adbCmd = `adb -s ${dev.serial} exec-out screencap -p`;
    exec(adbCmd, { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: 5000 }, (err, stdout, stderr) => {
      if (err || !stdout || stdout.length === 0) {
        return res.status(503).json({ success: false, mensagem: `ADB indisponível ou celular (${dev.serial}) offline.` });
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      return res.send(stdout);
    });
  } catch(err) {
    return res.status(503).json({ success: false, mensagem: `Erro ao capturar tela: ${err.message}` });
  }
});

// 3. Toque na tela (Tap)
app.post('/api/remote/:port/touch', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const { x, y, width, height } = req.body;

  if (x === undefined || y === undefined) {
    return res.status(400).json({ success: false, mensagem: 'Coordenadas (x, y) obrigatórias.' });
  }

  let realX = Math.round(x);
  let realY = Math.round(y);
  if (width && height && width > 0 && height > 0) {
    realX = Math.round((x / width) * dev.width);
    realY = Math.round((y / height) * dev.height);
  }

  try {
    exec(`adb -s ${dev.serial} shell input tap ${realX} ${realY}`, { timeout: 4000 }, (err) => {
      if (err) return res.status(500).json({ success: false, mensagem: err.message });
      return res.json({ success: true, tap: { x: realX, y: realY } });
    });
  } catch(err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// 4. Arrastar / Rolar tela (Swipe)
app.post('/api/remote/:port/swipe', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const { x1, y1, x2, y2, duration, width, height } = req.body;

  let rX1 = Math.round(x1 || 0);
  let rY1 = Math.round(y1 || 0);
  let rX2 = Math.round(x2 || 0);
  let rY2 = Math.round(y2 || 0);
  const dur = Math.max(100, Math.min(2000, Number(duration) || 300));

  if (width && height && width > 0 && height > 0) {
    rX1 = Math.round((x1 / width) * dev.width);
    rY1 = Math.round((y1 / height) * dev.height);
    rX2 = Math.round((x2 / width) * dev.width);
    rY2 = Math.round((y2 / height) * dev.height);
  }

  try {
    exec(`adb -s ${dev.serial} shell input swipe ${rX1} ${rY1} ${rX2} ${rY2} ${dur}`, { timeout: 5000 }, (err) => {
      if (err) return res.status(500).json({ success: false, mensagem: err.message });
      return res.json({ success: true, swipe: { x1: rX1, y1: rY1, x2: rX2, y2: rY2, duration: dur } });
    });
  } catch(err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// 5. Teclas de Navegação e Sistema (Keyevent)
app.post('/api/remote/:port/key', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const { key } = req.body;

  const KEY_MAP = {
    'BACK': 4,
    'HOME': 3,
    'APP_SWITCH': 187,
    'RECENTS': 187,
    'POWER': 26,
    'WAKE': 224,
    'WAKEUP': 224,
    'VOLUME_UP': 24,
    'VOLUME_DOWN': 25,
    'ENTER': 66,
    'DELETE': 67,
    'DEL': 67,
    'TAB': 61,
    'ESCAPE': 111,
    'MENU': 82,
    'NOTIFICATIONS': 'cmd statusbar expand-notifications'
  };

  const action = KEY_MAP[String(key).toUpperCase()] !== undefined ? KEY_MAP[String(key).toUpperCase()] : key;
  let cmd = `adb -s ${dev.serial} shell input keyevent ${action}`;
  if (String(action).startsWith('cmd ')) {
    cmd = `adb -s ${dev.serial} shell ${action}`;
  }

  try {
    exec(cmd, { timeout: 4000 }, (err) => {
      if (err) return res.status(500).json({ success: false, mensagem: err.message });
      return res.json({ success: true, key });
    });
  } catch(err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// 6. Digitar Texto Remotamente
app.post('/api/remote/:port/type', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const { text } = req.body;

  if (!text) return res.status(400).json({ success: false, mensagem: 'Texto não fornecido.' });

  const safeText = String(text).replace(/\s/g, '%s').replace(/["`$\\]/g, '\\$&');
  try {
    exec(`adb -s ${dev.serial} shell input text "${safeText}"`, { timeout: 4000 }, (err) => {
      if (err) return res.status(500).json({ success: false, mensagem: err.message });
      return res.json({ success: true, text });
    });
  } catch(err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// 7. Discar USSD Livre
app.post('/api/remote/:port/ussd', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const { code } = req.body;

  if (!code) return res.status(400).json({ success: false, mensagem: 'Código USSD não fornecido.' });

  const encoded = encodeURIComponent(String(code).trim());
  try {
    exec(`adb -s ${dev.serial} shell am start -a android.intent.action.CALL -d "tel:${encoded}"`, { timeout: 5000 }, (err) => {
      if (err) return res.status(500).json({ success: false, mensagem: err.message });
      return res.json({ success: true, code });
    });
  } catch(err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// 8. Iniciar Janela Nativa Scrcpy no Desktop (60 FPS com 1 clique)
app.post('/api/remote/:port/launch-scrcpy', (req, res) => {
  const { port } = req.params;
  const dev = resolveDeviceConfig(port);
  const scrcpyBin = getScrcpyExecutable();

  try {
    const child = spawn(scrcpyBin, [
      '-s', dev.serial,
      '--window-title', `📱 Ka-Net - Celular Porta ${port} (${dev.name})`,
      '--always-on-top',
      '--stay-awake'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    console.log(`🖥️ [SCRCPY] Janela nativa iniciada para Porta ${port} (${dev.serial})`);
    return res.json({ success: true, mensagem: `Janela Scrcpy 60 FPS aberta no seu computador para a Porta ${port}!` });
  } catch(e) {
    return res.status(500).json({ success: false, mensagem: `Erro ao iniciar Scrcpy: ${e.message}` });
  }
});

// ── TABELAS DE PREÇOS PARA O PAINEL ──
app.get(['/api/price-tables', '/api/prices', '/api/groups/prices'], (req, res) => {
  let cfg = {};
  if (baileysEngine && baileysEngine.DYN_CFG) {
    cfg = baileysEngine.DYN_CFG;
  } else {
    try {
      cfg = require('./bot_config.js');
    } catch (_) {}
  }
  return res.json({
    success: true,
    tabelas: cfg.TABELAS || {},
    planos_especiais: cfg.TABELAS && cfg.TABELAS.ilimitado ? cfg.TABELAS.ilimitado : (cfg.PLANOS_ESPECIAIS || {}),
    tabelas_grupo: cfg.TABELAS_GRUPO || {}
  });
});

// ── BOT STATUS PARA O PAINEL ──
app.get('/api/bot-status', (req, res) => {
  try {
    const engine = baileysEngine;
    if (engine && typeof engine.getConnectionStatus === 'function') {
      const status = engine.getConnectionStatus();
      return res.json({ success: true, ...status });
    }
    // Tentar obter estado do módulo global
    const connected = global._waConnected || false;
    const phone = global._waPhone || null;
    const qr_pending = global._qrPending || false;
    return res.json({ success: true, connected, phone, qr_pending });
  } catch(e) {
    return res.json({ success: false, connected: false, qr_pending: false, error: e.message });
  }
});
// ── RELATÓRIOS FINANCEIROS E VENDAS PARA O PAINEL ──
app.get('/api/reports', async (req, res) => {
  try {
    let all = Array.from(inMemoryOrders.values());
    if (db) {
      try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get();
        const fbOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const map = new Map();
        all.forEach(o => map.set(o.orderId || o.id, o));
        fbOrders.forEach(o => {
          const id = o.orderId || o.id;
          if (id) map.set(id, { ...(map.get(id) || {}), ...o });
        });
        all = Array.from(map.values());
      } catch(err) {
        // Firestore fallback
      }
    }

    // Garantir que todas as ordens tenham valor em MT calculado
    all.forEach(o => {
      const v = Number(o.valor || o.valor_pago);
      if (!v || isNaN(v) || v <= 0) {
        const calcVal = getValorFromMb(o.quantidade, o.modo);
        o.valor = calcVal;
        o.valor_pago = calcVal;
      } else {
        o.valor = v;
        o.valor_pago = v;
      }
    });

    // Fuso horário oficial de Moçambique (CAT / Africa/Maputo)
    function toMaputoDate(dateVal) {
      if (!dateVal) return '';
      try {
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });
      } catch(e) {
        return '';
      }
    }

    const todayStr = toMaputoDate(new Date());
    const monthStr = todayStr.slice(0, 7);

    // Vendas concluídas
    const completed = all.filter(o => o.status === 'completed' || o.success === true);

    // Vendas de hoje
    const todaySales = completed.filter(o => toMaputoDate(o.completedAt || o.createdAt) === todayStr);
    const todayTotalMt = todaySales.reduce((acc, o) => acc + (Number(o.valor_pago || o.valor) || 0), 0);
    const todayTotalMb = todaySales.reduce((acc, o) => acc + (Number(o.quantidade) || 0), 0);

    // Vendas do mês
    const monthSales = completed.filter(o => toMaputoDate(o.completedAt || o.createdAt).startsWith(monthStr));
    const monthTotalMt = monthSales.reduce((acc, o) => acc + (Number(o.valor_pago || o.valor) || 0), 0);
    const monthTotalMb = monthSales.reduce((acc, o) => acc + (Number(o.quantidade) || 0), 0);

    // Valores recebidos via SMS (M-Pesa vs e-Mola)
    const mapP = new Map();
    inMemoryPayments.forEach(p => mapP.set(p.txn_id || p.id, p));

    if (baileysEngine && baileysEngine.smsPaymentsMap) {
      for (const [k, v] of baileysEngine.smsPaymentsMap.entries()) {
        if (!mapP.has(k)) mapP.set(k, v);
      }
    }

    if (db) {
      try {
        const snapP = await db.collection('sms_payments').orderBy('processedAt', 'desc').limit(200).get();
        const fbP = snapP.docs.map(d => ({ id: d.id, ...d.data() }));
        fbP.forEach(p => {
          const tid = p.txn_id || p.id;
          if (tid) mapP.set(tid, { ...(mapP.get(tid) || {}), ...p });
        });
      } catch(err) {}
    }

    const payments = Array.from(mapP.values());
    payments.sort((a, b) => new Date(b.processedAt || b.timestamp || 0) - new Date(a.processedAt || a.timestamp || 0));

    let mpesaTotal = 0;
    let emolaTotal = 0;
    let mpesaCount = 0;
    let emolaCount = 0;
    payments.forEach(p => {
      const val = Number(p.valor) || 0;
      if (String(p.metodo || '').toLowerCase().includes('emola')) {
        emolaTotal += val;
        emolaCount++;
      } else {
        mpesaTotal += val;
        mpesaCount++;
      }
    });

    return res.json({
      success: true,
      today: {
        valor_mt: todayTotalMt,
        megas: todayTotalMb,
        total_vendas: todaySales.length
      },
      month: {
        valor_mt: monthTotalMt,
        megas: monthTotalMb,
        total_vendas: monthSales.length
      },
      recebidos: {
        mpesa_mt: mpesaTotal,
        emola_mt: emolaTotal,
        mpesa_count: mpesaCount,
        emola_count: emolaCount,
        total_mt: mpesaTotal + emolaTotal,
        total_sms: payments.length
      },
      recentSales: completed.slice(0, 50),
      allSales: all.slice(0, 100),
      recentPayments: payments.slice(0, 50)
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint para reiniciar o bot a partir do painel
app.post('/api/admin/restart-bot', (req, res) => {
  try {
    if (baileysEngine && typeof baileysEngine.startWhatsApp === 'function') {
      console.log('🔄 [ADMIN] Reinicialização manual do Bot WhatsApp solicitada pelo Painel');
      baileysEngine.startWhatsApp(null, db);
      return res.json({ success: true, mensagem: 'Bot WhatsApp a reiniciar na nuvem...' });
    }
    return res.json({ success: false, mensagem: 'Módulo WhatsApp indisponível' });
  } catch(e) {
    return res.status(500).json({ success: false, mensagem: e.message });
  }
});

// ── ENDPOINT DE TESTE: Envia mensagem de teste para JID/número ──
app.post('/api/whatsapp/test-send', async (req, res) => {
  try {
    const token = req.headers['x-master-token'] || req.query.token || req.body?.token;
    if (!MASTER_TOKENS.has(token)) return res.status(403).json({ error: 'Não autorizado' });
    
    const { jid, numero, mensagem } = req.body || {};
    const targetJid = jid || (numero ? `${String(numero).replace(/\D/g, '')}@s.whatsapp.net` : null);
    
    if (!targetJid) return res.status(400).json({ error: 'Forneça jid ou numero' });
    if (!baileysEngine || !baileysEngine.sendTextMessage) return res.status(503).json({ error: 'Bot não disponível' });
    
    await baileysEngine.sendTextMessage(targetJid, mensagem || '🤖 *Teste KA-NET* — Bot online e a responder correctamente!');
    return res.json({ success: true, jid: targetJid, mensagem: mensagem || 'Teste enviado' });
  } catch(e) {
    return res.status(500).json({ success: false, erro: e.message });
  }
});


app.get('/api/whatsapp/recent-logs', (req, res) => {
  try {
    const token = req.headers['x-master-token'] || req.query.token;
    if (!MASTER_TOKENS.has(token)) return res.status(403).json({ error: 'Não autorizado' });
    if (baileysEngine && typeof baileysEngine.getRecentLogs === 'function') {
      return res.json({ success: true, logs: baileysEngine.getRecentLogs() });
    }
    return res.json({ success: true, logs: [] });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    // 1. Carregar config do bot para metadados
    let botCfg = {};
    try {
      const cfgPath = path.resolve(__dirname, 'bot_config.js');
      if (fs.existsSync(cfgPath)) {
        delete require.cache[require.resolve(cfgPath)];
        botCfg = require(cfgPath);
      }
    } catch(e) {}

    const groupTables = botCfg.TABELAS_GRUPO || {};
    const jidNotif  = (botCfg.GRUPO_NOTIFICACOES || '120363409903708446@g.us').trim();
    const jidErros  = (botCfg.GRUPO_ERROS        || '120363408450329444@g.us').trim();

    // 2. Tentar buscar grupos ao vivo via Baileys
    let liveGroups = [];
    if (baileysEngine && typeof baileysEngine.getGroups === 'function') {
      liveGroups = await baileysEngine.getGroups();
    }

    let finalGroups = [];

    if (liveGroups && liveGroups.length > 0) {
      // Usar lista ao vivo como fonte principal
      finalGroups = liveGroups.map(g => {
        let tipo = 'Grupo de Clientes';
        if (g.jid === jidNotif)  tipo = 'Canal de Notificações';
        if (g.jid === jidErros)  tipo = 'Canal de Erros';

        return {
          jid: g.jid,
          nome: g.name || 'Grupo WhatsApp',
          autorizado: true,
          tipo,
          membros: g.participants_count || '?',
          tabela_ativa: groupTables[g.jid] ? 'Tabela Personalizada' : 'Tabela Padrão (24h / Semanal / Mensal)'
        };
      });
    } else {
      // Fallback: grupos conhecidos hardcoded quando WhatsApp está offline
      const fallback = [
        { jid: jidNotif, nome: 'Ka-Net Notificações', tipo: 'Canal de Notificações' },
        { jid: jidErros,  nome: 'Ka-Net Alertas & Erros', tipo: 'Canal de Erros' },
        { jid: '120363424819563179@g.us', nome: 'Ka-Net VIP Clientes', tipo: 'Grupo de Clientes' }
      ];
      finalGroups = fallback.map(g => ({
        ...g,
        autorizado: true,
        membros: '?',
        tabela_ativa: groupTables[g.jid] ? 'Tabela Personalizada' : 'Tabela Padrão (24h / Semanal / Mensal)'
      }));
    }

    const gruposFechados = botCfg.GRUPOS_FECHADOS || [];
    return res.json({ success: true, count: finalGroups.length, ao_vivo: liveGroups.length > 0, groups: finalGroups, gruposFechados });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// ── MANUTENÇÃO GLOBAL (fecha vendas em grupos + privado) ──
app.post('/api/maintenance', (req, res) => {
  try {
    const { ativo } = req.body;
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Campo "ativo" (boolean) é obrigatório.' });
    }
    let estado = ativo;
    if (baileysEngine && typeof baileysEngine.setModoManutencao === 'function') {
      estado = baileysEngine.setModoManutencao(ativo);
    }
    return res.json({ success: true, modoManutencao: estado, mensagem: estado ? '🛑 Sistema em manutenção — vendas bloqueadas.' : '🟢 Sistema online — vendas liberadas.' });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── FECHAR / ABRIR GRUPO ESPECÍFICO ──
app.post('/api/groups/:jid/fechar', (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    if (!jid || !jid.endsWith('@g.us')) {
      return res.status(400).json({ success: false, error: 'JID de grupo inválido.' });
    }
    let fechado = false;
    if (baileysEngine && typeof baileysEngine.toggleGrupoFechado === 'function') {
      fechado = baileysEngine.toggleGrupoFechado(jid);
    }
    return res.json({ success: true, jid, fechado, mensagem: fechado ? '🔒 Grupo fechado — bot não responde neste grupo.' : '🔓 Grupo aberto — bot volta a responder normalmente.' });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── FECHAR GRUPOS NO WHATSAPP COM MOTIVO / COMUNICADO ──
app.post('/api/admin/groups/close-with-reason', async (req, res) => {
  try {
    const { motivo, targetJids } = req.body || {};
    if (!motivo || typeof motivo !== 'string' || !motivo.trim()) {
      return res.status(400).json({ success: false, error: 'O motivo / mensagem do fecho é obrigatório.' });
    }
    if (!baileysEngine || typeof baileysEngine.closeGroupsWithReason !== 'function') {
      return res.status(503).json({ success: false, error: 'Serviço WhatsApp não está ativo.' });
    }
    const result = await baileysEngine.closeGroupsWithReason(motivo.trim(), targetJids);
    return res.json({
      success: true,
      mensagem: `${result.count} grupo(s) foram fechados no WhatsApp e o comunicado foi enviado!`,
      details: result
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── REABRIR TODOS OS GRUPOS NO WHATSAPP ──
app.post('/api/admin/groups/open-all', async (req, res) => {
  try {
    const { targetJids } = req.body || {};
    if (!baileysEngine || typeof baileysEngine.openAllGroups !== 'function') {
      return res.status(503).json({ success: false, error: 'Serviço WhatsApp não está ativo.' });
    }
    const result = await baileysEngine.openAllGroups(targetJids);
    return res.json({
      success: true,
      mensagem: `${result.count} grupo(s) foram reabertos no WhatsApp para todos os membros!`,
      details: result
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── ENVIAR COMUNICADO / ANÚNCIO AOS GRUPOS NO WHATSAPP ──
app.post('/api/admin/groups/announce', async (req, res) => {
  try {
    const { mensagem, targetJids } = req.body || {};
    if (!mensagem || typeof mensagem !== 'string' || !mensagem.trim()) {
      return res.status(400).json({ success: false, error: 'A mensagem do comunicado é obrigatória.' });
    }
    if (!baileysEngine || typeof baileysEngine.sendAnnouncementToGroups !== 'function') {
      return res.status(503).json({ success: false, error: 'Serviço WhatsApp não está ativo.' });
    }
    const result = await baileysEngine.sendAnnouncementToGroups(mensagem.trim(), targetJids);
    return res.json({
      success: true,
      mensagem: `Comunicado enviado com sucesso para ${result.count} grupo(s)!`,
      details: result
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── TABELAS DE PREÇOS DO SISTEMA ──
app.get('/api/price-tables', (req, res) => {
  try {
    let botCfg = {};
    try {
      if (fs.existsSync(path.resolve(__dirname, 'bot_config.js'))) {
        delete require.cache[require.resolve(path.resolve(__dirname, 'bot_config.js'))];
        botCfg = require(path.resolve(__dirname, 'bot_config.js'));
      }
    } catch(e) {}

    return res.json({
      success: true,
      tabelas: botCfg.TABELAS || {
        '24hrs': {
          '10': { nome: '350MB 24h', quantidade_mb: 350, valor: 10 },
          '14': { nome: '550MB 24h', quantidade_mb: 550, valor: 14 },
          '17': { nome: '696MB 24h', quantidade_mb: 696, valor: 17 },
          '22': { nome: '1GB 24h', quantidade_mb: 1024, valor: 22 },
          '44': { nome: '2GB 24h', quantidade_mb: 2048, valor: 44 }
        },
        'semanal': {
          '47': { nome: '1.7GB 7d', quantidade_mb: 1740, valor: 47 },
          '80': { nome: '2.9GB 7d', quantidade_mb: 2970, valor: 80 },
          '140': { nome: '5.3GB 7d', quantidade_mb: 5427, valor: 140 }
        },
        'mensal': {
          '95': { nome: '2.8GB 30d', quantidade_mb: 2867, valor: 95 },
          '170': { nome: '5GB 30d', quantidade_mb: 5120, valor: 170 },
          '250': { nome: '8GB 30d', quantidade_mb: 8192, valor: 250 }
        }
      },
      planos_especiais: botCfg.PLANOS_ESPECIAIS || {},
      tabelas_grupo: botCfg.TABELAS_GRUPO || {}
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
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
    
    const valPago = Number(order.valor) || Number(order.valor_pago) || getValorFromMb(order.quantidade, order.modo);
    const orderDoc = {
      ...order,
      id: order.orderId,
      valor: valPago,
      valor_pago: valPago,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // Aplicar regra oficial Ka-Net de divisão de pacotes Mensais (1ª oferta + resto diário)
    splitMensalOrderIfEligible(orderDoc);
    // Aplicar ativação de Planos Especiais (Renovável & Faseado)
    handleSpecialPlanIfApplicable(orderDoc);

    inMemoryOrders.set(order.orderId, orderDoc);
    saveOrdersToCache();

    if (db) {
      db.collection('orders').doc(order.orderId).set(orderDoc).catch(e => {
        console.warn('⚠️ [FIREBASE] Falha ao salvar ordem WhatsApp no Firestore:', e.message);
      });
    }

    // Roteamento Estrito de Portas:
    // - Portas Diárias (8025, 8023, 8024): Diários (24hrs)
    // - 8077: Semanais, Mensais e Ilimitados
    // - 8777: Saldo
    const targetPort = getPortForModo(orderDoc.modo);
    const isDiario = (orderDoc.modo || 'diario').toLowerCase().trim() === 'diario' || (orderDoc.modo || 'diario').toLowerCase().trim() === '24hrs';
    // Se for diário, NÃO travar targetPort em uma porta fixa se ela estiver offline, para que qualquer porta diária que acordar pegue
    const dev = inMemoryDevices[targetPort];
    if (isDeviceApto(dev)) {
      orderDoc.targetPort = targetPort;
      orderDoc.status = 'assigned';
      orderDoc.assignedToPort = targetPort;
      dev.pending_order = {
        id: orderDoc.id || orderDoc.orderId,
        orderId: orderDoc.id || orderDoc.orderId,
        numero: orderDoc.numero,
        quantidade: orderDoc.quantidade,
        modo: orderDoc.modo || 'diario',
        input_val: orderDoc.input_val || '',
        jid: orderDoc.jid,
        timestamp: Date.now()
      };
      console.log(`🚀 [WHATSAPP NUVEM] Ordem entregue ao Celular Apto ${targetPort} (Modo: ${orderDoc.modo || 'diario'})`);
    } else {
      orderDoc.targetPort = isDiario ? null : targetPort;
      orderDoc.status = 'pending';
      console.log(`⏳ [WHATSAPP NUVEM] Celulares para modo ${orderDoc.modo || 'diario'} ocupados ou offline. Ordem mantida como PENDENTE na fila geral para atendimento assim que uma porta ficar online.`);
    }
  }, db);
} catch(e) {
  console.warn('⚠️ [BAILEYS] Inicializando em modo standard:', e.message);
}

// ════════════════════════════════════════════════════════════════
// 7.1 SMS SALES BOT ENGINE (VENDAS E ATENDIMENTO AUTOMÁTICO VIA SMS)
// ════════════════════════════════════════════════════════════════
let smsSalesEngine = null;
try {
  smsSalesEngine = require('./sms_sales_engine');
  smsSalesEngine.setOrderDispatcher((order) => {
    console.log(`📱 [SMS NUVEM] Nova ordem recebida via SMS Bot: ${order.orderId} (${order.quantidade}MB para ${order.numero})`);
    const valPago = Number(order.valor) || Number(order.valor_pago) || getValorFromMb(order.quantidade, order.modo);
    const orderDoc = {
      ...order,
      id: order.orderId,
      valor: valPago,
      valor_pago: valPago,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    splitMensalOrderIfEligible(orderDoc);
    handleSpecialPlanIfApplicable(orderDoc);

    inMemoryOrders.set(order.orderId, orderDoc);
    saveOrdersToCache();

    if (db) {
      db.collection('orders').doc(order.orderId).set(orderDoc).catch(e => {
        console.warn('⚠️ [FIREBASE] Falha ao salvar ordem SMS no Firestore:', e.message);
      });
    }

    const targetPort = getPortForModo(orderDoc.modo);
    const isDiario = (orderDoc.modo || 'diario').toLowerCase().trim() === 'diario' || (orderDoc.modo || 'diario').toLowerCase().trim() === '24hrs';
    const dev = inMemoryDevices[targetPort];
    if (isDeviceApto(dev)) {
      orderDoc.targetPort = targetPort;
      dev.isBusy = true;
      dev.currentOrder = {
        id: orderDoc.id,
        numero: orderDoc.numero,
        quantidade: orderDoc.quantidade,
        modo: orderDoc.modo || 'diario',
        input_val: orderDoc.input_val || '',
        timestamp: Date.now()
      };
      console.log(`🚀 [SMS NUVEM] Ordem entregue ao Celular Apto ${targetPort} (Modo: ${orderDoc.modo || 'diario'})`);
    } else {
      orderDoc.targetPort = isDiario ? null : targetPort;
      orderDoc.status = 'pending';
      console.log(`⏳ [SMS NUVEM] Celulares para modo ${orderDoc.modo || 'diario'} ocupados ou offline. Ordem mantida como PENDENTE na fila geral.`);
    }
  });
  console.log('✅ [SMS ENGINE] Motor de vendas e atendimento por SMS inicializado com sucesso!');
} catch (e) {
  console.warn('⚠️ [SMS ENGINE] Falha ao carregar sms_sales_engine:', e.message);
}

// ── ROTA DO QR CODE (PÁGINA WEB PARA ESCANEAR NO CELULAR) ───
app.get('/api/whatsapp/status', (req, res) => {
  if (baileysEngine) {
    return res.json(baileysEngine.getStatus());
  }
  return res.json({ status: 'offline', hasQr: false });
});

app.post(['/api/whatsapp/reset', '/api/admin/whatsapp/reset'], async (req, res) => {
  try {
    if (baileysEngine && typeof baileysEngine.resetSession === 'function') {
      const result = await baileysEngine.resetSession(db);
      return res.json(result);
    }
    return res.status(500).json({ success: false, message: 'Baileys não inicializado' });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Alias /wa/qr → /qr (para acesso direto via browser)
app.get('/wa/qr', (req, res) => res.redirect('/qr'));

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

// ════════════════════════════════════════════════════════════════
// 8. SMS PAYMENT RECEIVER (M-Pesa / e-Mola → Auto Transfer)
// ════════════════════════════════════════════════════════════════

// Tabela de preços: valor_pago_MT → MB a enviar
const PRICE_TABLE = [
  { valor: 10,  mb: 250  },
  { valor: 15,  mb: 400  },
  { valor: 20,  mb: 600  },
  { valor: 25,  mb: 800  },
  { valor: 30,  mb: 1024 },
  { valor: 40,  mb: 1500 },
  { valor: 50,  mb: 2048 },
  { valor: 100, mb: 5120 },
  { valor: 200, mb: 10240 }
];

// Anti-duplicação: armazena txn_ids já processados (máx 1000 itens em memória)
const inMemoryPayments = new Map();

// Armazena pedidos do Client Hub aguardando confirmação real da rede (M-Pesa / e-Mola)
const hubAguardandoOperadora = new Map(); // cleanTxnId -> { orderId, orderDoc, preco, timer }

async function findOperatorPayment(cleanTxnId) {
  if (!cleanTxnId) return null;
  const tid = String(cleanTxnId).trim().toUpperCase().replace(/\.$/, '');

  // 1. Procurar em memória no server.js
  if (inMemoryPayments.has(tid)) return inMemoryPayments.get(tid);

  // 2. Procurar no baileys_engine (smsPaymentsMap)
  if (baileysEngine && baileysEngine.smsPaymentsMap && baileysEngine.smsPaymentsMap.has(tid)) {
    return baileysEngine.smsPaymentsMap.get(tid);
  }

  // 3. Procurar no Firestore sms_payments se disponível
  if (db) {
    try {
      const snap = await db.collection('sms_payments').doc(tid).get();
      if (snap.exists) return snap.data();
    } catch (_) {}
  }

  // 4. Busca flexível (prefixos ou sufixos comuns do código)
  const all = new Map();
  for (const [k, v] of inMemoryPayments.entries()) all.set(k, v);
  if (baileysEngine && baileysEngine.smsPaymentsMap) {
    for (const [k, v] of baileysEngine.smsPaymentsMap.entries()) all.set(k, v);
  }
  for (const [k, v] of all.entries()) {
    if (k.includes(tid) || tid.includes(k)) return v;
  }

  return null;
}

function getMbFromValor(valor) {
  const v = parseFloat(String(valor).replace(',', '.'));
  if (isNaN(v) || v <= 0) return null;

  // 1. Tentar ler do bot_config.js
  try {
    const cfg = require('./bot_config.js');
    const tabelas = cfg.TABELAS || {};
    const vStr = String(Math.round(v));

    if (tabelas['24hrs'] && tabelas['24hrs'][vStr]) {
      return tabelas['24hrs'][vStr].quantidade_mb || tabelas['24hrs'][vStr].quantidade;
    }
    if (tabelas['semanal'] && tabelas['semanal'][vStr]) {
      return tabelas['semanal'][vStr].quantidade_mb || tabelas['semanal'][vStr].quantidade;
    }
    if (tabelas['mensal'] && tabelas['mensal'][vStr]) {
      return tabelas['mensal'][vStr].quantidade_mb || tabelas['mensal'][vStr].quantidade;
    }
    if (tabelas['ilimitado'] && tabelas['ilimitado'][vStr]) {
      return tabelas['ilimitado'][vStr].quantidade_mb || tabelas['ilimitado'][vStr].quantidade;
    }
    if (cfg.PLANOS_ESPECIAIS && cfg.PLANOS_ESPECIAIS[vStr]) {
      return cfg.PLANOS_ESPECIAIS[vStr].quantidade_mb || cfg.PLANOS_ESPECIAIS[vStr].quantidade || 1024;
    }
  } catch (e) {}

  // 2. Fallback pela PRICE_TABLE
  const exact = PRICE_TABLE.find(p => p.valor === v);
  if (exact) return exact.mb;
  const match = [...PRICE_TABLE].reverse().find(p => p.valor <= v);
  return match ? match.mb : null;
}

function getValorFromMb(mb, modo = 'diario') {
  if (!mb || isNaN(mb) || mb <= 0) return 0;
  const numMb = Number(mb);
  const m = String(modo || 'diario').toLowerCase().trim();

  try {
    const cfg = require('./bot_config.js');
    const tabelas = cfg.TABELAS || {};
    let tab = tabelas['24hrs'];
    if (m === 'semanal') tab = tabelas['semanal'];
    else if (m === 'mensal') tab = tabelas['mensal'];
    else if (m === 'ilimitado') tab = tabelas['ilimitado'];

    if (tab) {
      for (const [valorStr, plan] of Object.entries(tab)) {
        const pMb = plan.quantidade_mb || plan.quantidade;
        if (pMb === numMb) return Number(valorStr);
      }
      let closestVal = 0;
      let closestDiff = Infinity;
      for (const [valorStr, plan] of Object.entries(tab)) {
        const pMb = plan.quantidade_mb || plan.quantidade;
        const diff = Math.abs(pMb - numMb);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestVal = Number(valorStr);
        }
      }
      if (closestVal > 0 && closestDiff <= numMb * 0.45) return closestVal;
    }
  } catch (e) {}

  const exact = PRICE_TABLE.find(p => p.mb === numMb);
  if (exact) return exact.valor;
  const match = [...PRICE_TABLE].reverse().find(p => p.mb <= numMb);
  if (match) return match.valor;

  return Math.max(10, Math.round(numMb * 0.025));
}

function findAvailablePort() {
  const now = Date.now();
  for (const [port, dev] of Object.entries(inMemoryDevices)) {
    const lastSeen = new Date(dev.lastSeen || 0).getTime();
    const isOnline = (now - lastSeen) < 180000;
    if (isOnline && !dev.pending_order) {
      return Number(port);
    }
  }
  return null;
}

app.post('/api/sms/payment', (req, res) => {
  try {
    let { txn_id, valor, remetente, metodo, raw_sms, timestamp } = req.body || {};

    if (!txn_id || !valor) {
      return res.status(400).json({
        success: false,
        mensagem: 'Campos obrigatórios: txn_id, valor'
      });
    }
    if (!remetente || String(remetente).trim() === '') {
      remetente = 'OPERADORA';
    }

    let cleanTxnId = String(txn_id || '').trim().toUpperCase();
    if (cleanTxnId.endsWith('.')) cleanTxnId = cleanTxnId.slice(0, -1);

    // Anti-fraude: verificar duplicação
    if (inMemoryPayments.has(cleanTxnId)) {
      console.warn(`⚠️ [SMS PAYMENT] Transação duplicada ignorada: ${cleanTxnId}`);
      return res.json({
        success: false,
        duplicado: true,
        mensagem: `Transação ${cleanTxnId} já foi processada`
      });
    }

    // Limpar cache se crescer demais
    if (inMemoryPayments.size > 1000) {
      const firstKey = inMemoryPayments.keys().next().value;
      inMemoryPayments.delete(firstKey);
    }

    // Guardar como processado
    const paymentDoc = {
      txn_id: cleanTxnId,
      valor: Number(valor),
      remetente: String(remetente || ''),
      metodo: metodo || 'mpesa',
      raw_sms: raw_sms || '',
      processedAt: new Date().toISOString(),
      timestamp: Number(timestamp) || Date.now()
    };

    inMemoryPayments.set(cleanTxnId, paymentDoc);

    if (db) {
      db.collection('sms_payments').doc(cleanTxnId).set(paymentDoc).catch(e => {
        console.warn('⚠️ [FIREBASE] Erro ao salvar sms_payments no Firestore:', e.message);
      });
    }

    // Validar imediatamente pedidos de clientes que estejam no status "Aguardando Comprovativo da Operadora" (WhatsApp)
    if (baileysEngine && typeof baileysEngine.registrarSmsPayment === 'function') {
      baileysEngine.registrarSmsPayment({ txn_id: cleanTxnId, valor, remetente, metodo: metodo || 'mpesa', raw_sms });
    }

    // Validar pedidos do Bot de Vendas por SMS aguardando confirmação da operadora
    if (smsSalesEngine && typeof smsSalesEngine.onOperadoraSmsPaymentReceived === 'function') {
      smsSalesEngine.onOperadoraSmsPaymentReceived({ txn_id: cleanTxnId, valor });
    }

    // Validar pedidos do Aplicativo Client Hub que estejam aguardando esta confirmação da operadora
    if (hubAguardandoOperadora.has(cleanTxnId)) {
      const item = hubAguardandoOperadora.get(cleanTxnId);
      hubAguardandoOperadora.delete(cleanTxnId);
      if (item.timer) clearTimeout(item.timer);

      const vNum = Number(valor);
      if (vNum >= (item.preco - 1)) {
        console.log(`🎉 [OPERADORA VALIDOU HUB] Pedido ${item.orderId} validado pelo SMS ${cleanTxnId} (${vNum} MT)!`);
        paymentDoc.usado = true;
        paymentDoc.usadoPor = item.orderDoc.cliente_solicitante;
        paymentDoc.usadoEm = Date.now();

        item.orderDoc.status = 'pending';
        item.orderDoc.valor_pago = vNum;
        item.orderDoc.updatedAt = new Date().toISOString();
        inMemoryOrders.set(item.orderId, item.orderDoc);
        saveOrdersToCache();

        if (db) {
          db.collection('orders').doc(item.orderId).set(item.orderDoc).catch(() => {});
        }

        clientSupportMessages.push({
          id: `MSG-NOTIF-${Date.now()}`,
          clientPhone: String(item.orderDoc.cliente_solicitante).replace(/\D/g, ''),
          clientName: 'Sistema Ka-Net',
          sender: 'admin',
          text: `🎉 Pagamento de ${vNum} MT confirmado pela rede (${metodo || 'M-Pesa'})! O seu pacote de ${item.orderDoc.quantidade}MB foi aprovado e está a ser entregue para +258 ${item.orderDoc.numero}.`,
          createdAt: new Date().toISOString(),
          read: false
        });
      } else {
        console.warn(`⚠️ [VALOR INSUFICIENTE HUB] Pedido ${item.orderId}: esperado ${item.preco} MT, recebido ${vNum} MT.`);
        item.orderDoc.status = 'failed';
        item.orderDoc.motivo = `Valor recebido (${vNum} MT) insuficiente para o pacote de ${item.preco} MT.`;
        item.orderDoc.updatedAt = new Date().toISOString();
        inMemoryOrders.set(item.orderId, item.orderDoc);
        saveOrdersToCache();
      }
    }

    // Determinar quantos MB enviar
    const mbAEnviar = getMbFromValor(valor);
    if (!mbAEnviar) {
      console.warn(`⚠️ [SMS PAYMENT] Valor ${valor} MT não corresponde a nenhum plano. Txn: ${txn_id}`);
      return res.json({
        success: false,
        mensagem: `Valor ${valor} MT não corresponde a nenhum plano disponível`,
        planos_disponiveis: PRICE_TABLE.map(p => p.valor + ' MT = ' + p.mb + ' MB')
      });
    }

    // Notificar Grupo de Notificações e aguardar que o cliente envie o comprovativo no WhatsApp com o número de destino
    const volStr = mbAEnviar < 1024 ? `${mbAEnviar} MB` : `${mbAEnviar / 1024} GB`;
    const horaAgora = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

    console.log(`💰 [SMS PAYMENT RECEBIDO] ${metodo || 'M-Pesa'} ${txn_id}: ${valor} MT (${volStr}) de ${remetente}. Aguardando cliente enviar número de destino.`);

    if (baileysEngine && typeof baileysEngine.enviarNotificacaoGrupo === 'function') {
      baileysEngine.enviarNotificacaoGrupo(
        `💰 *PAGAMENTO RECEBIDO (${(metodo || 'M-Pesa').toUpperCase()})* 💰\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *Ref / Txn:* \`${txn_id}\`\n` +
        `💳 *Valor Pago:* *${valor} MT*\n` +
        `📦 *Pacote:* *${volStr}*\n` +
        `👤 *Remetente:* *${remetente}*\n` +
        `🕒 *Hora:* ${horaAgora}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⏳ *Status:* Registado. A aguardar que o cliente envie o comprovativo com o número de destino no WhatsApp.`
      );
    }

    return res.json({
      success: true,
      txn_id,
      mb_correspondente: mbAEnviar,
      status: 'aguardando_cliente',
      mensagem: `Pagamento ${txn_id} de ${valor} MT (${volStr}) registado. A aguardar número de destino pelo cliente.`
    });
  } catch (err) {
    console.error('❌ [SMS PAYMENT ERRO]:', err);
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// Pesquisa de referências SMS (M-Pesa / e-Mola)
// GET /api/sms/payments          → lista últimos 50 (aceita ?q= para filtrar)
// GET /api/sms/payments/:txn_id  → procura por ID exacto (em memória + Firestore)
// ────────────────────────────────────────────────────────────────
app.get('/api/sms/payments', (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    // Combinar inMemoryPayments (endpoint) + smsPaymentsMap (baileys_engine)
    const allPayments = new Map();
    for (const [k, v] of inMemoryPayments.entries()) allPayments.set(k, v);
    if (baileysEngine && baileysEngine.smsPaymentsMap) {
      for (const [k, v] of baileysEngine.smsPaymentsMap.entries()) {
        if (!allPayments.has(k)) allPayments.set(k, v);
      }
    }
    let list = [...allPayments.values()];
    if (query) {
      list = list.filter(p =>
        (p.txn_id || '').toLowerCase().includes(query) ||
        (p.remetente || '').toLowerCase().includes(query) ||
        String(p.valor || '').includes(query) ||
        (p.metodo || '').toLowerCase().includes(query)
      );
    }
    // Ordenar mais recente primeiro
    list.sort((a, b) => (b.processedAt || b.timestamp || 0) > (a.processedAt || a.timestamp || 0) ? 1 : -1);
    return res.json({ success: true, count: list.length, payments: list.slice(0, 100) });
  } catch (err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// Pesquisar referência específica por txn_id
app.get('/api/sms/payments/:txn_id', async (req, res) => {
  try {
    const txnId = req.params.txn_id;
    let payment = null;

    // 1. Procurar em memória
    if (inMemoryPayments.has(txnId)) payment = inMemoryPayments.get(txnId);
    if (!payment && baileysEngine && baileysEngine.smsPaymentsMap && baileysEngine.smsPaymentsMap.has(txnId)) {
      payment = baileysEngine.smsPaymentsMap.get(txnId);
    }

    // 2. Procurar no Firestore (se disponível)
    if (!payment && db) {
      try {
        const snap = await db.collection('sms_payments').doc(txnId).get();
        if (snap.exists) payment = snap.data();
      } catch (_) {}
    }

    // 3. Pesquisa parcial (contém) nos pagamentos em memória
    let similarResults = [];
    if (!payment) {
      const all = new Map();
      for (const [k, v] of inMemoryPayments.entries()) all.set(k, v);
      if (baileysEngine && baileysEngine.smsPaymentsMap) {
        for (const [k, v] of baileysEngine.smsPaymentsMap.entries()) all.set(k, v);
      }
      similarResults = [...all.values()].filter(p =>
        (p.txn_id || '').toLowerCase().includes(txnId.toLowerCase())
      ).slice(0, 10);
    }

    if (payment) {
      return res.json({ success: true, encontrado: true, payment });
    } else if (similarResults.length > 0) {
      return res.json({ success: true, encontrado: false, similares: similarResults,
        mensagem: `Referência exacta não encontrada. ${similarResults.length} resultado(s) similar(es).` });
    } else {
      return res.status(404).json({ success: false, encontrado: false,
        mensagem: `Referência ${txnId} não encontrada em memória ou base de dados.` });
    }
  } catch (err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

// ── ADMIN: Corrigir duplicatas em TABELAS e TABELAS_GRUPO ──
app.all('/api/admin/fix-duplicates', (req, res) => {
  const token = req.headers['x-master-token'] || req.query.token;
  if (!MASTER_TOKENS.has(token)) return res.status(403).json({ error: 'Não autorizado' });

  if (baileysEngine && typeof baileysEngine.limparDuplicatasTabelas === 'function') {
    const alterado = baileysEngine.limparDuplicatasTabelas();
    if (alterado) {
      baileysEngine.salvarBotConfig();
    }
    return res.json({
      ok: true,
      alterado,
      mensagem: alterado ? 'Duplicatas removidas e salvas com sucesso!' : 'Nenhuma duplicata encontrada. Tabelas limpas.',
      timestamp: new Date().toISOString()
    });
  }

  return res.status(500).json({ ok: false, error: 'Motor Baileys não carregado' });
});

// ----------------------------------------------------
// 20. KA-NET CLIENT HUB API (APP DO CLIENTE & CRM)
// ----------------------------------------------------

// Armazenamento em memória para Clientes, Suporte e Mensagens
const clientUsers = new Map(); // phone -> { phone, name, password, pin, biometricEnabled, createdAt, lastLogin }
const clientSupportMessages = []; // { id, clientPhone, clientName, sender: 'client'|'admin', text, createdAt, read: boolean }
const clientSmsHistory = new Set(); // txn_ids já usados para evitar fraude

// Carregar clientes salvos em cache local
const CLIENTS_CACHE_FILE = path.resolve(__dirname, 'clients_store.json');
try {
  if (fs.existsSync(CLIENTS_CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CLIENTS_CACHE_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      raw.forEach(u => clientUsers.set(u.phone, u));
      console.log(`👥 [CLIENT HUB] ${clientUsers.size} clientes carregados do cache.`);
    }
  }
} catch (e) {
  console.warn('⚠️ [CLIENT HUB] Erro ao ler clients_store.json:', e.message);
}

function saveClientsStore() {
  try {
    fs.writeFileSync(CLIENTS_CACHE_FILE, JSON.stringify([...clientUsers.values()], null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ [CLIENT HUB] Erro ao salvar clients_store.json:', e.message);
  }
}

// ── 20.1 Registo / Login de Cliente ──
app.post('/api/client/auth/register', (req, res) => {
  try {
    const { phone, name, password, pin } = req.body || {};
    if (!phone || !password) {
      return res.status(400).json({ success: false, mensagem: 'Telefone e senha são obrigatórios.' });
    }
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (clientUsers.has(cleanPhone)) {
      return res.status(400).json({ success: false, mensagem: 'Este número já possui cadastro. Faça login.' });
    }
    const user = {
      phone: cleanPhone,
      name: name ? String(name).trim() : `Cliente ${cleanPhone.slice(-4)}`,
      password: String(password),
      pin: pin ? String(pin) : '1234',
      biometricEnabled: false,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    clientUsers.set(cleanPhone, user);
    saveClientsStore();

    if (db) {
      db.collection('client_users').doc(cleanPhone).set(user).catch(e => console.warn('Firebase user save err:', e.message));
    }

    return res.json({
      success: true,
      mensagem: 'Cadastro realizado com sucesso!',
      user: { phone: user.phone, name: user.name, biometricEnabled: user.biometricEnabled }
    });
  } catch (err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

app.post('/api/client/auth/login', (req, res) => {
  try {
    const { phone, password, isBiometric } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const user = clientUsers.get(cleanPhone);

    if (!user) {
      return res.status(404).json({ success: false, mensagem: 'Cliente não encontrado. Por favor registe-se.' });
    }

    if (!isBiometric && user.password !== String(password)) {
      return res.status(401).json({ success: false, mensagem: 'Senha incorreta.' });
    }

    user.lastLogin = new Date().toISOString();
    saveClientsStore();

    return res.json({
      success: true,
      mensagem: 'Login realizado com sucesso!',
      user: { phone: user.phone, name: user.name, biometricEnabled: user.biometricEnabled }
    });
  } catch (err) {
    return res.status(500).json({ success: false, mensagem: err.message });
  }
});

app.post('/api/client/auth/biometric-toggle', (req, res) => {
  const { phone, enabled } = req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const user = clientUsers.get(cleanPhone);
  if (!user) return res.status(404).json({ success: false, mensagem: 'Usuário não encontrado.' });

  user.biometricEnabled = Boolean(enabled);
  saveClientsStore();
  return res.json({ success: true, biometricEnabled: user.biometricEnabled });
});

// ── 20.2 Status do Sistema & Radar de Portas em Tempo Real ──
app.get('/api/client/system-status', (req, res) => {
  const now = Date.now();
  const devices = Object.values(inMemoryDevices).map(dev => {
    const lastSeen = new Date(dev.lastSeen || 0).getTime();
    return {
      porta: dev.porta,
      online: (now - lastSeen) < 35000,
      saldo_mb: dev.saldo_mb || 0,
      saldo_mt: dev.saldo_mt || 0,
      sem_saldo: Boolean(dev.sem_saldo),
      is_apto: isDeviceApto(dev)
    };
  });

  // Verificar Portas Diárias (8024, 8023, 8025)
  const dailyDevs = devices.filter(d => d.porta !== 8077 && d.porta !== 8777);
  const dailyOnline = dailyDevs.some(d => d.online && !d.sem_saldo);

  // Verificar Porta Especial de Ofertas com Saldo (8077)
  const special8077 = devices.find(d => d.porta === 8077);
  const specialOnline = special8077 ? (special8077.online && !special8077.sem_saldo) : false;

  return res.json({
    success: true,
    sistema_operacional: dailyOnline || specialOnline,
    diario: {
      disponivel: dailyOnline,
      mensagem: dailyOnline ? 'Pronto para envios diários 24h' : 'Portas diárias temporariamente ocupadas'
    },
    saldo_especial: {
      disponivel: specialOnline,
      mensagem: specialOnline ? 'Porta 8077 pronta para Semanal / Mensal / Tudo Top' : 'Porta 8077 aguardando reposição de crédito'
    },
    titulares: {
      mpesa: {
        numero: "856268811",
        titular: "Kelven Junior Anabela Nharrava"
      },
      emola: {
        numero: "864882152",
        titular: "Catia Anabela Nharrava"
      }
    }
  });
});

const PACKAGES_CACHE_FILE = path.join(__dirname, '..', 'cache_dynamic_packages.json');

const DEFAULT_SERVER_PACKAGES = {
  diario: [
    { preco: 9, nome: "350 MB (24h)", quantidade_mb: 350, display_size: "350 MB", periodo: "24 Horas", modo: "diario" },
    { preco: 14, nome: "550 MB (24h)", quantidade_mb: 550, display_size: "550 MB", periodo: "24 Horas", modo: "diario" },
    { preco: 17, nome: "696 MB (24h)", quantidade_mb: 696, display_size: "696 MB", periodo: "24 Horas", modo: "diario" },
    { preco: 22, nome: "1.0 GB (24h)", quantidade_mb: 1024, display_size: "1.0 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 30, nome: "1.5 GB (24h)", quantidade_mb: 1536, display_size: "1.5 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 44, nome: "2.0 GB (24h)", quantidade_mb: 2048, display_size: "2.0 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 55, nome: "2.5 GB (24h)", quantidade_mb: 2560, display_size: "2.5 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 65, nome: "3.0 GB (24h)", quantidade_mb: 3072, display_size: "3.0 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 85, nome: "4.0 GB (24h)", quantidade_mb: 4096, display_size: "4.0 GB", periodo: "24 Horas", modo: "diario" },
    { preco: 105, nome: "5.0 GB (24h)", quantidade_mb: 5120, display_size: "5.0 GB", periodo: "24 Horas", modo: "diario" }
  ],
  semanal: [
    { preco: 47, nome: "1.7 GB (7 Dias)", quantidade_mb: 1740, display_size: "1.7 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 70, nome: "2.9 GB (7 Dias)", quantidade_mb: 2969, display_size: "2.9 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 85, nome: "3.4 GB (7 Dias)", quantidade_mb: 3481, display_size: "3.4 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 130, nome: "5.3 GB (7 Dias)", quantidade_mb: 5427, display_size: "5.3 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 180, nome: "7.2 GB (7 Dias)", quantidade_mb: 7372, display_size: "7.2 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 250, nome: "10.7 GB (7 Dias)", quantidade_mb: 10956, display_size: "10.7 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 330, nome: "14.1 GB (7 Dias)", quantidade_mb: 14438, display_size: "14.1 GB", periodo: "7 Dias (Semanal)", modo: "semanal" },
    { preco: 400, nome: "17.6 GB (7 Dias)", quantidade_mb: 18022, display_size: "17.6 GB", periodo: "7 Dias (Semanal)", modo: "semanal" }
  ],
  mensal: [
    { preco: 75, nome: "2.8 GB (30 Dias)", quantidade_mb: 2867, display_size: "2.8 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 130, nome: "5.0 GB (30 Dias)", quantidade_mb: 5120, display_size: "5.0 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 215, nome: "8.5 GB (30 Dias)", quantidade_mb: 8704, display_size: "8.5 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 285, nome: "11.4 GB (30 Dias)", quantidade_mb: 11673, display_size: "11.4 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 350, nome: "14.3 GB (30 Dias)", quantidade_mb: 14643, display_size: "14.3 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 420, nome: "17.2 GB (30 Dias)", quantidade_mb: 17612, display_size: "17.2 GB", periodo: "30 Dias (Mensal)", modo: "mensal" },
    { preco: 480, nome: "20.0 GB (30 Dias)", quantidade_mb: 20480, display_size: "20.0 GB", periodo: "30 Dias (Mensal)", modo: "mensal" }
  ],
  diamante: [
    { preco: 450, nome: "11 GB + Minutos", quantidade_mb: 11264, display_size: "11 GB + Voz", periodo: "🔴 Vodacom (30 Dias)", modo: "diamante" },
    { preco: 570, nome: "15 GB + Minutos", quantidade_mb: 15360, display_size: "15 GB + Voz", periodo: "🔴 Vodacom (30 Dias)", modo: "diamante" },
    { preco: 850, nome: "25 GB + Minutos", quantidade_mb: 25600, display_size: "25 GB + Voz", periodo: "🔴 Vodacom (30 Dias)", modo: "diamante" }
  ],
  especiais: [
    { preco: 76, nome: "♻️ 3GB+700 (Renovação)", quantidade_mb: 3772, display_size: "3.7 GB", periodo: "Renovação (+100MB/dia)", modo: "renovavel" },
    { preco: 120, nome: "♻️ 5GB+700 (Renovação)", quantidade_mb: 5820, display_size: "5.8 GB", periodo: "Renovação (+100MB/dia)", modo: "renovavel" },
    { preco: 130, nome: "📉 5GB Faseado (1GB/dia)", quantidade_mb: 5120, display_size: "5.0 GB", periodo: "Diário Faseado (1GB/dia)", modo: "faseado" },
    { preco: 195, nome: "♻️ 8GB+700 (Renovação)", quantidade_mb: 8892, display_size: "8.8 GB", periodo: "Renovação (+100MB/dia)", modo: "renovavel" },
    { preco: 240, nome: "♻️ 10GB+700 (Renovação)", quantidade_mb: 10940, display_size: "10.9 GB", periodo: "Renovação (+100MB/dia)", modo: "renovavel" },
    { preco: 255, nome: "📉 10GB Faseado (1GB/dia)", quantidade_mb: 10240, display_size: "10.0 GB", periodo: "Diário Faseado (1GB/dia)", modo: "faseado" },
    { preco: 381, nome: "📉 15GB Faseado (1GB/dia)", quantidade_mb: 15360, display_size: "15.0 GB", periodo: "Diário Faseado (1GB/dia)", modo: "faseado" },
    { preco: 510, nome: "📉 20GB Faseado (1GB/dia)", quantidade_mb: 20480, display_size: "20.0 GB", periodo: "Diário Faseado (1GB/dia)", modo: "faseado" }
  ]
};

let currentDynamicPackages = { ...DEFAULT_SERVER_PACKAGES };

function loadDynamicPackages() {
  try {
    if (fs.existsSync(PACKAGES_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PACKAGES_CACHE_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        currentDynamicPackages = { ...DEFAULT_SERVER_PACKAGES, ...data };
      }
    }
  } catch(e) {
    console.warn('⚠️ Erro ao ler cache_dynamic_packages:', e.message);
  }
}
loadDynamicPackages();

function saveDynamicPackages() {
  try {
    fs.writeFileSync(PACKAGES_CACHE_FILE, JSON.stringify(currentDynamicPackages, null, 2), 'utf8');
  } catch(e) {
    console.warn('⚠️ Erro ao salvar cache_dynamic_packages:', e.message);
  }
}

// ── 20.3 Catálogo Completo de Pacotes Dinâmicos (Sincronizado com Admin & Apps) ──
app.get('/api/client/packages', (req, res) => {
  return res.json({
    success: true,
    version: Date.now(),
    packages: currentDynamicPackages
  });
});

app.get('/api/admin/packages', (req, res) => {
  return res.json({
    success: true,
    packages: currentDynamicPackages
  });
});

app.post('/api/admin/packages/save', (req, res) => {
  try {
    const { packages } = req.body || {};
    if (!packages || typeof packages !== 'object') {
      return res.status(400).json({ success: false, mensagem: 'Estrutura de pacotes inválida.' });
    }

    if (Array.isArray(packages.diario)) currentDynamicPackages.diario = packages.diario;
    if (Array.isArray(packages.semanal)) currentDynamicPackages.semanal = packages.semanal;
    if (Array.isArray(packages.mensal)) currentDynamicPackages.mensal = packages.mensal;
    if (Array.isArray(packages.diamante)) currentDynamicPackages.diamante = packages.diamante;
    if (Array.isArray(packages.especiais)) currentDynamicPackages.especiais = packages.especiais;

    currentDynamicPackages.version = Date.now();
    currentDynamicPackages.lastUpdated = new Date().toISOString();

    saveDynamicPackages();

    if (rtdb) {
      rtdb.ref('system_packages').set(currentDynamicPackages).catch(() => {});
    }

    console.log('✅ [ADMIN] Tabelas de pacotes atualizadas dinamicamente pelo Admin! Versão:', currentDynamicPackages.version);

    return res.json({
      success: true,
      mensagem: 'Tabela de pacotes atualizada com sucesso em todos os aplicativos!',
      version: currentDynamicPackages.version,
      packages: currentDynamicPackages
    });
  } catch(e) {
    return res.status(500).json({ success: false, mensagem: 'Erro ao salvar pacotes: ' + e.message });
  }
});

// ── 20.3.1 Sistema de Anúncios e Alertas para Clientes (Ka-Net Broadcast) ──
const ANNOUNCEMENT_CACHE_FILE = path.resolve(__dirname, 'cache_announcement.json');

let currentAnnouncement = {
  id: 'ANN-DEFAULT',
  title: '🔥 Bem-vindo ao Ka-Net Client Hub!',
  message: 'Recarregue pacotes de megas com ativação imediata via M-Pesa e e-Mola sem filas!',
  type: 'promo', // 'promo' | 'alert' | 'news' | 'info'
  active: false,
  sendNotification: true,
  version: Date.now(),
  lastUpdated: new Date().toISOString()
};

function loadAnnouncement() {
  try {
    if (fs.existsSync(ANNOUNCEMENT_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ANNOUNCEMENT_CACHE_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        currentAnnouncement = { ...currentAnnouncement, ...data };
      }
    }
  } catch(e) {
    console.warn('⚠️ Erro ao ler cache_announcement:', e.message);
  }
}
loadAnnouncement();

function saveAnnouncement() {
  try {
    fs.writeFileSync(ANNOUNCEMENT_CACHE_FILE, JSON.stringify(currentAnnouncement, null, 2), 'utf8');
  } catch(e) {
    console.warn('⚠️ Erro ao salvar cache_announcement:', e.message);
  }
}

// Endpoint para os clientes (Client Hub) obterem o anúncio atual
app.get('/api/client/announcement', (req, res) => {
  return res.json({
    success: true,
    announcement: currentAnnouncement
  });
});

// Endpoint Admin para ler o anúncio
app.get('/api/admin/announcement', (req, res) => {
  return res.json({
    success: true,
    announcement: currentAnnouncement
  });
});

// Endpoint Admin para salvar/publicar o anúncio
app.post('/api/admin/announcement', (req, res) => {
  try {
    const { title, message, type, active, sendNotification } = req.body || {};
    
    currentAnnouncement = {
      id: `ANN-${Date.now()}`,
      title: String(title || '').trim(),
      message: String(message || '').trim(),
      type: type || 'promo',
      active: active === true || active === 'true',
      sendNotification: sendNotification !== false && sendNotification !== 'false',
      version: Date.now(),
      lastUpdated: new Date().toISOString()
    };

    saveAnnouncement();

    if (rtdb) {
      rtdb.ref('system_announcement').set(currentAnnouncement).catch(() => {});
    }

    console.log(`📢 [ADMIN] Anúncio publicado para os clientes! Ativo: ${currentAnnouncement.active} | Título: ${currentAnnouncement.title}`);

    // Se o bot WhatsApp estiver conectado e o admin marcar para enviar notificação
    if (currentAnnouncement.active && baileysEngine && typeof baileysEngine.enviarNotificacaoGrupo === 'function') {
      const emojiType = currentAnnouncement.type === 'alert' ? '🚨' : currentAnnouncement.type === 'promo' ? '🔥' : '📢';
      baileysEngine.enviarNotificacaoGrupo(
        `${emojiType} *COMUNICADO OFICIAL KA-NET* ${emojiType}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${currentAnnouncement.title}*\n\n` +
        `${currentAnnouncement.message}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕒 ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}`
      );
    }

    return res.json({
      success: true,
      mensagem: currentAnnouncement.active 
        ? '📢 Anúncio publicado com sucesso! Todos os clientes receberão alerta no aplicativo.' 
        : 'Anúncio desativado no aplicativo dos clientes.',
      announcement: currentAnnouncement
    });
  } catch(e) {
    return res.status(500).json({ success: false, mensagem: 'Erro ao salvar anúncio: ' + e.message });
  }
});

// ── 20.4 Compra via Confirmação de SMS (M-Pesa / e-Mola) ──
// As MESMAS regras do WhatsApp: confirmações que foram REALMENTE recebidas no nosso M-Pesa ou e-Mola
app.post('/api/client/purchase', async (req, res) => {
  try {
    const { clientPhone, recipientPhone, smsText, packagePrice, packageModo, packageMb, packageName } = req.body || {};

    // ── 1. Campos obrigatórios ──
    if (!recipientPhone || !smsText || !packagePrice || !packageMb) {
      return res.status(400).json({ success: false, mensagem: 'Preencha todos os campos: número destinatário, comprovativo de pagamento e pacote escolhido.' });
    }

    const smsClean = String(smsText).trim();

    // ── 2. Validar que é um comprovativo M-Pesa / e-Mola ──
    const temIndicador = /(Confirmado|Recebeu|Recebeste|Transferiste|Transferiu|e-Mola|eMola|M-Pesa|MPesa|TxId|Transação|Transacao|ID\s*(?:da)?\s*transa|ID\s*Trans|PP2\d{5})/i.test(smsClean);
    const temValor    = /[\d.,]+\s*(?:MT|MZN|Mts?)\b/i.test(smsClean);
    if (!temIndicador || !temValor) {
      return res.status(400).json({
        success: false,
        mensagem: '❌ Texto inválido. Deve colar a mensagem de confirmação real recebida no M-Pesa ou e-Mola (com valor em MT e código de transação).'
      });
    }

    // ── 3. Extrair ID de transação ──
    function extrairTxIdLocal(texto) {
      const mExplicit = texto.match(/(?:ID\s*(?:da)?\s*transa[cç][aã]o|ID\s*Trans|TxId|Ref(?:er[eê]ncia)?)\s*[:.]?\s*([A-Z0-9]+(?:\.[A-Z0-9]+)*)/i);
      if (mExplicit && mExplicit[1] && mExplicit[1].length >= 6) return mExplicit[1].toUpperCase().replace(/\.$/, '');
      const mPP = texto.match(/\b(PP[0-9]{6}\.[0-9]{4}\.[A-Z0-9]{4,8})\b/i);
      if (mPP) return mPP[1].toUpperCase();
      const mConf = texto.match(/Confirmado\s+([A-Z0-9]{8,15})\b/i);
      if (mConf) { const c = mConf[1].toUpperCase(); if (!/^(258)?8[2-7]\d{7}$/.test(c)) return c; }
      const mAlpha = texto.match(/\b([A-Z][A-Z0-9]{9,12})\b/);
      if (mAlpha) {
        const c = mAlpha[1].toUpperCase();
        const ignorar = ['CONFIRMADO','TRANSFERISTE','RECEBESTE','NOTIFICACAO','COMPROVATIVO','AUTOMATICA'];
        if (!ignorar.includes(c) && /[0-9]/.test(c)) return c;
      }
      return 'TXN-' + Date.now();
    }

    // ── 4. Extrair valor pago no SMS ──
    function extrairValorLocal(texto) {
      const mTransf = texto.match(/Transferiste\s+([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
      if (mTransf) return parseFloat(mTransf[1].replace(',', '.'));
      const mReceb  = texto.match(/(?:Recebeste|Recebeu|Creditado|Depositado)\s+([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
      if (mReceb)  return parseFloat(mReceb[1].replace(',', '.'));
      const mValor  = texto.match(/Valor\s*[:.]?\s*([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
      if (mValor)  return parseFloat(mValor[1].replace(',', '.'));
      const mGeral  = texto.match(/([\d.,]+)\s*(?:MT|MZN|Mts?)\b/i);
      if (mGeral)  return parseFloat(mGeral[1].replace(',', '.'));
      return null;
    }

    const txnId    = extrairTxIdLocal(smsClean);
    const valorSMS = extrairValorLocal(smsClean);
    const preco    = Number(packagePrice);

    // ── 5. Verificar se o pagamento foi feito para os nossos números oficiais (M-Pesa 856268811 / e-Mola 864882152) ──
    const NOSSOS_NUMEROS = ['856268811', '864882152'];
    const destinoPagamento = NOSSOS_NUMEROS.find(n => smsClean.includes(n) || smsClean.includes('258' + n));
    if (!destinoPagamento) {
      return res.status(400).json({
        success: false,
        mensagem: `❌ Pagamento não reconhecido. O comprovativo deve mostrar transferência para uma das contas oficiais Ka-Net:\n🔴 M-Pesa: 856268811 (Kelven Junior)\n🟡 e-Mola: 864882152 (Catia Anabela)\n\nCertifique-se de que transferiu para a nossa conta correta.`
      });
    }

    // ── 6. Verificar valor compatível com o preço do pacote (tolerância ±1 MT) ──
    if (valorSMS !== null && (preco - valorSMS) > 1) {
      return res.status(400).json({
        success: false,
        mensagem: `❌ Valor insuficiente. O pacote escolhido custa ${preco} MT mas o comprovativo mostra apenas ${valorSMS} MT.`
      });
    }

    // ── 7. Verificar número destinatário de megas (Vodacom/Movitel/Tmcel) ──
    const cleanDest = String(recipientPhone).replace(/\D/g, '').slice(-9);
    if (!cleanDest.startsWith('84') && !cleanDest.startsWith('85') && !cleanDest.startsWith('86') && !cleanDest.startsWith('87') && !cleanDest.startsWith('82') && !cleanDest.startsWith('83')) {
      return res.status(400).json({ success: false, mensagem: 'Número destinatário de Moçambique inválido (deve ser Vodacom, Movitel ou Tmcel).' });
    }

    // ── 8. Anti-fraude: bloquear reutilização do mesmo comprovativo ──
    if (clientSmsHistory.has(txnId) && !txnId.startsWith('TXN-')) {
      return res.status(400).json({ success: false, mensagem: '❌ Este comprovativo/referência já foi utilizado anteriormente no sistema. Cada confirmação é válida apenas para 1 compra.' });
    }

    // ── 9. VALIDAÇÃO REAL: A CONFIRMAÇÃO FOI REALMENTE RECEBIDA NO NOSSO M-PESA OU E-MOLA? ──
    let realPay = await findOperatorPayment(txnId);

    // Se ainda não caiu no servidor, aguarda ativamente até 10 segundos (polling de 1s) para cobrir o atraso normal de rede SMS
    if (!realPay && !txnId.startsWith('TXN-')) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        realPay = await findOperatorPayment(txnId);
        if (realPay) break;
      }
    }

    const orderId = `HUB-${txnId.slice(0, 8)}-${Date.now().toString().slice(-4)}`;
    const modo    = packageModo || 'diario';
    const qtyMb   = Number(packageMb) || 1024;
    const metodo  = destinoPagamento === '864882152' ? 'emola' : 'mpesa';
    const metodoNome = metodo === 'emola' ? 'e-Mola' : 'M-Pesa';

    // CASO A: OPERADORA JÁ CONFIRMOU O RECEBIMENTO NO NOSSO TELEFONE!
    if (realPay) {
      if (realPay.usado) {
        return res.status(400).json({
          success: false,
          mensagem: '❌ Este comprovativo já foi confirmado e utilizado anteriormente por outro pedido.'
        });
      }

      const valOperadora = Number(realPay.valor) || valorSMS || preco;
      if (valOperadora < (preco - 1)) {
        return res.status(400).json({
          success: false,
          mensagem: `❌ Valor recebido pela rede (${valOperadora} MT) é menor que o preço do pacote (${preco} MT).`
        });
      }

      // Marcar SMS da operadora como usado
      realPay.usado = true;
      realPay.usadoPor = cleanDest;
      realPay.usadoEm = Date.now();
      clientSmsHistory.add(txnId);

      if (baileysEngine && typeof baileysEngine.salvarSmsPayments === 'function') {
        baileysEngine.salvarSmsPayments();
      }

      const orderDoc = {
        id: orderId,
        orderId,
        numero: cleanDest,
        cliente_solicitante: clientPhone || cleanDest,
        quantidade: qtyMb,
        valor: preco,
        valor_pago: valOperadora,
        modo,
        status: 'pending', // Despacho imediato!
        origem: 'client_hub',
        metodo,
        sms_ref: txnId,
        sms_original: smsClean.slice(0, 200),
        package_name: packageName || `${qtyMb}MB`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      splitMensalOrderIfEligible(orderDoc);
      handleSpecialPlanIfApplicable(orderDoc);

      inMemoryOrders.set(orderId, orderDoc);
      saveOrdersToCache();

      if (db) {
        db.collection('orders').doc(orderId).set(orderDoc).catch(e => console.warn('Firebase order save err:', e.message));
      }

      console.log(`🛒 [CLIENT HUB] Compra VALIDADA PELA OPERADORA: ${orderId} | ${qtyMb}MB para ${cleanDest} | ${valOperadora} MT via ${metodoNome} | Ref: ${txnId}`);

      if (baileysEngine && typeof baileysEngine.enviarNotificacaoGrupo === 'function') {
        baileysEngine.enviarNotificacaoGrupo(
          `🔔 *NOVO PEDIDO VALIDADO PELA OPERADORA (CLIENT HUB)* ⚡\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📋 *Ref:* \`${orderId}\`\n` +
          `📲 *Destino:* *${cleanDest}*\n` +
          `📦 *Pacote:* *${packageName || (qtyMb + 'MB')}* (${modo})\n` +
          `💳 *Valor:* *${valOperadora} MT* (${metodoNome})\n` +
          `👤 *Cliente:* *${clientPhone || cleanDest}*\n` +
          `🏢 *Origem:* Ka-Net Client Hub App\n` +
          `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⏳ *Status:* Confirmado pelo SMS da rede. Enviado para ativação imediata!`
        );
      }

      return res.json({
        success: true,
        status: 'confirmed',
        mensagem: `✅ Pagamento de ${valOperadora} MT confirmado oficialmente pela rede ${metodoNome}! Os seus megas estão a ser enviados imediatamente para +258 ${cleanDest}.`,
        orderId,
        destinatario: cleanDest,
        quantidade_mb: qtyMb,
        modo,
        metodo,
        txn_id: txnId
      });
    }

    // CASO B: A CONFIRMAÇÃO DA OPERADORA AINDA NÃO ENTROU NO SISTEMA (DELAYS DE REDE SMS)
    // Regra idêntica ao WhatsApp: status 'aguardando_operadora' por até 3 minutos
    console.log(`⏳ [CLIENT HUB] Ref ${txnId} aguardando SMS da operadora... Iniciando fila de validação.`);

    const orderDoc = {
      id: orderId,
      orderId,
      numero: cleanDest,
      cliente_solicitante: clientPhone || cleanDest,
      quantidade: qtyMb,
      valor: preco,
      valor_pago: valorSMS || preco,
      modo,
      status: 'aguardando_operadora', // Não envia megas até a confirmação real entrar!
      origem: 'client_hub',
      metodo,
      sms_ref: txnId,
      sms_original: smsClean.slice(0, 200),
      package_name: packageName || `${qtyMb}MB`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    splitMensalOrderIfEligible(orderDoc);
    handleSpecialPlanIfApplicable(orderDoc);

    inMemoryOrders.set(orderId, orderDoc);
    saveOrdersToCache();

    if (db) {
      db.collection('orders').doc(orderId).set(orderDoc).catch(e => console.warn('Firebase order save err:', e.message));
    }

    const timer = setTimeout(() => {
      if (hubAguardandoOperadora.has(txnId)) {
        hubAguardandoOperadora.delete(txnId);
        orderDoc.status = 'failed';
        orderDoc.motivo = 'Confirmação por SMS da operadora não foi recebida no tempo limite (3 min).';
        orderDoc.updatedAt = new Date().toISOString();
        inMemoryOrders.set(orderId, orderDoc);
        saveOrdersToCache();
        console.warn(`⏰ [HUB TIMEOUT] Pedido ${orderId} cancelado: SMS da operadora não entrou em 3 minutos.`);
      }
    }, 3 * 60 * 1000);

    hubAguardandoOperadora.set(txnId, {
      orderId,
      orderDoc,
      preco,
      timer
    });

    return res.json({
      success: true,
      status: 'aguardando_operadora',
      mensagem: `⏳ Comprovativo registado! Estamos a aguardar a confirmação oficial da rede (${metodoNome}). Assim que o SMS da operadora entrar no sistema (geralmente em 30 a 60 segundos), os seus megas serão enviados automaticamente. Pode acompanhar na aba 'Meus Pedidos'.`,
      orderId,
      destinatario: cleanDest,
      quantidade_mb: qtyMb,
      modo,
      metodo,
      txn_id: txnId
    });

  } catch (err) {
    console.error('[CLIENT HUB] Erro em /api/client/purchase:', err.message);
    return res.status(500).json({ success: false, mensagem: 'Erro interno do servidor. Tente novamente.' });
  }
});

// ── 20.5 Histórico de Compras do Cliente ──
app.get('/api/client/orders/:phone', (req, res) => {
  const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
  const orders = [...inMemoryOrders.values()]
    .filter(o => {
      const sol = String(o.cliente_solicitante || o.remetente || '').replace(/\D/g, '');
      const num = String(o.numero || '').replace(/\D/g, '');
      return sol.includes(cleanPhone) || num.includes(cleanPhone);
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 30);

  return res.json({ success: true, count: orders.length, orders });
});

// ── 20.6 Suporte Bidirecional (Cliente ↔ Admin) ──
app.get('/api/client/support/messages/:phone', (req, res) => {
  const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
  const msgs = clientSupportMessages.filter(m => m.clientPhone === cleanPhone);
  return res.json({ success: true, messages: msgs });
});

app.post('/api/client/support/send', (req, res) => {
  const { phone, name, text, sender } = req.body || {};
  if (!phone || !text) return res.status(400).json({ success: false, mensagem: 'Telefone e mensagem são obrigatórios.' });

  const cleanPhone = String(phone).replace(/\D/g, '');
  const msgObj = {
    id: `MSG-${Date.now()}-${Math.floor(Math.random()*1000)}`,
    clientPhone: cleanPhone,
    clientName: name || `Cliente ${cleanPhone.slice(-4)}`,
    sender: sender === 'admin' ? 'admin' : 'client',
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    read: sender === 'admin'
  };

  clientSupportMessages.push(msgObj);
  if (clientSupportMessages.length > 500) clientSupportMessages.shift();

  return res.json({ success: true, message: msgObj });
});

// ── 20.7 CRM & Suporte no Ka-Net Admin Master ──
app.get('/api/admin/crm/stats', (req, res) => {
  const token = req.headers['authorization'] || req.headers['x-master-token'] || req.query.token;
  const cleanTok = String(token || '').replace('Bearer ', '').trim();
  if (!MASTER_TOKENS.has(cleanTok) && cleanTok !== 'KaNetKelven2026Secure') {
    return res.status(403).json({ error: 'Não autorizado' });
  }

  const now = Date.now();
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const allClients = [...clientUsers.values()];
  const totalCadastrados = allClients.length;

  // Analisar pedidos por cliente
  const allOrders = [...inMemoryOrders.values()];
  const clientPurchases = new Map();

  allOrders.forEach(o => {
    const p = String(o.cliente_solicitante || o.remetente || o.numero || '').replace(/\D/g, '').slice(-9);
    if (!p) return;
    const time = new Date(o.createdAt || 0).getTime();
    if (!clientPurchases.has(p) || clientPurchases.get(p).lastTime < time) {
      clientPurchases.set(p, {
        lastTime: time,
        count: (clientPurchases.get(p)?.count || 0) + 1,
        totalSpent: (clientPurchases.get(p)?.totalSpent || 0) + (Number(o.valor) || 0)
      });
    }
  });

  let ativosRegulares = 0;
  let inativosMais7Dias = 0;
  const clientesDetalhados = allClients.map(c => {
    const stats = clientPurchases.get(c.phone.slice(-9)) || { lastTime: new Date(c.createdAt).getTime(), count: 0, totalSpent: 0 };
    const diasSemComprar = Math.floor((now - stats.lastTime) / (24 * 60 * 60 * 1000));
    const isAtivo = diasSemComprar <= 7;
    if (isAtivo) ativosRegulares++;
    else inativosMais7Dias++;

    return {
      phone: c.phone,
      name: c.name,
      totalCompras: stats.count,
      totalGasto: stats.totalSpent,
      diasSemComprar,
      status: isAtivo ? 'ativo' : 'inativo_7d'
    };
  });

  return res.json({
    success: true,
    totalCadastrados,
    ativosRegulares,
    inativosMais7Dias,
    clientes: clientesDetalhados.sort((a, b) => b.totalGasto - a.totalGasto)
  });
});

app.get('/api/admin/crm/support-tickets', (req, res) => {
  // Agrupa mensagens não lidas por cliente para o Admin responder
  const grouped = {};
  clientSupportMessages.forEach(m => {
    if (!grouped[m.clientPhone]) {
      grouped[m.clientPhone] = {
        clientPhone: m.clientPhone,
        clientName: m.clientName,
        unreadCount: 0,
        lastMessage: m.text,
        lastTime: m.createdAt,
        messages: []
      };
    }
    grouped[m.clientPhone].messages.push(m);
    if (m.sender === 'client' && !m.read) {
      grouped[m.clientPhone].unreadCount++;
    }
  });

  return res.json({ success: true, tickets: Object.values(grouped).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime)) });
});

app.post('/api/admin/crm/support-reply', (req, res) => {
  const { clientPhone, text } = req.body || {};
  if (!clientPhone || !text) return res.status(400).json({ success: false, mensagem: 'Telefone e resposta obrigatórios.' });

  const cleanPhone = String(clientPhone).replace(/\D/g, '');
  const msgObj = {
    id: `MSG-ADM-${Date.now()}`,
    clientPhone: cleanPhone,
    clientName: 'Administrador Ka-Net',
    sender: 'admin',
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    read: true
  };

  // Marcar anteriores do cliente como lidas
  clientSupportMessages.forEach(m => {
    if (m.clientPhone === cleanPhone && m.sender === 'client') m.read = true;
  });

  clientSupportMessages.push(msgObj);

  // Se solicitado envio também via SMS de hardware (Porta 8077 do Gateway)
  if (req.body.sendViaSms || req.body.sendSms) {
    const gatewayPort = req.body.port || process.env.SMS_GATEWAY_PORT || 8077;
    const gatewayHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';
    axios.post(`http://${gatewayHost}:${gatewayPort}/sms/send`, {
      numero: cleanPhone,
      mensagem: String(text).trim(),
      sim_slot: req.body.simSlot ? Number(req.body.simSlot) : 0
    }, { timeout: 6000 }).then(smsRes => {
      console.log(`📱 [SMS SUPORTE ENVIADO] Porta ${gatewayPort} -> ${cleanPhone}:`, smsRes.data?.mensagem || 'OK');
    }).catch(err => {
      console.warn(`⚠️ [SMS SUPORTE AVISO] Não foi possível despachar SMS na porta ${gatewayPort}:`, err.message);
    });
  }

  return res.json({ success: true, message: msgObj });
});

// ── 20.7.1 ENDPOINTS DE SMS GATEWAY (PORTA 8077 / SMS & ATENDIMENTO INTEGRADO) ──
app.get(['/api/sms/status', '/api/sms/gateway/status'], async (req, res) => {
  const gatewayPort = req.query.port || process.env.SMS_GATEWAY_PORT || 8077;
  const gatewayHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';
  try {
    const response = await axios.get(`http://${gatewayHost}:${gatewayPort}/sms/status`, { timeout: 3500 });
    return res.json({ success: true, gateway: response.data });
  } catch (err) {
    return res.json({
      success: false,
      porta: Number(gatewayPort),
      mensagem: `Gateway SMS inacessível na porta ${gatewayPort}: ${err.message}`,
      status: 'offline'
    });
  }
});

app.get(['/api/sms/payments', '/api/sms/gateway/payments'], async (req, res) => {
  const gatewayPort = req.query.port || process.env.SMS_GATEWAY_PORT || 8077;
  const gatewayHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';
  try {
    const response = await axios.get(`http://${gatewayHost}:${gatewayPort}/sms/payments`, { timeout: 3500 });
    return res.json(response.data);
  } catch (err) {
    return res.status(502).json({ success: false, mensagem: `Erro ao buscar pagamentos SMS do gateway: ${err.message}` });
  }
});

app.get(['/api/sms/inbox', '/api/sms/gateway/inbox', '/api/sms/messages'], async (req, res) => {
  const gatewayPort = req.query.port || process.env.SMS_GATEWAY_PORT || 8077;
  const gatewayHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';
  const phone = req.query.phone || '';
  try {
    const response = await axios.get(`http://${gatewayHost}:${gatewayPort}/sms/inbox?phone=${encodeURIComponent(phone)}`, { timeout: 3500 });
    return res.json(response.data);
  } catch (err) {
    return res.status(502).json({ success: false, mensagem: `Erro ao buscar mensagens do gateway: ${err.message}` });
  }
});

app.post(['/api/sms/send', '/api/sms/gateway/send'], async (req, res) => {
  const { numero, phone, destinatario, mensagem, texto, sim_slot = 0, port } = req.body || {};
  const targetNum = numero || phone || destinatario;
  const targetText = mensagem || texto;
  const gatewayPort = port || process.env.SMS_GATEWAY_PORT || 8077;
  const gatewayHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';

  if (!targetNum || !targetText) {
    return res.status(400).json({ success: false, mensagem: 'Número de telefone e texto do SMS são obrigatórios.' });
  }

  try {
    const response = await axios.post(`http://${gatewayHost}:${gatewayPort}/sms/send`, {
      numero: targetNum,
      mensagem: targetText,
      sim_slot: Number(sim_slot) || 0
    }, { timeout: 7000 });
    return res.json(response.data);
  } catch (err) {
    console.warn(`ℹ️ [SMS GATEWAY SEND] Envio direto HTTP falhou (${err.message}). Adicionando à fila da Nuvem.`);
    if (smsSalesEngine && typeof smsSalesEngine.sendSms === 'function') {
      const qRes = await smsSalesEngine.sendSms(targetNum, targetText, Number(sim_slot) || 0);
      return res.json({ success: true, queued: true, mensagem: 'SMS adicionado à fila da Nuvem para despacho pelo celular Gateway', ...qRes });
    }
    return res.status(502).json({
      success: false,
      mensagem: `Falha ao despachar SMS via Gateway (Porta ${gatewayPort}): ${err.response?.data?.mensagem || err.message}`
    });
  }
});

// ── 20.7.1 CONFIRMAÇÃO DE ENVIO DE SMS PELO GATEWAY ANDROID (PORTA 8090) ──
app.post(['/api/sms/outgoing/confirm', '/api/sms/confirm'], (req, res) => {
  const { id, success, error } = req.body || {};
  if (smsSalesEngine && typeof smsSalesEngine.confirmSmsSent === 'function') {
    smsSalesEngine.confirmSmsSent(id, success !== false, error);
  }
  return res.json({ success: true, mensagem: 'Status do SMS confirmado com sucesso' });
});

// ── 20.7.1.1 CONSULTA DE SMS PENDENTES PARA ENVIO PELO GATEWAY ──
app.get('/api/sms/outgoing/pending', (req, res) => {
  if (smsSalesEngine && typeof smsSalesEngine.getNextPendingSms === 'function') {
    const item = smsSalesEngine.getNextPendingSms();
    return res.json({ success: true, pending_sms: item });
  }
  return res.json({ success: true, pending_sms: null });
});

// ── 20.7.2 WEBHOOK DE RECEBIMENTO DE SMS DOS CLIENTES (BOT DE VENDAS AUTOMÁTICO) ──
app.post(['/api/sms/incoming', '/api/sms/webhook'], async (req, res) => {
  const { sender, remetente, phone, body, text, mensagem } = req.body || {};
  const cleanSender = sender || remetente || phone;
  const cleanBody = body || text || mensagem;

  if (!cleanSender || !cleanBody) {
    return res.status(400).json({ success: false, mensagem: 'Remetente e mensagem são obrigatórios.' });
  }

  console.log(`📩 [SMS WEBHOOK RECEBIDO] De: ${cleanSender} | Texto: ${cleanBody.substring(0, 60)}`);

  if (smsSalesEngine) {
    smsSalesEngine.processIncomingCustomerSms({
      sender: cleanSender,
      body: cleanBody,
      inMemoryPayments
    }).catch(err => {
      console.error('❌ [SMS SALES ENGINE ERRO]:', err.message);
    });
  }

  return res.json({ success: true, mensagem: 'SMS processado pelo Bot de Vendas Ka-Net!' });
});

// ── 20.8 Motor de Alertas de Expiração (D-3 e D-0) & Planos Faseados/Renováveis ──
const clientRemindersSent = new Set(); // chave: `${orderId}_D3` ou `${orderId}_D0`

function processClientPackageReminders() {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  for (const order of inMemoryOrders.values()) {
    if (!order.createdAt) continue;
    const modo = (order.modo || '').toLowerCase();
    
    // Determinar duração do pacote em dias
    let duracaoDias = 0;
    if (modo === 'semanal') duracaoDias = 7;
    else if (modo === 'mensal') duracaoDias = 30;
    else if (modo === 'tudo_top' || modo === 'ilimitado') duracaoDias = 30;
    else continue; // diários não precisam de lembrete D-3

    const createdAtTime = new Date(order.createdAt).getTime();
    const dataExpiracaoTime = createdAtTime + (duracaoDias * ONE_DAY_MS);
    const diasRestantes = Math.ceil((dataExpiracaoTime - now) / ONE_DAY_MS);

    const clientPhone = String(order.cliente_solicitante || order.remetente || order.numero || '').replace(/\D/g, '');
    if (!clientPhone) continue;

    // 1. Alerta Faltando 3 Dias (D-3)
    if (diasRestantes === 3) {
      const reminderKey = `${order.id || order.orderId}_D3`;
      if (!clientRemindersSent.has(reminderKey)) {
        clientRemindersSent.add(reminderKey);

        const textoD3 = `🔔 [Ka-Net Lembrete]: Olá! O seu pacote ${order.quantidade}MB (${modo.toUpperCase()}) expira em 3 dias. Para continuar conectado sem interrupções, renove já no seu Ka-Net Client Hub ou via WhatsApp!`;

        // Salvar mensagem no chat de suporte do app para o cliente ver imediatamente
        clientSupportMessages.push({
          id: `REMINDER-${Date.now()}`,
          clientPhone,
          clientName: 'Ka-Net Notificações',
          sender: 'admin',
          text: textoD3,
          createdAt: new Date().toISOString(),
          read: false
        });

        // Enviar via WhatsApp se o motor Baileys estiver conectado
        if (baileysEngine && typeof baileysEngine.enviarMensagemTexto === 'function') {
          baileysEngine.enviarMensagemTexto(`258${clientPhone.slice(-9)}@s.whatsapp.net`, textoD3).catch(() => {});
        }

        console.log(`⏰ [LEMBRETE D-3] Enviado para ${clientPhone} referente ao pedido ${order.id}`);
      }
    }

    // 2. Alerta no Próprio Dia de Expiração (D-0)
    if (diasRestantes <= 0) {
      const reminderKey = `${order.id || order.orderId}_D0`;
      if (!clientRemindersSent.has(reminderKey)) {
        clientRemindersSent.add(reminderKey);

        const textoD0 = `⚠️ [Ka-Net Urgente]: O seu pacote ${order.quantidade}MB (${modo.toUpperCase()}) expira hoje! Evite ficar sem internet, ative agora um novo pacote no seu aplicativo Ka-Net!`;

        clientSupportMessages.push({
          id: `REMINDER-D0-${Date.now()}`,
          clientPhone,
          clientName: 'Ka-Net Notificações',
          sender: 'admin',
          text: textoD0,
          createdAt: new Date().toISOString(),
          read: false
        });

        if (baileysEngine && typeof baileysEngine.enviarMensagemTexto === 'function') {
          baileysEngine.enviarMensagemTexto(`258${clientPhone.slice(-9)}@s.whatsapp.net`, textoD0).catch(() => {});
        }

        console.log(`🚨 [LEMBRETE D-0] Enviado para ${clientPhone} referente ao pedido ${order.id}`);
      }
    }
  }
}

// Executar verificação de lembretes a cada 1 hora
setInterval(processClientPackageReminders, 60 * 60 * 1000);
// Executar primeira checagem após 15 segundos do boot
setTimeout(processClientPackageReminders, 15000);

// ══════════════════════════════════════════════════════════════════════════════
// ─── 20.9 MOTOR DE PLANOS AGENDADOS: RENOVÁVEL & FASEADO ────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// RENOVÁVEL: Envia MB inicial no momento da compra + MB_diaria cada dia seguinte
//            1 hora mais cedo que o dia anterior.
//            Ex: Compra 3GB+700 às 10h → agora envia 3072MB inicial
//                Dia 1 → 09h → 100MB | Dia 2 → 08h → 100MB | ... por 7 dias
//
// FASEADO:   Envia 1GB por dia até esgotar o total.
//            Dia 0 → agora → 1024MB | Dia 1 → 1h antes → 1024MB | ...
//            Ex: 5GB Faseado (5×1024MB) | 10GB Faseado (10×1024MB)
// ══════════════════════════════════════════════════════════════════════════════

const PLANS_CACHE_FILE = path.join(__dirname, '..', 'cache_scheduled_plans.json');
const scheduledPlans   = new Map(); // planId → planDoc

// ── Persistência ──────────────────────────────────────────────────────────────
function loadScheduledPlans() {
  try {
    if (fs.existsSync(PLANS_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLANS_CACHE_FILE, 'utf8'));
      for (const [id, plan] of Object.entries(raw)) {
        if (plan.status === 'ativo') scheduledPlans.set(id, plan);
      }
      console.log(`📋 [PLANOS] ${scheduledPlans.size} planos activos carregados do cache.`);
    }
  } catch(e) { console.warn('⚠️ [PLANOS] Erro ao carregar cache:', e.message); }
}

function saveScheduledPlans() {
  try {
    const obj = {};
    for (const [id, plan] of scheduledPlans.entries()) obj[id] = plan;
    fs.writeFileSync(PLANS_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch(e) { console.warn('⚠️ [PLANOS] Erro ao guardar cache:', e.message); }
}

loadScheduledPlans();

// ── Criar Plano ───────────────────────────────────────────────────────────────
function criarPlano({ numero, tipo, total_mb, mb_inicial, mb_diaria, valor, sms_ref, clientPhone }) {
  const planId   = `PLAN-${tipo.toUpperCase()}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const now      = new Date();

  // Total de entregas diárias (após a inicial)
  const entregas_diarias_total = Math.round((total_mb - (mb_inicial || mb_diaria)) / mb_diaria);

  // Próxima entrega = amanhã, 1 hora antes da hora actual
  const proxima = new Date(now);
  proxima.setDate(proxima.getDate() + 1);
  proxima.setHours(proxima.getHours() - 1);
  // Ajustar minutos/segundos para coincidir com a hora exacta
  proxima.setSeconds(0);
  proxima.setMilliseconds(0);

  const plan = {
    planId,
    numero: String(numero).replace(/\D/g, '').slice(-9),
    clientPhone: clientPhone || String(numero).replace(/\D/g, '').slice(-9),
    tipo,       // 'renovavel' | 'faseado'
    total_mb,
    mb_inicial: mb_inicial || mb_diaria,
    mb_diaria,
    entregas_diarias_total,
    entregas_feitas: 0,
    valor,
    sms_ref,
    hora_compra: now.toISOString(),
    proxima_entrega: proxima.toISOString(),
    historico: [],
    status: 'ativo',
    createdAt: now.toISOString()
  };

  scheduledPlans.set(planId, plan);
  saveScheduledPlans();
  console.log(`✅ [PLANO ${tipo.toUpperCase()}] Criado: ${planId} | ${total_mb}MB total | ${mb_diaria}MB/dia | Próxima: ${proxima.toISOString()}`);
  return plan;
}

// ── Detector e Ativador Automático de Planos Especiais ────────────────────────
function handleSpecialPlanIfApplicable(orderDoc) {
  if (!orderDoc || orderDoc.isSpecialPlanHandled) return false;
  const val = Number(orderDoc.valor) || Number(orderDoc.valor_pago);
  if (!val) return false;

  let botCfg = {};
  try {
    const cfgPath = path.resolve(__dirname, '..', 'bot_config.js');
    if (fs.existsSync(cfgPath)) {
      botCfg = require(cfgPath);
    }
  } catch(e) {}

  const planos = (botCfg && botCfg.PLANOS_ESPECIAIS) || {};
  const plano = planos[String(Math.round(val))];

  if (plano && (plano.tipo === 'renovacao' || plano.tipo === 'renovavel' || plano.tipo === 'faseado')) {
    orderDoc.isSpecialPlanHandled = true;
    const tipo = (plano.tipo === 'renovacao' || plano.tipo === 'renovavel') ? 'renovavel' : 'faseado';
    const mbInicial = plano.inicial || plano.diaria || 1024;
    const totalMb = plano.total || (mbInicial + ((plano.diaria || 1024) * 7));

    // Ajustar a quantidade da ordem inicial (entrega imediata de hoje)
    orderDoc.quantidade = mbInicial;
    orderDoc.origem = tipo;
    orderDoc.remetente = `Ka-Net ${tipo === 'faseado' ? 'Faseado' : 'Renovável'} (Fase 1)`;

    // Criar o plano agendado para as próximas entregas diárias (1 hora antes a cada dia)
    const plan = criarPlano({
      numero: orderDoc.numero,
      tipo,
      total_mb: totalMb,
      mb_inicial: mbInicial,
      mb_diaria: plano.diaria || (tipo === 'renovavel' ? 100 : 1024),
      valor: val,
      sms_ref: orderDoc.sms_ref || orderDoc.orderId,
      clientPhone: orderDoc.cliente_solicitante || orderDoc.numero
    });

    console.log(`✨ [PLANO ESPECIAL DETECTADO] Ordem ${orderDoc.orderId} (${val}MT) configurada como ${tipo.toUpperCase()}!`);
    console.log(`   📦 Entrega Inicial: ${mbInicial}MB (agora)`);
    console.log(`   ⏰ Próximas entregas: ${plan.mb_diaria}MB/dia | Total: ${plan.entregas_diarias_total} dias | Próxima: ${plan.proxima_entrega}`);
    return true;
  }
  return false;
}

// ── Executar entrega diária ───────────────────────────────────────────────────
async function executarEntregaPlano(planId) {
  const plan = scheduledPlans.get(planId);
  if (!plan || plan.status !== 'ativo') return;

  const entregaN = plan.entregas_feitas + 1;
  const orderId  = `${planId}-D${entregaN}`;
  const timestamp = new Date().toISOString();

  // Criar ordem normal na fila de processamento
  const orderDoc = {
    orderId,
    id:       orderId,
    numero:   plan.numero,
    quantidade: plan.mb_diaria,
    valor:    0, // já pago na compra inicial
    valor_pago: 0,
    modo:     'diario',
    status:   'pending',
    origem:   plan.tipo,          // 'renovavel' | 'faseado'
    planId,
    remetente: `Ka-Net Auto (${plan.tipo})`,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  inMemoryOrders.set(orderId, orderDoc);
  saveOrdersToCache();

  if (db) {
    db.collection('orders').doc(orderId).set(orderDoc).catch(e =>
      console.warn('Firebase plan order err:', e.message));
  }

  // Registar no histórico do plano
  plan.historico.push({ entrega: entregaN, orderId, timestamp, mb: plan.mb_diaria });
  plan.entregas_feitas = entregaN;

  const label = plan.tipo === 'faseado' ? `Fase ${entregaN}/${plan.entregas_diarias_total + 1}` : `Renovação ${entregaN}/${plan.entregas_diarias_total}`;
  console.log(`📦 [PLANO ${plan.tipo.toUpperCase()}] ${label} → ${plan.mb_diaria}MB → ${plan.numero} | Ordem: ${orderId}`);

  // Notificar cliente via WhatsApp
  const restantes = plan.entregas_diarias_total - plan.entregas_feitas;
  const textoNotif = plan.tipo === 'faseado'
    ? `📦 [Ka-Net] ${label}: ${(plan.mb_diaria/1024).toFixed(1)}GB activado agora! ${restantes > 0 ? `Restam ${restantes} fases.` : '✅ Plano concluído!'}`
    : `♻️ [Ka-Net] Renovação automática: +${plan.mb_diaria}MB adicionados! ${restantes > 0 ? `${restantes} renovações restantes.` : '✅ Plano de renovação concluído!'}`;

  if (baileysEngine && typeof baileysEngine.enviarMensagemTexto === 'function') {
    baileysEngine.enviarMensagemTexto(`258${plan.clientPhone.slice(-9)}@s.whatsapp.net`, textoNotif).catch(() => {});
  }

  // Guardar mensagem no suporte do app
  clientSupportMessages.push({
    id: `PLAN-MSG-${Date.now()}`,
    clientPhone: plan.clientPhone,
    clientName: 'Ka-Net Automático',
    sender: 'admin',
    text: textoNotif,
    createdAt: timestamp,
    read: false
  });

  // Verificar se o plano terminou
  if (plan.entregas_feitas >= plan.entregas_diarias_total) {
    plan.status = 'concluido';
    plan.concluido_em = timestamp;
    console.log(`🏁 [PLANO ${plan.tipo.toUpperCase()}] ${planId} CONCLUÍDO! Total entregue: ${plan.total_mb}MB ao ${plan.numero}`);
    saveScheduledPlans();
    return;
  }

  // Agendar próxima entrega: amanhã, 1 hora antes da entrega anterior
  const proxima = new Date(plan.proxima_entrega);
  proxima.setDate(proxima.getDate() + 1);
  proxima.setHours(proxima.getHours() - 1);
  plan.proxima_entrega = proxima.toISOString();

  saveScheduledPlans();
  console.log(`⏰ [PLANO] Próxima entrega agendada: ${plan.proxima_entrega}`);
}

// ── Motor de verificação (a cada 1 minuto) ────────────────────────────────────
function checkScheduledPlans() {
  const now = Date.now();
  for (const [planId, plan] of scheduledPlans.entries()) {
    if (plan.status !== 'ativo') continue;
    if (!plan.proxima_entrega) continue;
    const nextMs = new Date(plan.proxima_entrega).getTime();
    if (now >= nextMs) {
      executarEntregaPlano(planId).catch(e =>
        console.error(`❌ [PLANO] Erro na entrega ${planId}:`, e.message));
    }
  }
}

setInterval(checkScheduledPlans, 60 * 1000); // Verificar a cada 1 minuto
setTimeout(checkScheduledPlans, 5000);        // Primeira checagem 5s após boot

// ── API: Criar plano renovável / faseado ─────────────────────────────────────
app.post('/api/subscribe/plan', async (req, res) => {
  try {
    const { numero, planoKey, sms_ref, clientPhone, recipientPhone } = req.body || {};
    if (!numero && !recipientPhone) {
      return res.status(400).json({ success: false, error: 'Número de destino obrigatório.' });
    }
    if (!planoKey) {
      return res.status(400).json({ success: false, error: 'Chave do plano obrigatória.' });
    }

    // Ler plano do bot_config
    let botCfg = {};
    try {
      const cfgPath = path.resolve(__dirname, '..', 'bot_config.js');
      if (fs.existsSync(cfgPath)) {
        delete require.cache[require.resolve(cfgPath)];
        botCfg = require(cfgPath);
      }
    } catch(e) { console.warn('bot_config read err:', e.message); }

    const planos = botCfg.PLANOS_ESPECIAIS || {};
    const plano  = planos[String(planoKey)];
    if (!plano) {
      return res.status(404).json({ success: false, error: `Plano "${planoKey}" não encontrado.` });
    }

    const tipo      = plano.tipo; // 'renovavel' | 'faseado'
    const total_mb  = plano.total || 0;
    const mb_inicial= plano.inicial || plano.diaria || 1024;
    const mb_diaria = plano.diaria  || 1024;
    const valor     = Number(planoKey);
    const destino   = String(recipientPhone || numero).replace(/\D/g, '').slice(-9);

    if (tipo !== 'renovavel' && tipo !== 'renovacao' && tipo !== 'faseado') {
      return res.status(400).json({ success: false, error: 'Tipo de plano inválido. Use renovavel ou faseado.' });
    }

    // Prevenção de SMS duplicado
    if (sms_ref && clientSmsHistory.has(sms_ref)) {
      return res.status(400).json({ success: false, error: 'Comprovativo já utilizado.' });
    }
    if (sms_ref) clientSmsHistory.add(sms_ref);

    // ── Entrega Inicial ──
    const orderId0 = `PLAN-INIT-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const orderInit = {
      orderId: orderId0, id: orderId0,
      numero:  destino,
      quantidade: mb_inicial,
      valor:   valor, valor_pago: valor,
      modo:    'diario',
      status:  'pending',
      origem:  tipo,
      remetente: `Ka-Net ${tipo === 'faseado' ? 'Faseado' : 'Renovável'} (Fase 1)`,
      sms_ref: sms_ref || '',
      createdAt: timestamp, updatedAt: timestamp
    };
    inMemoryOrders.set(orderId0, orderInit);
    saveOrdersToCache();
    if (db) db.collection('orders').doc(orderId0).set(orderInit).catch(() => {});

    // ── Criar plano agendado (para as entregas dos dias seguintes) ──
    const plan = criarPlano({
      numero:   destino,
      tipo:     tipo === 'renovacao' ? 'renovavel' : tipo,
      total_mb,
      mb_inicial,
      mb_diaria,
      valor,
      sms_ref,
      clientPhone: clientPhone || destino
    });

    console.log(`🚀 [PLANO] Iniciado: ${plan.planId} | Entrega inicial ${mb_inicial}MB → ${destino} | Plano: ${plano.nome}`);

    return res.json({
      success:   true,
      mensagem:  `✅ Plano "${plano.nome}" iniciado! ${mb_inicial}MB activados agora. As próximas entregas de ${mb_diaria}MB/dia serão automáticas.`,
      planId:    plan.planId,
      orderInit: orderId0,
      plano:     plano.nome,
      total_mb,
      mb_diaria,
      dias_restantes: plan.entregas_diarias_total,
      proxima_entrega: plan.proxima_entrega
    });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── API: Listar planos activos (Admin) ────────────────────────────────────────
app.get('/api/admin/plans', (req, res) => {
  const all = [...scheduledPlans.values()].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ success: true, count: all.length, plans: all });
});

// ── API: Cancelar plano (Admin) ───────────────────────────────────────────────
app.delete('/api/admin/plans/:planId', (req, res) => {
  const { planId } = req.params;
  const plan = scheduledPlans.get(planId);
  if (!plan) return res.status(404).json({ success: false, error: 'Plano não encontrado.' });
  plan.status = 'cancelado';
  plan.cancelado_em = new Date().toISOString();
  saveScheduledPlans();
  console.log(`🚫 [PLANO] Cancelado pelo admin: ${planId}`);
  return res.json({ success: true, mensagem: `Plano ${planId} cancelado.` });
});

app.listen(PORT, '0.0.0.0', () => {

  console.log('==================================================================');
  console.log(`🚀 [KA-NET CLOUD API] Servidor Online na porta ${PORT}`);
  console.log(`📱 [WHATSAPP QR CODE] Aceda a http://localhost:${PORT}/qr para conectar`);
  console.log('==================================================================');

  // ── KEEP-ALIVE: evita que o Render adormeça no plano gratuito ──
  // O Render dorme após 15 min de inatividade → auto-ping a cada 14 min
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutos

  setInterval(() => {
    try {
      const urlStr = `${SELF_URL}/health`;
      const client = urlStr.startsWith('https') ? require('https') : require('http');
      client.get(urlStr, (res) => {
        console.log(`💓 [KEEP-ALIVE] Auto-ping → ${urlStr} | HTTP ${res.statusCode}`);
      }).on('error', (e) => {
        console.warn(`⚠️ [KEEP-ALIVE] Falha no ping: ${e.message}`);
      });
    } catch (e) {
      console.warn(`⚠️ [KEEP-ALIVE] Erro: ${e.message}`);
    }
  }, PING_INTERVAL_MS);

  console.log(`💓 [KEEP-ALIVE] Auto-ping activo a cada 14 min → ${SELF_URL}/health`);
});

