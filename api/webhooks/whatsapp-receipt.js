const { processReceiptWebhook } = require('../../starMobileApi');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      statusCode: 405,
      message: 'Only POST requests are allowed.'
    });
  }

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
};
