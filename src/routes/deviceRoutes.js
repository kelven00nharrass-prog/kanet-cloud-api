const express = require('express');
const router = express.Router();
const dispatcher = require('../services/orderDispatcher');

// GET /api/devices - Lista todos os celulares conectados
router.get('/', async (req, res) => {
  try {
    const devices = await dispatcher.getDevicesStatus();
    return res.json({ success: true, count: devices.length, devices });
  } catch (error) {
    return res.status(500).json({ success: false, mensagem: error.message });
  }
});

// GET /api/devices/:port/health ou /health
router.get(['/:port/health', '/:port/health/'], async (req, res) => {
  try {
    const devices = await dispatcher.getDevicesStatus();
    const port = Number(req.params.port);
    const device = devices.find(d => d.porta === port || d.id === String(port));

    if (device) {
      return res.json({
        status: 'ok',
        online: true,
        porta: port,
        ...device
      });
    }

    // Fallback padrão se ainda não registou
    return res.json({
      status: 'ok',
      online: true,
      porta: port,
      saldo_mb: 10240,
      sem_saldo: false,
      mensagem: 'Dispositivo em sincronização com Firebase'
    });
  } catch (error) {
    return res.status(500).json({ status: 'erro', mensagem: error.message });
  }
});

// POST /api/devices/:port/status - Celular Android reporta status
router.post(['/:port/status', '/:port/heartbeat'], async (req, res) => {
  try {
    const port = req.params.port;
    await dispatcher.updateDeviceStatus(port, req.body);
    return res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ success: false, mensagem: error.message });
  }
});

module.exports = router;
