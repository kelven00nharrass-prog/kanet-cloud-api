const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

class OrderDispatcher {
  /**
   * Despacha um pedido de transferência para o Firebase
   */
  async dispatchTransfer(params) {
    const db = getDb();
    const {
      numero,
      quantidade,
      modo = 'data',
      porta = null,
      remetente = 'API',
      request_id = null
    } = params;

    const orderId = request_id || `ORD-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const timestamp = new Date().toISOString();

    const orderDoc = {
      orderId,
      numero: String(numero).replace(/\D/g, ''),
      quantidade: Number(quantidade) || 0,
      modo,
      targetPort: porta ? Number(porta) : null,
      remetente,
      status: 'pending', // pending -> processing -> completed / failed
      createdAt: timestamp,
      updatedAt: timestamp,
      result: null
    };

    if (db) {
      await db.collection('orders').doc(orderId).set(orderDoc);
      console.log(`📡 [DISPATCHER] Pedido criado no Firestore: ${orderId} (${quantidade}MB para ${numero})`);
    } else {
      console.log(`⚠️ [DISPATCHER-LOCAL] Firestore indisponível. Pedido mock: ${orderId}`);
    }

    return {
      success: true,
      status: 'sucesso',
      processing: true,
      orderId,
      message: 'Pedido despachado para a fila da nuvem'
    };
  }

  /**
   * Consulta o estado de um pedido
   */
  async getOrderStatus(orderId) {
    const db = getDb();
    if (!db) {
      return { status: 'mock', orderId, message: 'Firebase não configurado' };
    }

    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) {
      return null;
    }

    return doc.data();
  }

  /**
   * Lista todos os dispositivos e seus status atuais
   */
  async getDevicesStatus() {
    const db = getDb();
    if (!db) {
      return [];
    }

    const snapshot = await db.collection('devices').get();
    const devices = [];
    snapshot.forEach(doc => {
      devices.push({ id: doc.id, ...doc.data() });
    });
    return devices;
  }

  /**
   * Atualiza o estado de um dispositivo (relatado pelo celular Android)
   */
  async updateDeviceStatus(port, data) {
    const db = getDb();
    if (!db) return false;

    const docRef = db.collection('devices').doc(String(port));
    await docRef.set({
      ...data,
      porta: Number(port),
      lastSeen: new Date().toISOString()
    }, { merge: true });

    return true;
  }
}

module.exports = new OrderDispatcher();
