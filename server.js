require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initFirebase } = require('./config/firebase');

const transferRoutes = require('./routes/transferRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();
const PORT = process.env.PORT || 3333;
const MASTER_TOKENS = new Set([
  process.env.MASTER_TOKEN || 'KaNetKelven2026Secure',
  'GitoAquinoMasterToken2025'
]);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log básico de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Endpoint de Saúde para o Render / UptimeRobot
app.get(['/health', '/', '/status'], (req, res) => {
  res.json({
    status: 'online',
    service: 'Ka-Net Cloud API (Render + Firebase)',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Middleware de Autenticação (opcional para webhooks e health)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader) return next(); // Permite tráfego local/dashboard

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (MASTER_TOKENS.has(token)) {
    return next();
  }
  next();
});

// Rotas
app.use('/api', transferRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/webhooks', webhookRoutes);

// Compatibilidade direta com endpoints legados do Bot
app.use('/transferir-dados', transferRoutes);

// Inicializar Firebase e Servidor
initFirebase();

app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================================');
  console.log(`🚀 [KA-NET CLOUD API] Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Ambiente: ${process.env.NODE_ENV || 'production'}`);
  console.log(`📡 URL Local: http://127.0.0.1:${PORT}`);
  console.log('==================================================================');
});

