/**
 * وحدة تنسيق وتجهيز نصوص ورسائل تطبيق "ستار موبايل" (Star Mobile) - قوالب مختصرة وأنيقة مع إيموجيات جميلة
 */

/**
 * رسالة التأكيد والترحيب عند إضافة الحوالة بنجاح (مختصرة وأنيقة)
 */
function formatSuccessMessage({
    customerName,
    amount,
    currency,
    receiptNo,
    currentBalance,
    date,
    transferCompany,
    senderName
}) {
    const formatNumber = (value) => {
        const numericValue = Number(value);
        return Number.isFinite(numericValue)
            ? numericValue.toLocaleString("en-US", { maximumFractionDigits: 2 })
            : String(value || "0");
    };
    const formattedAmount = formatNumber(amount);
    const formattedBalance = formatNumber(currentBalance);
    const clientNameStr = customerName || "Customer";
    const safeDate = date || new Date().toLocaleString("en-US");

    return `✅ تم تأكيد الحوالة بنجاح

مرحباً *${clientNameStr}* 👋

تم استلام حوالتك وإضافتها إلى حسابك في تطبيق ستار موبايل.

💰 المبلغ المضاف: *${formattedAmount} ${currency}*
🔖 رقم الإيصال: *${receiptNo || "غير متوفر"}*
💼 رصيدك الحالي: *${formattedBalance} ${currency}*
📅 التاريخ: *${safeDate}*

شكراً لك ${clientNameStr}، تم تأكيد حوالتك بنجاح. 🌹`;
}

/**
 * رسالة التنبيه في حال تم استخدام الإيصال سابقاً
 */
function formatDuplicateReceiptMessage(receiptNo) {
    return `╔══════════════════╗
⭐ *ستار موبايل - تنبيه مهم* ⚠️
╚══════════════════╝

عذراً عميلنا الكريم! 😊
🔁 رقم الإيصال \`${receiptNo}\` تم إضافته سابقاً ولا يمكن تكراره.

📞 للاستفسار تواصل مع الدعم الفني! 💬`;
}

/**
 * رسالة في حال عدم قراءة الإيصال
 */
function formatInvalidReceiptMessage(reason) {
    const reasonText = reason ? `\n📌 *السبب:* ${reason}` : "";
    return `╔══════════════════╗
⭐ *ستار موبايل - تنبيه* ❌
╚══════════════════╝

عذراً لم نتمكن من قراءة الإيصال! 😔${reasonText}

📸 يرجى إرسال صورة أو PDF واضحة وسنخدمك فوراً! ✨`;
}

/**
 * رسالة الانتظار أثناء الفحص
 */
function formatProcessingMessage() {
    return `⏳ *ستار موبايل:* جاري فحص وتحليل الإيصال... 🤖✨`;
}

module.exports = {
    formatSuccessMessage,
    formatDuplicateReceiptMessage,
    formatInvalidReceiptMessage,
    formatProcessingMessage
};
