const express = require("express");
const { processReceiptWebhook } = require("./starMobileApi");
const { handleTelegramUpdate } = require("./index");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));

// فحص السيرفر
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "star-mobile-bot"
  });
});

// Webhook الخاص بإيصالات واتساب
app.post("/api/webhooks/whatsapp-receipt", async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await processReceiptWebhook(payload);

    return res.status(result.statusCode || 200).json(result);
  } catch (error) {
    console.error("❌ WhatsApp Webhook error:", error.message);

    return res.status(500).json({
      success: false,
      statusCode: 500,
      message: "حدث خطأ داخل الخادم أثناء معالجة الإيصال."
    });
  }
});

// Telegram Webhook
app.post("/api/telegram", async (req, res) => {
  try {
    const update = req.body || {};

    // نرجع نجاح بسرعة إلى Telegram
    res.status(200).json({ ok: true });

    // نعالج الرسالة أو الزر
    await handleTelegramUpdate(update);
  } catch (error) {
    console.error("❌ Telegram Webhook error:", error.message);
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server listening on http://localhost:${PORT}`);
    console.log(`🤖 Telegram Webhook: http://localhost:${PORT}/api/telegram`);
  });
}

module.exports = app;