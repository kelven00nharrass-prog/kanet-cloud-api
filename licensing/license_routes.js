/**
 * Ka-Net Licensing System — Rotas REST API
 * -----------------------------------------
 * Todas as rotas do sistema de licenciamento.
 * Montadas em /licensing/ no servidor principal.
 */

'use strict';

const express = require('express');
const path    = require('path');
const router  = express.Router();

// ─── Painel Admin (UI estática) ───────────────────────────────────────────────
router.use('/admin', express.static(path.join(__dirname, 'admin')));
router.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

const {
  createLicense, getAllLicenses, getLicenseById,
  getLicenseByToken, renewLicense, suspendLicense,
  activateLicense, deleteLicense, updateLicense,
  addMasterNumber, removeMasterNumber, updateMasterPermissions,
  registerWhatsappSession, unregisterWhatsappSession,
  getStats, checkLicenseValidity, updateHeartbeat
} = require('./license_manager');

const { requireMaster, requireLicense } = require('./license_middleware');
const { listPackages } = require('./packages');

// ─── Rota de teste ───────────────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ success: true, message: '🟢 Ka-Net Licensing API está online', ts: new Date().toISOString() });
});

// ─── Pacotes disponíveis (público) ───────────────────────────────────────────
router.get('/packages', (req, res) => {
  res.json({ success: true, packages: listPackages() });
});

