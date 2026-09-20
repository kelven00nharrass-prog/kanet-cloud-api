const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let db = null;
let isInitialized = false;

function initFirebase() {
  if (isInitialized) return db;

  try {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      const localKeyPath = path.resolve(__dirname, '../../serviceAccountKey.json');
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
      isInitialized = true;
      console.log('🔥 [FIREBASE] Inicializado com sucesso no projeto:', serviceAccount.project_id || 'ka-net-math');
    } else {
      console.warn('⚠️ [FIREBASE] Nenhuma credencial encontrada. Operando em modo de espera/mock.');
    }
  } catch (error) {
    console.error('❌ [FIREBASE] Erro ao inicializar:', error.message);
  }

  return db;
}

module.exports = {
  admin,
  initFirebase,
  getDb: () => db || initFirebase()
};
