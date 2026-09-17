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

const inMemoryOrders = new Map();

// ----------------------------------------------------
// 2. MIDDLEWARES
// ----------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
      jid: req.body.jid || null,
      input_val: req.body.input_val || '',
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp
    };

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

function isPortCompatibleWithModo(port, modo) {
  const m = String(modo || '').toLowerCase().trim();
  if (m === 'saldo' || m === 'credito') {
    return port === 8777;
  }
  if (m === 'semanal' || m === 'mensal' || m === 'ilimitado' || m === 'ilimitados' || m.startsWith('esp') || m.includes('seman') || m.includes('mens')) {
    return port === 8077;
  }
  // Pacotes Diários: compatível com Porta 8023 E Porta 8024 (ou qualquer outro celular diário)
  return port === 8023 || port === 8024 || (port !== 8077 && port !== 8777);
}

function isDeviceApto(dev) {
  if (!dev) return false;
  const now = Date.now();
  const lastSeen = new Date(dev.lastSeen || 0).getTime();
  const isOnline = (now - lastSeen) < 180000;
  if (!isOnline) return false;
  if (dev.pending_order) return false;
  if (dev.livre === false) return false;

  const port = Number(dev.porta);

  // ── PORTAS ESPECIAIS (8077 - Semanais/Mensais/Ilimitados e 8777 - Saldo/Crédito) ──
  // Não utilizam o limite de 10 transferências de dados por chip nem dependem de pacotes diários
  if (port === 8077 || port === 8777) {
    if (dev.sem_saldo === true) return false;
    if (dev.saldo_mt !== undefined && dev.saldo_mt <= 0) return false;
    return true;
  }

  // ── PORTAS DIÁRIAS (8023, 8024) ──
  if (dev.sem_saldo === true) return false;
  if (dev.limite_atingido === true) return false;
  if (dev.transfers_available !== undefined && dev.transfers_available <= 0) return false;
  const s1 = dev.sim1_saldo_mb !== undefined ? dev.sim1_saldo_mb : 10240;
  const s2 = dev.sim2_saldo_mb !== undefined ? dev.sim2_saldo_mb : 10240;
  if (s1 < 50 && s2 < 50) return false;
  return true;
}

