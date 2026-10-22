/**
 * Ka-Net Licensing System — Verificador de Expiração (Heartbeat)
 * --------------------------------------------------------------
 * Corre a cada hora e verifica licenças expiradas.
 * Quando expira: muda status para 'expired' e notifica via log.
 * 
 * No futuro: enviar notificação WhatsApp ao licenciado.
 */

'use strict';

const { getAllLicenses, updateLicense, checkLicenseValidity } = require('./license_manager');

let checkerInterval = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const WARN_BEFORE_MS    = 3 * 24 * 60 * 60 * 1000; // Avisar 3 dias antes

/**
 * Executa uma verificação de todas as licenças
 */
function runCheck() {
  const now = new Date();
  const licenses = getAllLicenses();
  let expiredCount = 0;
  let warningCount = 0;

  for (const lic of licenses) {
    if (lic.status === 'suspended') continue;

    const expiry = new Date(lic.expiryDate);
    const msLeft = expiry - now;

    // ── Já expirou ──────────────────────────────────────────────
    if (msLeft <= 0 && lic.status !== 'expired') {
      updateLicense(lic.licenseId, { status: 'expired' });
      expiredCount++;
      console.log(`[KaNet-License] ❌ EXPIRADA: ${lic.licenseId} (${lic.ownerName}) — ${lic.ownerPhone}`);

      // TODO: Notificar o licenciado via WhatsApp
      // TODO: Bloquear o processo PM2 deste licenciado
      continue;
    }

    // ── Vai expirar em breve ─────────────────────────────────────
    if (msLeft > 0 && msLeft <= WARN_BEFORE_MS && lic.status === 'active') {
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      warningCount++;
      console.log(`[KaNet-License] ⚠️  AVISO: ${lic.licenseId} (${lic.ownerName}) expira em ${daysLeft} dia(s)`);

      // TODO: Enviar aviso de renovação ao licenciado via WhatsApp
    }
  }

  if (expiredCount > 0 || warningCount > 0) {
    console.log(`[KaNet-License] Verificação concluída: ${expiredCount} expiradas, ${warningCount} a expirar em breve`);
  }

  return { expiredCount, warningCount, total: licenses.length, checkedAt: now.toISOString() };
}

/**
 * Inicia o verificador automático
 */
function startChecker() {
  if (checkerInterval) {
    console.log('[KaNet-License] Verificador já está a correr.');
    return;
  }

  console.log('[KaNet-License] ✅ Verificador de licenças iniciado (intervalo: 1 hora)');

  // Verificar imediatamente ao arrancar
  runCheck();

  // Depois verificar a cada hora
  checkerInterval = setInterval(() => {
    runCheck();
  }, CHECK_INTERVAL_MS);

  // Não bloquear o processo Node.js
  if (checkerInterval.unref) checkerInterval.unref();
}

/**
 * Para o verificador
 */
function stopChecker() {
  if (checkerInterval) {
    clearInterval(checkerInterval);
    checkerInterval = null;
    console.log('[KaNet-License] Verificador parado.');
  }
}

/**
 * Verifica uma licença específica por token (para uso no middleware)
 */
function verifyToken(token) {
  return checkLicenseValidity(token);
}

module.exports = {
  startChecker,
  stopChecker,
  runCheck,
  verifyToken
};
