/**
 * axion_redis.js — Camada de Persistência Redis (Upstash)
 * Mantém todos os dados (pedidos, pagamentos, planos) persistidos na nuvem.
 * Se Redis não estiver disponível, funciona em modo degradado (só memória).
 */

const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

// Chaves Redis
const REDIS_KEYS = {
  ORDERS: 'axion:orders',       // Hash { orderId: JSON }
  PAYMENTS: 'axion:payments',   // List de JSONs
  PLANS: 'axion:plans',         // Hash { planId: JSON }
  CUSTOMERS: 'axion:customers', // Hash { phone: JSON }
};

let redis = null;
let redisAvailable = false;

// Inicializar Redis (só se as variáveis de ambiente existirem)
function initRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn('⚠️  [REDIS] Variáveis UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN não definidas. Operando sem Redis.');
    return false;
  }

  try {
    redis = new Redis({ url, token });
    redisAvailable = true;
    console.log('✅ [REDIS] Upstash Redis conectado com sucesso!');
    return true;
  } catch (e) {
    console.error('❌ [REDIS] Falha ao conectar:', e.message);
    return false;
  }
}

// ── ORDENS ────────────────────────────────────────────────────────────────────

async function saveOrder(orderId, orderDoc) {
  if (!redisAvailable) return;
  try {
    await redis.hset(REDIS_KEYS.ORDERS, { [orderId]: JSON.stringify(orderDoc) });
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar ordem:', e.message);
  }
}

async function loadAllOrders(inMemoryOrdersMap) {
  if (!redisAvailable) return 0;
  try {
    const all = await redis.hgetall(REDIS_KEYS.ORDERS);
    if (!all) return 0;
    let count = 0;
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        if (!inMemoryOrdersMap.has(id)) {
          inMemoryOrdersMap.set(id, doc);
          count++;
        }
      } catch (_) {}
    }
    console.log(`📦 [REDIS] ${count} ordens restauradas do Redis.`);
    return count;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar ordens:', e.message);
    return 0;
  }
}

async function saveAllOrders(inMemoryOrdersMap) {
  if (!redisAvailable || inMemoryOrdersMap.size === 0) return;
  try {
    const obj = {};
    for (const [id, doc] of inMemoryOrdersMap.entries()) {
      obj[id] = JSON.stringify(doc);
    }
    await redis.hset(REDIS_KEYS.ORDERS, obj);
    console.log(`💾 [REDIS] ${inMemoryOrdersMap.size} ordens sincronizadas.`);
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar ordens:', e.message);
  }
}

// ── PAGAMENTOS ────────────────────────────────────────────────────────────────

async function savePayment(paymentDoc) {
  if (!redisAvailable) return;
  try {
    // Guardar como hash por ID para evitar duplicatas
    await redis.hset('axion:payments_map', { [paymentDoc.id || paymentDoc.ref]: JSON.stringify(paymentDoc) });
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar pagamento:', e.message);
  }
}

async function loadAllPayments(adminReceiptsArray) {
  if (!redisAvailable) return 0;
  try {
    const all = await redis.hgetall('axion:payments_map');
    if (!all) return 0;
    const existingIds = new Set(adminReceiptsArray.map(p => p.id || p.ref));
    let count = 0;
    const payments = [];
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        if (!existingIds.has(id)) {
          payments.push(doc);
          count++;
        }
      } catch (_) {}
    }
    // Ordenar por timestamp mais recente
    payments.sort((a, b) => {
      const ta = new Date(a.timestamp || a.data || 0).getTime();
      const tb = new Date(b.timestamp || b.data || 0).getTime();
      return tb - ta;
    });
    adminReceiptsArray.unshift(...payments);
    if (count > 0) console.log(`📦 [REDIS] ${count} pagamentos restaurados do Redis.`);
    return count;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar pagamentos:', e.message);
    return 0;
  }
}

async function saveAllPayments(adminReceiptsArray) {
  if (!redisAvailable || adminReceiptsArray.length === 0) return;
  try {
    const obj = {};
    for (const p of adminReceiptsArray) {
      const id = p.id || p.ref;
      if (id) obj[id] = JSON.stringify(p);
    }
    await redis.hset('axion:payments_map', obj);
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar pagamentos:', e.message);
  }
}

// ── PLANOS AGENDADOS ──────────────────────────────────────────────────────────

async function savePlan(planId, planDoc) {
  if (!redisAvailable) return;
  try {
    await redis.hset(REDIS_KEYS.PLANS, { [planId]: JSON.stringify(planDoc) });
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar plano:', e.message);
  }
}

async function deletePlan(planId) {
  if (!redisAvailable) return;
  try {
    await redis.hdel(REDIS_KEYS.PLANS, planId);
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao apagar plano:', e.message);
  }
}

async function loadAllPlans(scheduledPlansMap) {
  if (!redisAvailable) return 0;
  try {
    const all = await redis.hgetall(REDIS_KEYS.PLANS);
    if (!all) return 0;
    let count = 0;
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        if (doc.status === 'ativo' && !scheduledPlansMap.has(id)) {
          scheduledPlansMap.set(id, doc);
          count++;
        }
      } catch (_) {}
    }
    if (count > 0) console.log(`📦 [REDIS] ${count} planos agendados restaurados do Redis.`);
    return count;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar planos:', e.message);
    return 0;
  }
}

async function saveAllPlans(scheduledPlansMap) {
  if (!redisAvailable || scheduledPlansMap.size === 0) return;
  try {
    const obj = {};
    for (const [id, doc] of scheduledPlansMap.entries()) {
      obj[id] = JSON.stringify(doc);
    }
    await redis.hset(REDIS_KEYS.PLANS, obj);
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar planos:', e.message);
  }
}

// ── UTILIDADE ─────────────────────────────────────────────────────────────────

function isRedisAvailable() {
  return redisAvailable;
}

async function testConnection() {
  if (!redisAvailable) return false;
  try {
    await redis.set('axion:heartbeat', new Date().toISOString(), { ex: 300 });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  initRedis,
  isRedisAvailable,
  testConnection,
  saveOrder,
  loadAllOrders,
  saveAllOrders,
  savePayment,
  loadAllPayments,
  saveAllPayments,
  savePlan,
  deletePlan,
  loadAllPlans,
  saveAllPlans,
};
