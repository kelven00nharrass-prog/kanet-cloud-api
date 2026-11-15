/**
 * axion_redis.js — Camada de Persistência Redis (Upstash)
 * Mantém todos os dados (pedidos, pagamentos, planos) persistidos na nuvem.
 * Se Redis não estiver disponível, funciona em modo degradado com zero crashes.
 */

const { Redis } = require('@upstash/redis');

// Chaves Redis
const REDIS_KEYS = {
  ORDERS: 'axion:orders',       // Hash { orderId: JSON }
  PAYMENTS: 'axion:payments',   // Hash { id: JSON }
  PLANS: 'axion:plans',         // Hash { planId: JSON }
  CUSTOMERS: 'axion:customers', // Hash { phone: JSON }
};

let redis = null;
let redisAvailable = false;

// Inicializar Redis (só se as variáveis de ambiente existirem)
async function initRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn('⚠️  [REDIS] Variáveis UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN não definidas. Operando sem Redis.');
    redisAvailable = false;
    return false;
  }

  try {
    redis = new Redis({ url, token });
    redisAvailable = true;
    console.log('✅ [REDIS] Upstash Redis conectado com sucesso!');
    return true;
  } catch (e) {
    console.error('❌ [REDIS] Falha ao conectar:', e.message);
    redisAvailable = false;
    return false;
  }
}

function isRedisAvailable() {
  return redisAvailable;
}

// ── ORDENS ────────────────────────────────────────────────────────────────────

async function saveOrder(orderId, orderDoc) {
  if (!redisAvailable || !redis) return;
  try {
    const id = orderId || (orderDoc && (orderDoc.orderId || orderDoc.id));
    if (id && orderDoc) {
      await redis.hset(REDIS_KEYS.ORDERS, { [id]: JSON.stringify(orderDoc) });
    }
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar ordem:', e.message);
  }
}

async function loadAllOrders(targetMap = null) {
  if (!redisAvailable || !redis) return [];
  try {
    const all = await redis.hgetall(REDIS_KEYS.ORDERS);
    if (!all) return [];
    const list = [];
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        list.push(doc);
        if (targetMap && typeof targetMap.set === 'function') {
          targetMap.set(id, doc);
        }
      } catch (_) {}
    }
    console.log(`📦 [REDIS] ${list.length} ordens restauradas do Redis.`);
    return list;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar ordens:', e.message);
    return [];
  }
}

async function saveAllOrders(input) {
  if (!redisAvailable || !redis || !input) return;
  try {
    const obj = {};
    if (input instanceof Map) {
      for (const [id, doc] of input.entries()) {
        obj[id] = JSON.stringify(doc);
      }
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (!item) continue;
        const id = item.orderId || item.id || (Array.isArray(item) ? item[0] : null);
        const doc = Array.isArray(item) ? item[1] : item;
        if (id && doc) obj[id] = JSON.stringify(doc);
      }
    }
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      await redis.hset(REDIS_KEYS.ORDERS, obj);
      console.log(`💾 [REDIS] ${keys.length} ordens sincronizadas.`);
    }
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar ordens:', e.message);
  }
}

// ── PAGAMENTOS ────────────────────────────────────────────────────────────────

async function savePayment(paymentDoc) {
  if (!redisAvailable || !redis || !paymentDoc) return;
  try {
    const id = paymentDoc.id || paymentDoc.ref || paymentDoc.referencia || `PAY-${Date.now()}`;
    await redis.hset(REDIS_KEYS.PAYMENTS, { [id]: JSON.stringify(paymentDoc) });
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar pagamento:', e.message);
  }
}

async function loadAllPayments(targetArray = null) {
  if (!redisAvailable || !redis) return [];
  try {
    const all = await redis.hgetall(REDIS_KEYS.PAYMENTS);
    if (!all) return [];
    const list = [];
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        list.push(doc);
      } catch (_) {}
    }
    list.sort((a, b) => new Date(b.timestamp || b.data || 0) - new Date(a.timestamp || a.data || 0));
    if (targetArray && Array.isArray(targetArray)) {
      const existingIds = new Set(targetArray.map(p => p.id || p.ref || p.referencia));
      for (const p of list) {
        const pid = p.id || p.ref || p.referencia;
        if (!existingIds.has(pid)) {
          targetArray.push(p);
          existingIds.add(pid);
        }
      }
    }
    if (list.length > 0) console.log(`📦 [REDIS] ${list.length} pagamentos restaurados do Redis.`);
    return list;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar pagamentos:', e.message);
    return [];
  }
}

async function saveAllPayments(input) {
  if (!redisAvailable || !redis || !input) return;
  try {
    const obj = {};
    const arr = Array.isArray(input) ? input : (input instanceof Map ? Array.from(input.values()) : []);
    for (const p of arr) {
      if (!p) continue;
      const id = p.id || p.ref || p.referencia || (p.orderId ? `PAY-${p.orderId}` : null);
      if (id) obj[id] = JSON.stringify(p);
    }
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      await redis.hset(REDIS_KEYS.PAYMENTS, obj);
      console.log(`💾 [REDIS] ${keys.length} pagamentos sincronizados.`);
    }
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar pagamentos:', e.message);
  }
}

// ── PLANOS AGENDADOS ──────────────────────────────────────────────────────────

async function savePlan(planId, planDoc) {
  if (!redisAvailable || !redis || !planDoc) return;
  try {
    const id = planId || planDoc.planId || planDoc.id;
    if (id) await redis.hset(REDIS_KEYS.PLANS, { [id]: JSON.stringify(planDoc) });
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao salvar plano:', e.message);
  }
}

async function deletePlan(planId) {
  if (!redisAvailable || !redis || !planId) return;
  try {
    await redis.hdel(REDIS_KEYS.PLANS, planId);
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao apagar plano:', e.message);
  }
}

async function loadAllPlans(targetMap = null) {
  if (!redisAvailable || !redis) return [];
  try {
    const all = await redis.hgetall(REDIS_KEYS.PLANS);
    if (!all) return [];
    const list = [];
    for (const [id, val] of Object.entries(all)) {
      try {
        const doc = typeof val === 'string' ? JSON.parse(val) : val;
        list.push(doc);
        if (targetMap && typeof targetMap.set === 'function') {
          if (doc.status === 'ativo' && !targetMap.has(id)) {
            targetMap.set(id, doc);
          }
        }
      } catch (_) {}
    }
    if (list.length > 0) console.log(`📦 [REDIS] ${list.length} planos agendados restaurados do Redis.`);
    return list;
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao carregar planos:', e.message);
    return [];
  }
}

async function saveAllPlans(input) {
  if (!redisAvailable || !redis || !input) return;
  try {
    const obj = {};
    if (input instanceof Map) {
      for (const [id, doc] of input.entries()) {
        obj[id] = JSON.stringify(doc);
      }
    } else if (Array.isArray(input)) {
      for (const doc of input) {
        if (!doc) continue;
        const id = doc.planId || doc.id;
        if (id) obj[id] = JSON.stringify(doc);
      }
    }
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      await redis.hset(REDIS_KEYS.PLANS, obj);
      console.log(`💾 [REDIS] ${keys.length} planos sincronizados.`);
    }
  } catch (e) {
    console.warn('⚠️  [REDIS] Falha ao sincronizar planos:', e.message);
  }
}

// ── UTILIDADE ─────────────────────────────────────────────────────────────────

async function testConnection() {
  if (!redisAvailable || !redis) return false;
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
