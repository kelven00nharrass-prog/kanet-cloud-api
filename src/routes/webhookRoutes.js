const express = require('express');
const router = express.Router();
const dispatcher = require('../services/orderDispatcher');

// POST /api/webhooks/paymoz - Recebe confirmação de pagamento M-Pesa
router.post('/paymoz', async (req, res) => {
  try {
    const payload = req.body;
    console.log('💳 [WEBHOOK-PAYMOZ] Pagamento recebido:', JSON.stringify(payload));

    const { status, reference, amount, customer_phone, metadata } = payload;

    if (status === 'successful' || status === 'COMPLETED' || payload.success === true) {
      const targetPhone = customer_phone || (metadata && metadata.phone);
      const megas = (metadata && metadata.megas) || 1024;

      if (targetPhone) {
        console.log(`🚀 [WEBHOOK] Disparando transferência de ${megas}MB para ${targetPhone}`);
        await dispatcher.dispatchTransfer({
          numero: targetPhone,
          quantidade: megas,
          modo: 'data',
          remetente: `PayMoz-${reference || 'Auto'}`
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ [WEBHOOK] Erro ao processar:', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