// ─── Estatísticas (apenas Kelven) ────────────────────────────────────────────
router.get('/stats', requireMaster, (req, res) => {
  try {
    res.json({ success: true, stats: getStats() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Listar todas as licenças (apenas Kelven) ────────────────────────────────
router.get('/licenses', requireMaster, (req, res) => {
  try {
    const all = getAllLicenses();
    res.json({ success: true, count: all.length, licenses: all });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Criar licença (apenas Kelven) ───────────────────────────────────────────
router.post('/licenses', requireMaster, (req, res) => {
  try {
    const { ownerName, ownerPhone, packageId, durationDays, masterNumbers, portMapping } = req.body;
    const license = createLicense({ ownerName, ownerPhone, packageId, durationDays, masterNumbers, portMapping });
    res.status(201).json({ success: true, license });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Ver uma licença específica (apenas Kelven) ───────────────────────────────
router.get('/licenses/:id', requireMaster, (req, res) => {
  try {
    const lic = getLicenseById(req.params.id);
    if (!lic) return res.status(404).json({ success: false, error: 'Licença não encontrada' });
    res.json({ success: true, license: lic });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Renovar licença (apenas Kelven) ─────────────────────────────────────────
router.post('/licenses/:id/renew', requireMaster, (req, res) => {
  try {
    const { durationDays = 30 } = req.body;
    const lic = renewLicense(req.params.id, durationDays);
    res.json({ success: true, license: lic, message: `Licença renovada por ${durationDays} dias` });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Suspender licença (apenas Kelven) ───────────────────────────────────────
router.post('/licenses/:id/suspend', requireMaster, (req, res) => {
  try {
    const { reason = 'Suspensa pelo administrador' } = req.body;
    const lic = suspendLicense(req.params.id, reason);
    res.json({ success: true, license: lic });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Activar licença (apenas Kelven) ─────────────────────────────────────────
router.post('/licenses/:id/activate', requireMaster, (req, res) => {
  try {
    const lic = activateLicense(req.params.id);
    res.json({ success: true, license: lic });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Apagar licença (apenas Kelven) ──────────────────────────────────────────
router.delete('/licenses/:id', requireMaster, (req, res) => {
  try {
    const removed = deleteLicense(req.params.id);
    res.json({ success: true, removed, message: 'Licença eliminada' });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Actualizar notas / mapeamento de portas (apenas Kelven) ─────────────────
router.patch('/licenses/:id', requireMaster, (req, res) => {
  try {
    const lic = updateLicense(req.params.id, req.body);
    res.json({ success: true, license: lic });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rotas do LICENCIADO (usa o próprio token)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Ver dados da sua própria licença ────────────────────────────────────────
router.get('/me', requireLicense, (req, res) => {
  const lic = req.license;
  // Omitir token por segurança se não for o master
  const safe = { ...lic };
  if (!req.isMaster) delete safe.masterToken;
  res.json({ success: true, license: safe });
});

// ─── Heartbeat (bot envia a cada hora para confirmar que está vivo) ───────────
router.post('/heartbeat', requireLicense, (req, res) => {
  try {
    updateHeartbeat(req.license.licenseId);
    const now = new Date();
    const expiry = new Date(req.license.expiryDate);
    const msLeft = expiry - now;
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

    res.json({
      success: true,
      licenseId: req.license.licenseId,
      status: req.license.status,
      daysLeft: daysLeft > 0 ? daysLeft : 0,
      expiryDate: req.license.expiryDate
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Verificar validade rápida (sem dados sensíveis) ─────────────────────────
router.get('/verify', requireLicense, (req, res) => {
  const expiry = new Date(req.license.expiryDate);
  const msLeft = expiry - new Date();
  res.json({
    success:   true,
    valid:     true,
    licenseId: req.license.licenseId,
    package:   req.license.packageId,
    daysLeft:  Math.ceil(msLeft / (1000 * 60 * 60 * 24)),
    expiryDate: req.license.expiryDate
  });
});

// ─── Gerir números master da sua licença ─────────────────────────────────────
router.get('/me/masters', requireLicense, (req, res) => {
  res.json({ success: true, masterNumbers: req.license.masterNumbers });
});

router.post('/me/masters', requireLicense, (req, res) => {
  try {
    const { number, permissions } = req.body;
    if (!number) return res.status(400).json({ success: false, error: 'number é obrigatório' });
    const lic = addMasterNumber(req.license.licenseId, number, permissions);
    res.status(201).json({ success: true, masterNumbers: lic.masterNumbers });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.delete('/me/masters/:number', requireLicense, (req, res) => {
  try {
    const lic = removeMasterNumber(req.license.licenseId, req.params.number);
    res.json({ success: true, masterNumbers: lic.masterNumbers });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.patch('/me/masters/:number/permissions', requireLicense, (req, res) => {
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) return res.status(400).json({ success: false, error: 'permissions deve ser array' });
    const lic = updateMasterPermissions(req.license.licenseId, req.params.number, permissions);
    res.json({ success: true, masterNumbers: lic.masterNumbers });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Mapeamento de portas (pacote FULL) ──────────────────────────────────────
router.get('/me/port-mapping', requireLicense, (req, res) => {
  const pkg = require('./packages').getPackage(req.license.packageId);
  if (!pkg?.portMapping) {
    return res.status(403).json({ success: false, error: 'Mapeamento de portas apenas disponível no pacote FULL' });
  }
  res.json({ success: true, portMapping: req.license.portMapping });
});

router.put('/me/port-mapping', requireLicense, (req, res) => {
  try {
    const pkg = require('./packages').getPackage(req.license.packageId);
    if (!pkg?.portMapping) {
      return res.status(403).json({ success: false, error: 'Mapeamento de portas apenas disponível no pacote FULL' });
    }
    const { portMapping } = req.body;
    // Validar valores: apenas 'revenda', 'fornecimento', 'ambos'
    const valid = ['revenda', 'fornecimento', 'ambos'];
    for (const [port, type] of Object.entries(portMapping)) {
      if (!valid.includes(type)) {
        return res.status(400).json({ success: false, error: `Tipo inválido para porta ${port}: ${type}. Use: ${valid.join(', ')}` });
      }
    }
    const lic = updateLicense(req.license.licenseId, { portMapping });
    res.json({ success: true, portMapping: lic.portMapping });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── Sessões WhatsApp ─────────────────────────────────────────────────────────
router.get('/me/sessions', requireLicense, (req, res) => {
  res.json({ success: true, sessions: req.license.whatsappSessions });
});

router.post('/me/sessions', requireLicense, (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ success: false, error: 'sessionId e phone são obrigatórios' });
    const lic = registerWhatsappSession(req.license.licenseId, sessionId, phone);
    res.status(201).json({ success: true, sessions: lic.whatsappSessions });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.delete('/me/sessions/:sessionId', requireLicense, (req, res) => {
  try {
    const lic = unregisterWhatsappSession(req.license.licenseId, req.params.sessionId);
    res.json({ success: true, sessions: lic.whatsappSessions });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

module.exports = router;
