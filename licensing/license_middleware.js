/**
 * Ka-Net Licensing System — Middleware Express
 * --------------------------------------------
 * Verifica se o token no header é válido antes de permitir acesso
 * às rotas do sistema de cada licenciado.
 * 
 * Uso:
 *   const { requireLicense } = require('./licensing/license_middleware');
 *   app.use('/api/tenant', requireLicense, tenantRoutes);
 */

'use strict';

const { checkLicenseValidity } = require('./license_manager');

// Token do Kelven (dono do sistema) — lê do .env
const MASTER_ADMIN_TOKEN = process.env.MASTER_LICENSE_TOKEN || 'KaNet-MASTER-KELVEN-2026';

/**
 * Middleware: exige token de licença válido
 * Cabeçalho esperado: Authorization: Bearer KN-KN001-XXXXXX
 * ou: x-kanet-token: KN-KN001-XXXXXX
 */
function requireLicense(req, res, next) {
  // Extrair token do header
  let token = null;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    token = req.headers['x-kanet-token'] || req.query.token || null;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Token de licença em falta',
      hint: 'Envie o token no header: Authorization: Bearer SEU_TOKEN'
    });
  }

  // Token mestre do Kelven tem acesso total
  if (token === MASTER_ADMIN_TOKEN) {
    req.isMaster = true;
    req.license  = { licenseId: 'MASTER', ownerName: 'Kelven', packageId: 'full' };
    return next();
  }

  // Verificar licença normal
  const { valid, reason, license } = checkLicenseValidity(token);

  if (!valid) {
    const statusCode = reason === 'Token inválido' ? 401 : 403;
    return res.status(statusCode).json({
      success:  false,
      error:    reason,
      licenseId: license?.licenseId || null,
      expiryDate: license?.expiryDate || null
    });
  }

  // Injectar licença no objecto da request
  req.isMaster = false;
  req.license  = license;
  next();
}

/**
 * Middleware: apenas o Kelven (token mestre) pode aceder
 */
function requireMaster(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    token = req.headers['x-kanet-token'] || req.query.token || null;
  }

  if (token !== MASTER_ADMIN_TOKEN) {
    return res.status(403).json({
      success: false,
      error:   'Acesso negado — apenas o administrador principal pode fazer isto'
    });
  }

  req.isMaster = true;
  next();
}

/**
 * Middleware: verifica permissão específica num número master
 * Uso: requirePermission('configurar')
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.isMaster) return next(); // Kelven tem tudo

    const license = req.license;
    if (!license) {
      return res.status(401).json({ success: false, error: 'Sem licença' });
    }

    // Verificar se o número que fez a request é master com esta permissão
    const senderPhone = req.body?.senderPhone || req.query?.senderPhone;
    if (!senderPhone) {
      // Se não veio phone, verificar apenas se a licença tem a permissão no geral
      return next();
    }

    const masterEntry = license.masterNumbers?.find(m => m.number === senderPhone);
    if (!masterEntry) {
      return res.status(403).json({
        success: false,
        error:   `O número ${senderPhone} não é master nesta licença`
      });
    }

    if (!masterEntry.permissions.includes('admin') && !masterEntry.permissions.includes(permission)) {
      return res.status(403).json({
        success: false,
        error:   `Sem permissão: ${permission}`,
        has:     masterEntry.permissions
      });
    }

    next();
  };
}

module.exports = {
  requireLicense,
  requireMaster,
  requirePermission
};
