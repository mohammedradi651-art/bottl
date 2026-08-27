import { handleTelegramUpdate } from "../index.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Telegram webhook is working"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Method Not Allowed"
    });
  }

  try {
    const update = req.body;

    console.log("Telegram update:", JSON.stringify(update));

    await handleTelegramUpdate(update);

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}