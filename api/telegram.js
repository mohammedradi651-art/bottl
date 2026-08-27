export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Telegram webhook is working"
    });
  }

  try {
    const update = req.body;

    console.log("Telegram update:", update);

    const chatId = update?.message?.chat?.id;

    if (chatId) {
      const token = process.env.TELEGRAM_BOT_TOKEN;

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: "أهلاً بك 👋\nالبوت يعمل بنجاح ✅"
        })
      });
    }

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.status(500).json({
      ok: false
    });
  }
}