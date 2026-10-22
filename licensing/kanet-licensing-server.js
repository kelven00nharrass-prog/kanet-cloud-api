/**
 * Ka-Net Licensing System — Servidor Standalone
 * -----------------------------------------------
 * Corre na porta 3001 (separado do sistema actual na 3000).
 * 
 * Arrancar: node licensing/kanet-licensing-server.js
 * 
 * ⚠️ NÃO altera nenhum ficheiro do sistema actual.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const licenseRoutes  = require('./license_routes');
const { startChecker } = require('./license_checker');

const app  = express();
const PORT = process.env.LICENSING_PORT || 3001;

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Servir o Painel Admin ────────────────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Redirect raiz para admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/licensing', licenseRoutes);

// ─── Rota de saúde (health check) ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Ka-Net Licensing Server',
    version: '1.0.0',
    port:    PORT,
    uptime:  process.uptime(),
    ts:      new Date().toISOString()
  });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[KaNet-License] Erro:', err);
  res.status(500).json({ success: false, error: 'Erro interno do servidor' });
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🔐 Ka-Net Licensing Server v1.0.0    ║');
  console.log(`║   Porta: ${PORT}                           ║`);
  console.log(`║   Admin: http://localhost:${PORT}/admin     ║`);
  console.log(`║   API:   http://localhost:${PORT}/licensing ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Iniciar verificador de expiração (heartbeat)
  startChecker();
});

module.exports = app;
