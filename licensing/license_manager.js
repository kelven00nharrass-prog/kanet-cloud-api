/**
 * Ka-Net Licensing System — Gestor de Licenças
 * ---------------------------------------------
 * Lê e grava licenças num ficheiro JSON local.
 * Não afecta nenhum ficheiro do sistema actual.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPackage, isValidPackage } = require('./packages');

const DB_PATH = path.join(__dirname, 'data', 'licenses.json');

// ─── Helpers de I/O ────────────────────────────────────────────────────────

function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { licenses: [], _meta: { version: '1.0' } };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// ─── Gerador de Token ───────────────────────────────────────────────────────

function generateToken(tenantId) {
  const rand = uuidv4().split('-')[0].toUpperCase();
  return `KN-${tenantId.toUpperCase()}-${rand}`;
}

// ─── Gerador de ID incremental ──────────────────────────────────────────────

function nextLicenseId(db) {
  const ids = db.licenses.map(l => parseInt(l.numericId || 0, 10));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  const next = max + 1;
  return {
    numericId: next,
    licenseId: `KN${String(next).padStart(3, '0')}`
  };
}

// ─── CREATE ─────────────────────────────────────────────────────────────────

/**
 * Cria uma nova licença
 * @param {Object} opts
 * @param {string} opts.ownerName       - Nome do licenciado
 * @param {string} opts.ownerPhone      - Número de telefone (ex: 258841234567)
 * @param {string} opts.packageId       - ID do pacote (revendedor_basico, etc.)
 * @param {number} opts.durationDays    - Duração em dias (padrão: 30)
 * @param {Array}  opts.masterNumbers   - Números master [{number, permissions:[]}]
 * @param {Object} opts.portMapping     - Mapeamento de portas (só pacote FULL)
 * @returns {Object} licença criada
 */
function createLicense(opts) {
  const {
    ownerName,
    ownerPhone,
    packageId,
    durationDays = 30,
    masterNumbers = [],
    portMapping = {}
  } = opts;

  if (!ownerName || !ownerPhone || !packageId) {
    throw new Error('ownerName, ownerPhone e packageId são obrigatórios');
  }

  if (!isValidPackage(packageId)) {
    throw new Error(`Pacote inválido: ${packageId}`);
  }

  const pkg = getPackage(packageId);
  const db  = readDB();
  const { numericId, licenseId } = nextLicenseId(db);

  const now    = new Date();
  const expiry = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const license = {
    licenseId,
    numericId,
    ownerName,
    ownerPhone,
    packageId,
    packageName: pkg.name,
    status: 'active',          // active | expired | suspended | trial
    startDate:  now.toISOString(),
    expiryDate: expiry.toISOString(),
    durationDays,
    masterToken: generateToken(licenseId),
    masterNumbers: masterNumbers.map(m => ({
      number:      m.number,
      permissions: m.permissions || ['admin']
    })),
    portMapping: pkg.portMapping ? portMapping : {},
    whatsappSessions: [],      // sessões WA conectadas
    createdAt:    now.toISOString(),
    updatedAt:    now.toISOString(),
    lastHeartbeat: null,
    notes: ''
  };

  db.licenses.push(license);
  writeDB(db);

  return license;
}

// ─── READ ────────────────────────────────────────────────────────────────────

function getAllLicenses() {
  return readDB().licenses;
}

function getLicenseById(licenseId) {
  const db = readDB();
  return db.licenses.find(l => l.licenseId === licenseId) || null;
}

function getLicenseByToken(token) {
  const db = readDB();
  return db.licenses.find(l => l.masterToken === token) || null;
}

function getLicenseByPhone(phone) {
  const db = readDB();
  return db.licenses.find(l => l.ownerPhone === phone) || null;
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────

function updateLicense(licenseId, changes) {
  const db = readDB();
  const idx = db.licenses.findIndex(l => l.licenseId === licenseId);
  if (idx === -1) throw new Error(`Licença ${licenseId} não encontrada`);

  // Campos protegidos que não podem ser alterados directamente
  const protected_ = ['licenseId', 'numericId', 'masterToken', 'createdAt'];
  protected_.forEach(f => delete changes[f]);

  db.licenses[idx] = {
    ...db.licenses[idx],
    ...changes,
    updatedAt: new Date().toISOString()
  };

  writeDB(db);
  return db.licenses[idx];
}

// ─── RENOVAR ─────────────────────────────────────────────────────────────────

function renewLicense(licenseId, durationDays = 30) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  // Se já expirou, renovar a partir de agora; senão, adicionar ao prazo actual
  const base = (lic.status === 'expired' || new Date(lic.expiryDate) < new Date())
    ? new Date()
    : new Date(lic.expiryDate);

  const newExpiry = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

  return updateLicense(licenseId, {
    status:     'active',
    expiryDate: newExpiry.toISOString(),
    durationDays
  });
}

// ─── SUSPENDER / ACTIVAR ─────────────────────────────────────────────────────

function suspendLicense(licenseId, reason = '') {
  return updateLicense(licenseId, { status: 'suspended', notes: reason });
}