const MIN_TRANSFER_MB = 50;

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
                        port === 8077 ? 'Vodacom (Redmi)' :
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
  // - Porta 8023: Exclusiva para pacotes diários (24hrs)
  // - Porta 8077: Exclusiva para pacotes semanais, mensais e ilimitados
  // - Porta 8777: Exclusiva para recargas de saldo/crédito
  // - SÓ atribui pedidos se o celular estiver 100% APTO (com saldo e sem ter atingido limite diário)
  if (isDeviceApto(dev)) {
    for (const [orderId, order] of inMemoryOrders.entries()) {
        if (order.status !== 'pending') continue;

        let isCompatible = order.targetPort ? (order.targetPort === port) : isPortCompatibleWithModo(port, order.modo);
        if (!isCompatible && port === 8077 && (order.modo === 'diario' || !order.modo)) {
          // Se nenhuma porta diária (8023, 8024) estiver apta/online, a porta 8077 assume para não deixar o cliente à espera!
          const anyDailyApto = isDeviceApto(inMemoryDevices[8023]) || isDeviceApto(inMemoryDevices[8024]);
          if (!anyDailyApto) {
            isCompatible = true;
            console.log(`🔀 [FAILOVER AUTO] Portas diárias (8023/8024) indisponíveis. Porta 8077 assumindo pedido diário ${orderId}!`);
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
                input_val: order.input_val || '',
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
                input_val: order.input_val || '',
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

          // Se modo não for saldo (8777), aceitar qualquer porta Vodacom disponível como fallback
          if (modoOrder !== 'saldo' && modoOrder !== 'credito' && candidatePort !== 8777) {
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
  return res.json({
    status: isOnline ? 'ok' : 'offline',
    online: isOnline,
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

  inMemoryDevices[port] = {
    ...currentDev,
    ...req.body,
    porta: port,
    pending_order: pendingOrder,
    lastSeen: new Date().toISOString()
  };

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
          baileysEngine.sendTextMessage(clientJid,
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  🎉 *PACOTE ATIVADO COM SUCESSO!* 📶\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `📲 *Destino:* *${targetNum}*\n` +
            `📦 *Volume:* *${volStr}*\n` +
            `🔖 *Ref:* \`${resId}\`\n\n` +
            `⚡ *A sua recarga já está pronta para uso!*\n` +
            `_Obrigado pela preferência e confiança no nosso serviço!_ 🙏\n\n` +
            `📞 *Suporte / Dúvidas:* Envie *Suporte*`
          );
          console.log(`📲 [NOTIFICAÇÃO WA] Cliente ${clientJid} notificado de SUCESSO no pedido ${resId}`);
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
      if (success) {
        order.status = 'completed';
        order.completedAt = new Date().toISOString();
        order.lastError = null;
        console.log(`🎉 [PEDIDO SUCESSO] Pedido ${resId} concluído com sucesso pelo Celular Porta ${port}!`);

        // Se este pedido foi a Parte 1 de uma divisão inteligente, liberar a Parte 2 na fila
        if (order.isSplit && order.splitPart === 1 && order.part2Id) {
          const part2Order = inMemoryOrders.get(order.part2Id);
          if (part2Order && part2Order.status === 'waiting_part1') {
            part2Order.status = 'pending';
            part2Order.updatedAt = new Date().toISOString();
            console.log(`🚀 [PARTE 2 LIBERADA] Parte 2 (${part2Order.id} - ${part2Order.quantidade}MB) liberada para envio imediato por outra porta!`);
          }
        }
      } else {
        const errorMsg = (req.body.last_result && req.body.last_result.error) || 'Falha USSD / Timeout';
        order.lastError = errorMsg;
        order.retryCount = (order.retryCount || 0) + 1;
        order.failedPorts = order.failedPorts || [];
        if (!order.failedPorts.includes(port)) order.failedPorts.push(port);

        // Se falhou menos de 5 vezes, MANTÉM COMO 'pending' para que outra porta disponível
        // ou o mesmo celular após trocar de cartão/abrir Slim SIM pegue o pedido automaticamente!
        if (order.retryCount < 5) {
          order.status = 'pending';
          order.assignedToPort = null;
          order.processingAt = null;
          order.targetPort = null; // Permite que qualquer porta compatível pegue
          console.log(`🔄 [FAILOVER NUVEM] Pedido ${resId} falhou na Porta ${port} (${errorMsg}). Mantido na fila como PENDENTE para outra porta ou pós-Slim SIM (Tentativa #${order.retryCount})`);
        } else {
          order.status = 'failed';
          order.completedAt = new Date().toISOString();
          console.warn(`🛑 [PEDIDO ESGOTADO] Pedido ${resId} atingiu o limite de 5 tentativas. Marcado como falhado.`);

          // Se a Parte 1 falhou definitivamente, cancelar a Parte 2
          if (order.isSplit && order.splitPart === 1 && order.part2Id) {
            const part2Order = inMemoryOrders.get(order.part2Id);
            if (part2Order && part2Order.status === 'waiting_part1') {
              part2Order.status = 'cancelled';
              part2Order.completedAt = new Date().toISOString();
              part2Order.lastError = 'Cancelado devido a falha permanente na Parte 1';
              console.warn(`🛑 [PARTE 2 CANCELADA] Parte 2 ${part2Order.id} cancelada devido à falha permanente da Parte 1.`);
            }
          }
        }
      }
      saveOrdersToCache();
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
  const orders = Array.from(inMemoryOrders.entries()).map(([id, o]) => ({ ...o, id }));
  const sorted = orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 50);
  return res.json({ success: true, count: sorted.length, orders: sorted });
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
  let cleared = 0;
  for (const [id, order] of inMemoryOrders.entries()) {
    if (order.status === 'completed' || order.status === 'cancelled') {
      inMemoryOrders.delete(id);
      cleared++;
    }
  }
  saveOrdersToCache();
  console.log(`🧹 [PAINEL] Fila limpa: ${cleared} pedidos finalizados removidos.`);
  return res.json({ success: true, cleared, remaining: inMemoryOrders.size });
});

app.delete('/api/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  const existed = inMemoryOrders.has(orderId);
  if (existed) inMemoryOrders.delete(orderId);
  saveOrdersToCache();
  return res.json({ success: existed, message: existed ? `Pedido ${orderId} removido.` : 'Pedido não encontrado.' });
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
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(150).get();
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

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = now.toISOString().slice(0, 7);

    // Vendas concluídas
    const completed = all.filter(o => o.status === 'completed' || o.success === true);

    // Vendas de hoje
    const todaySales = completed.filter(o => (o.createdAt || o.completedAt || '').startsWith(todayStr));
    const todayTotalMt = todaySales.reduce((acc, o) => acc + (Number(o.valor_pago || o.valor) || 0), 0);
    const todayTotalMb = todaySales.reduce((acc, o) => acc + (Number(o.quantidade) || 0), 0);

    // Vendas do mês
    const monthSales = completed.filter(o => (o.createdAt || o.completedAt || '').startsWith(monthStr));
    const monthTotalMt = monthSales.reduce((acc, o) => acc + (Number(o.valor_pago || o.valor) || 0), 0);
    const monthTotalMb = monthSales.reduce((acc, o) => acc + (Number(o.quantidade) || 0), 0);

    // Valores recebidos via SMS (M-Pesa vs e-Mola)
    let payments = Array.from(inMemoryPayments.values());
    if (db) {
      try {
        const snapP = await db.collection('sms_payments').orderBy('processedAt', 'desc').limit(150).get();
        const fbP = snapP.docs.map(d => ({ id: d.id, ...d.data() }));
        const mapP = new Map();
        payments.forEach(p => mapP.set(p.txn_id || p.id, p));
        fbP.forEach(p => {
          const tid = p.txn_id || p.id;
          if (tid) mapP.set(tid, { ...(mapP.get(tid) || {}), ...p });
        });
        payments = Array.from(mapP.values());
      } catch(err) {}
    }

    let mpesaTotal = 0;
    let emolaTotal = 0;
    payments.forEach(p => {
      const val = Number(p.valor) || 0;
      if (String(p.metodo || '').toLowerCase().includes('emola')) {
        emolaTotal += val;
      } else {
        mpesaTotal += val;
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
        total_mt: mpesaTotal + emolaTotal,
        total_sms: payments.length
      },
      recentSales: completed.slice(-50).reverse(),
      allSales: all.slice(-100).reverse(),
      recentPayments: payments.slice(-50).reverse()
    });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── GESTÃO DE GRUPOS WHATSAPP ──
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
    
    const orderDoc = {
      ...order,
      id: order.orderId,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    inMemoryOrders.set(order.orderId, orderDoc);
    saveOrdersToCache();

    // Roteamento Estrito de Portas:
    // - 8023: Diários (24hrs)
    // - 8077: Semanais, Mensais e Ilimitados
    // - 8777: Saldo
    const targetPort = getPortForModo(order.modo);
    orderDoc.targetPort = targetPort;

    const dev = inMemoryDevices[targetPort];

    if (isDeviceApto(dev)) {
      orderDoc.status = 'assigned';
      orderDoc.assignedToPort = targetPort;
      dev.pending_order = {
        id: order.orderId,
        orderId: order.orderId,
        numero: order.numero,
        quantidade: order.quantidade,
        modo: order.modo || 'diario',
        jid: order.jid,
        timestamp: Date.now()
      };
      console.log(`🚀 [WHATSAPP NUVEM] Ordem entregue com exclusividade ao Celular Apto ${targetPort} (Modo: ${order.modo || 'diario'})`);
    } else {
      orderDoc.status = 'pending';
      console.log(`⏳ [WHATSAPP NUVEM] Celular Porta ${targetPort} (Modo: ${order.modo || 'diario'}) ocupado, sem saldo ou no limite. Ordem mantida na fila exclusiva da porta ${targetPort}.`);
    }
  }, db);
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
    const { txn_id, valor, remetente, metodo, raw_sms, timestamp } = req.body;

    if (!txn_id || !valor || !remetente) {
      return res.status(400).json({
        success: false,
        mensagem: 'Campos obrigatórios: txn_id, valor, remetente'
      });
    }

    // Anti-fraude: verificar duplicação
    if (inMemoryPayments.has(txn_id)) {
      console.warn(`⚠️ [SMS PAYMENT] Transação duplicada ignorada: ${txn_id}`);
      return res.json({
        success: false,
        duplicado: true,
        mensagem: `Transação ${txn_id} já foi processada`
      });
    }

    // Limpar cache se crescer demais
    if (inMemoryPayments.size > 1000) {
      const firstKey = inMemoryPayments.keys().next().value;
      inMemoryPayments.delete(firstKey);
    }

    // Guardar como processado
    inMemoryPayments.set(txn_id, {
      txn_id,
      valor,
      remetente,
      metodo: metodo || 'mpesa',
      processedAt: new Date().toISOString()
    });

    // Validar imediatamente pedidos de clientes que estejam no status "Aguardando Comprovativo da Operadora"
    if (baileysEngine && typeof baileysEngine.registrarSmsPayment === 'function') {
      baileysEngine.registrarSmsPayment({ txn_id, valor, remetente, metodo: metodo || 'mpesa', raw_sms });
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

// Listar pagamentos já processados (debug)
app.get('/api/sms/payments', (req, res) => {
  const list = [...inMemoryPayments.values()];
  return res.json({ success: true, count: list.length, payments: list.slice(-50) });
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

