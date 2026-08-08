const express = require('express');
const { processReceiptWebhook } = require('./starMobileApi');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'whatsapp-ai-bot' });
});

app.post('/api/webhooks/whatsapp-receipt', async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await processReceiptWebhook(payload);
    return res.status(result.statusCode || 200).json(result);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    return res.status(500).json({
      success: false,
      statusCode: 500,
      message: 'حدث خطأ داخل الخادم أثناء معالجة الإيصال.'
    });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Webhook server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