function activateLicense(licenseId) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);
  // Só activa se ainda não expirou
  if (new Date(lic.expiryDate) < new Date()) {
    throw new Error('Licença expirada — renove primeiro');
  }
  return updateLicense(licenseId, { status: 'active' });
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

function deleteLicense(licenseId) {
  const db = readDB();
  const idx = db.licenses.findIndex(l => l.licenseId === licenseId);
  if (idx === -1) throw new Error(`Licença ${licenseId} não encontrada`);
  const removed = db.licenses.splice(idx, 1)[0];
  writeDB(db);
  return removed;
}

// ─── HEARTBEAT ───────────────────────────────────────────────────────────────

function updateHeartbeat(licenseId) {
  return updateLicense(licenseId, { lastHeartbeat: new Date().toISOString() });
}

// ─── VERIFICAÇÃO DE VALIDADE ─────────────────────────────────────────────────

/**
 * Verifica se uma licença é válida neste momento
 * @returns {{ valid: boolean, reason: string, license: Object|null }}
 */
function checkLicenseValidity(token) {
  const lic = getLicenseByToken(token);

  if (!lic) {
    return { valid: false, reason: 'Token inválido', license: null };
  }

  if (lic.status === 'suspended') {
    return { valid: false, reason: 'Licença suspensa', license: lic };
  }

  if (new Date(lic.expiryDate) < new Date()) {
    // Marcar como expirado se ainda não estava
    if (lic.status !== 'expired') {
      updateLicense(lic.licenseId, { status: 'expired' });
      lic.status = 'expired';
    }
    return { valid: false, reason: 'Licença expirada', license: lic };
  }

  if (lic.status !== 'active') {
    return { valid: false, reason: `Estado inválido: ${lic.status}`, license: lic };
  }

  return { valid: true, reason: 'OK', license: lic };
}

// ─── NÚMEROS MASTER ──────────────────────────────────────────────────────────

function addMasterNumber(licenseId, number, permissions = ['admin']) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  const existing = lic.masterNumbers.find(m => m.number === number);
  if (existing) throw new Error(`Número ${number} já é master nesta licença`);

  lic.masterNumbers.push({ number, permissions });
  return updateLicense(licenseId, { masterNumbers: lic.masterNumbers });
}

function removeMasterNumber(licenseId, number) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  const filtered = lic.masterNumbers.filter(m => m.number !== number);
  return updateLicense(licenseId, { masterNumbers: filtered });
}

function updateMasterPermissions(licenseId, number, permissions) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  const masters = lic.masterNumbers.map(m =>
    m.number === number ? { ...m, permissions } : m
  );
  return updateLicense(licenseId, { masterNumbers: masters });
}

// ─── SESSÕES WHATSAPP ────────────────────────────────────────────────────────

function registerWhatsappSession(licenseId, sessionId, phone) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  const pkg = getPackage(lic.packageId);
  const max = pkg.maxWhatsapps;

  // Verificar limite (se não for ilimitado)
  if (max !== -1 && lic.whatsappSessions.length >= max) {
    throw new Error(`Limite de ${max} WhatsApp(s) atingido para este pacote`);
  }

  const already = lic.whatsappSessions.find(s => s.sessionId === sessionId);
  if (already) return lic; // já registado

  lic.whatsappSessions.push({
    sessionId,
    phone,
    connectedAt: new Date().toISOString(),
    status: 'connected'
  });

  return updateLicense(licenseId, { whatsappSessions: lic.whatsappSessions });
}

function unregisterWhatsappSession(licenseId, sessionId) {
  const lic = getLicenseById(licenseId);
  if (!lic) throw new Error(`Licença ${licenseId} não encontrada`);

  const sessions = lic.whatsappSessions.filter(s => s.sessionId !== sessionId);
  return updateLicense(licenseId, { whatsappSessions: sessions });
}

// ─── ESTATÍSTICAS ────────────────────────────────────────────────────────────

function getStats() {
  const all = getAllLicenses();
  const now = new Date();

  return {
    total:     all.length,
    active:    all.filter(l => l.status === 'active' && new Date(l.expiryDate) > now).length,
    expired:   all.filter(l => l.status === 'expired' || new Date(l.expiryDate) <= now).length,
    suspended: all.filter(l => l.status === 'suspended').length,
    byPackage: {
      revendedor_basico: all.filter(l => l.packageId === 'revendedor_basico').length,
      revendedor_pro:    all.filter(l => l.packageId === 'revendedor_pro').length,
      fornecedor:        all.filter(l => l.packageId === 'fornecedor').length,
      full:              all.filter(l => l.packageId === 'full').length
    },
    revenueMonthly: all
      .filter(l => l.status === 'active')
      .reduce((sum, l) => {
        const pkg = getPackage(l.packageId);
        return sum + (pkg ? pkg.price : 0);
      }, 0)
  };
}

module.exports = {
  createLicense,
  getAllLicenses,
  getLicenseById,
  getLicenseByToken,
  getLicenseByPhone,
  updateLicense,
  renewLicense,
  suspendLicense,
  activateLicense,
  deleteLicense,
  updateHeartbeat,
  checkLicenseValidity,
  addMasterNumber,
  removeMasterNumber,
  updateMasterPermissions,
  registerWhatsappSession,
  unregisterWhatsappSession,
  getStats
};
