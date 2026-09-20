const express = require('express');
const router = express.Router();
const dispatcher = require('../services/orderDispatcher');

// POST /api/transferir ou /transferir-dados
router.post(['/transferir', '/transferir-dados', '/transferir-dados/'], async (req, res) => {
  try {
    const { numero, quantidade, modo, remetente, porta, request_id } = req.body;

    if (!numero) {
      return res.status(400).json({
        success: false,
        status: 'erro',
        mensagem: 'Número de telefone é obrigatório'
      });
    }

    const result = await dispatcher.dispatchTransfer({
      numero,
      quantidade: quantidade || req.body.input_val,
      modo: modo || 'data',
      remetente: remetente || 'Bot',
      porta,
      request_id
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('❌ [API] Erro ao transferir:', error);
    return res.status(500).json({
      success: false,
      status: 'erro',
      mensagem: error.message
    });
  }
});

// GET /api/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await dispatcher.getOrderStatus(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, mensagem: 'Pedido não encontrado' });
    }
    return res.json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ success: false, mensagem: error.message });
  }
});

module.exports = router;
