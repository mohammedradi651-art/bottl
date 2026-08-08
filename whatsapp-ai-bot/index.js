const path = require("path");
const crypto = require("crypto");
require('dotenv').config({ path: path.resolve(__dirname, "../.env") });
const TelegramBot = require("node-telegram-bot-api");
const { analyzeReceipt } = require("./receiptAnalyzer");
const { getUserAccount, creditUserAccount, isReceiptAuthorized } = require("./starMobileApi");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : 932361893;
const { 
    formatSuccessMessage, 
    formatDuplicateReceiptMessage, 
    formatInvalidReceiptMessage 
} = require("./messageTemplates");

// ===== معالجة الأخطاء غير المتوقعة =====
process.on("uncaughtException", (err) => {
    console.error("⚠️ خطأ غير متوقع:", err.message);
});
process.on("unhandledRejection", (reason) => {
    console.error("⚠️ رفض غير معالج:", reason?.message || reason);
});

// ===== إعدادات منظومة الوادي =====
const MASTER_API_TOKEN = process.env.STAR_API_TOKEN || "star_usit4xl5dd9f3fcss6ft";
const ALWADI_API_TOKEN = MASTER_API_TOKEN;
const ALWADI_BASE_URL = "https://star26.vercel.app/api/external/v1";

// ===== إعدادات خدمات الشبكات =====
const NETWORKS_API_TOKEN = MASTER_API_TOKEN;
const NETWORKS_BASE_URL = "https://star26.vercel.app/api/external/v1/networks";

// ===== ربط الحساب عبر OTP من SimGate =====
const SIMGATE_API_URL = "https://api.simgate.app/v1/sms/send";
const SIMGATE_API_KEY = process.env.SIMGATE_API_KEY;
const SIMGATE_DEVICE_ID = process.env.SIMGATE_DEVICE_ID;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

// ===== جلسات المستخدمين =====
const userSessions = {};

// ===== حفظ واسترجاع أرقام المستخدمين المسجلة =====
const USER_MOBILES_FILE = path.join(__dirname, "user_mobiles.json");
function loadUserMobiles() {
    try {
        const fs = require("fs");
        if (fs.existsSync(USER_MOBILES_FILE)) {
            return JSON.parse(fs.readFileSync(USER_MOBILES_FILE, "utf8"));
        }
    } catch (e) {}
    return {};
}

function saveUserMobile(senderPhone, mobile) {
    try {
        const fs = require("fs");
        const mobiles = loadUserMobiles();
        mobiles[senderPhone] = mobile;
        fs.writeFileSync(USER_MOBILES_FILE, JSON.stringify(mobiles, null, 2), "utf8");
    } catch (e) {}
}

function isValidLinkingMobile(phone) {
    return /^7\d{8}$/.test(String(phone || "").trim());
}

function isAccountLinked(senderId) {
    const mobile = loadUserMobiles()[String(senderId)];
    return isValidLinkingMobile(mobile);
}

function linkingKeyboard() {
    return { inline_keyboard: [[{ text: "ربط حسابي", callback_data: "link_account" }]] };
}

function linkingMessage() {
    return `🔗 *اربط حسابك في ستار موبايل*

للحصول على خدماتك بشكل آمن، يجب ربط حسابك المسجل في تطبيق ستار موبايل بهذا البوت.

سيتم إرسال رمز تحقق OTP إلى رقمك المسجل، وبعد التحقق ستتمكن من استخدام جميع الخدمات والاطلاع على بيانات حسابك.`;
}

function hashOtp(code) {
    return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function sendLinkingOtp(phone, code) {
    if (!SIMGATE_API_KEY || !SIMGATE_DEVICE_ID) {
        return { success: false, message: "إعدادات إرسال رمز التحقق غير مكتملة لدى الإدارة." };
    }
    try {
        const response = await fetch(SIMGATE_API_URL, {
            method: "POST",
            headers: {
                "x-api-key": SIMGATE_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                deviceId: SIMGATE_DEVICE_ID,
                phoneNumber: `+967${phone}`,
                message: `رمز التحقق لربط حسابك في ستار موبايل هو: ${code}. صالح لمدة 10 دقائق.`
            })
        });
        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; } catch (error) { data = {}; }
        if (!response.ok) {
            console.error("SimGate OTP error:", response.status, responseText);
            return { success: false, message: data.message || "تعذر إرسال رمز التحقق إلى الهاتف." };
        }
        return { success: true, data };
    } catch (error) {
        console.error("SimGate connection error:", error.message);
        return { success: false, message: "تعذر الاتصال بخدمة الرسائل حالياً." };
    }
}

async function sendLinkingPrompt(bot, chatId) {
    await safeSendMessage(bot, chatId, linkingMessage(), { reply_markup: linkingKeyboard() });
}

async function finishAccountLinking(bot, chatId, senderId, mobile) {
    const balanceResponse = await callAlWadiAPI(`/balance?mobile=${encodeURIComponent(mobile)}`);
    if (!balanceResponse.success || !balanceResponse.data) {
        await safeSendMessage(bot, chatId, "❌ لم يتم العثور على حساب بهذا الرقم في تطبيق ستار موبايل. تأكد من الرقم وحاول مرة أخرى.", { reply_markup: linkingKeyboard() });
        return false;
    }

    saveUserMobile(senderId, mobile);
    const account = balanceResponse.data;
    const accountName = account.user || account.name || account.fullName || account.customerName || "المشترك العزيز";
    const accountBalance = account.balance ?? 0;
    const currency = account.currency === "YER" ? "ريال يمني" : (account.currency || "ريال يمني");
    await safeSendMessage(bot, chatId, `✅ *تم ربط حسابك بنجاح*

مرحبًا بك، *${accountName}* 👋

📱 رقم المشترك: \`${mobile}\`
💰 الرصيد الحالي: *${accountBalance} ${currency}*

أصبح حسابك جاهزًا لاستخدام خدمات ستار موبايل.`, { reply_markup: mainMenuKeyboard() });
    return true;
}

function waitForBotReply() {
    return Promise.resolve();
}

function withHomeButton(replyMarkup) {
    const markup = replyMarkup && Array.isArray(replyMarkup.inline_keyboard)
        ? { ...replyMarkup, inline_keyboard: replyMarkup.inline_keyboard.map(row => [...row]) }
        : { inline_keyboard: [] };
    const hasHomeButton = markup.inline_keyboard.some(row =>
        row.some(button => button.callback_data === "menu_home")
    );
    if (!hasHomeButton) {
        markup.inline_keyboard.push([{ text: "الرئيسية", callback_data: "menu_home" }]);
    }
    return markup;
}

async function safeSendMessage(bot, chatId, text, options = {}) {
    try {
        const messageText = String(text || "");
        const maxLength = 3800;
        const chunks = [];
        let remainingText = messageText;

        while (remainingText.length > maxLength) {
            let splitAt = remainingText.lastIndexOf("\n", maxLength);
            if (splitAt < Math.floor(maxLength * 0.6)) splitAt = maxLength;
            chunks.push(remainingText.slice(0, splitAt));
            remainingText = remainingText.slice(splitAt).replace(/^\n+/, "");
        }
        chunks.push(remainingText);

        let lastSent = null;
        for (let index = 0; index < chunks.length; index += 1) {
            const isLastChunk = index === chunks.length - 1;
            const sendOptions = {
                parse_mode: "Markdown",
                ...options,
                ...(index > 0 ? { reply_to_message_id: undefined } : {}),
                ...(isLastChunk ? { reply_markup: withHomeButton(options.reply_markup) } : {})
            };
            lastSent = await bot.sendMessage(chatId, chunks[index], sendOptions);
        }
        return lastSent;
    } catch (err) {
        console.error("⚠️ خطأ أثناء إرسال الرسالة:", err.message);
        return null;
    }
}

function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: "حسابي", callback_data: "menu_account" },
                { text: "منظومة الوادي", callback_data: "menu_alwadi" }
            ],
            [
                { text: "شبكات الإنترنت", callback_data: "menu_networks" },
                { text: "تغذية الحساب", callback_data: "menu_funding" }
            ],
            [{ text: "حساباتنا الرسمية", callback_data: "menu_official_accounts" }]
        ]
    };
}

function backKeyboard() {
    return { inline_keyboard: [[{ text: "الرئيسية", callback_data: "menu_home" }]] };
}

function officialAccountsKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "Facebook", url: "https://www.facebook.com/share/18cpcKG28B/" }],
            [{ text: "Instagram", url: "https://www.instagram.com/star.media26?igsh=OGM2MGV1d3pnb3l4" }],
            [{ text: "WhatsApp", url: "https://wa.me/967770326828" }],
            [{ text: "الرئيسية", callback_data: "menu_home" }]
        ]
    };
}

const ALWADI_PACKAGES = [
    { id: "1", name: "شهرين", price: "3,000" },
    { id: "3", name: "4 أشهر", price: "6,000" },
    { id: "7", name: "6 أشهر", price: "9,000" },
    { id: "9", name: "سنة كاملة", price: "15,000" }
];

function alWadiLookupKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "تجديد الكرت", callback_data: "alwadi_renew" }],
            [{ text: "استعلام عن كرت آخر", callback_data: "menu_alwadi" }],
            [{ text: "الرئيسية", callback_data: "menu_home" }]
        ]
    };
}

function alWadiPackagesKeyboard() {
    return {
        inline_keyboard: [
            ALWADI_PACKAGES.slice(0, 2).map(item => ({
                text: `${item.name} • ${item.price}`,
                callback_data: `alwadi_package_${item.id}`
            })),
            ALWADI_PACKAGES.slice(2).map(item => ({
                text: `${item.name} • ${item.price}`,
                callback_data: `alwadi_package_${item.id}`
            })),
            [{ text: "بيانات الكرت", callback_data: "alwadi_details" }],
            [{ text: "الرئيسية", callback_data: "menu_home" }]
        ]
    };
}

function alWadiDetailsText(session) {
    const details = session.lastCardDetails || {};
    const days = details.daysLeft ?? details.remainingDays ?? "—";
    const daysText = typeof days === "number" && days < 0
        ? `منتهي منذ ${Math.abs(days)} يوم ❗`
        : `${days} يوم`;
    return `🌟 *بيانات الكرت (منظومة الوادي)*\n\n━━━━━━━━━━━━━━\n👤 *الاسم:* ${details.name || "—"}\n🎫 *رقم الكرت:* ${session.lastCardNumber || "—"}\n📅 *تاريخ الانتهاء:* ${details.expiry || "—"}\n⏳ *الأيام المتبقية:* ${daysText}\n━━━━━━━━━━━━━━\n\nاختر الإجراء من الأزرار بالأسفل:`;
}

function alWadiPackagesText(session) {
    return `🔄 *تجديد كرت منظومة الوادي*\n\n🎫 رقم الكرت: *${session.lastCardNumber || "—"}*\n\nاختر مدة التجديد المطلوبة:`;
}

async function sendMainMenu(bot, chatId, messageId) {
    const text = `🌟 *مرحبًا بك في ستار موبايل*

أهلًا وسهلًا بك في تطبيق ستار موبايل 💙
منصتك الموثوقة لإدارة خدماتك بكل سهولة وسرعة.

🚀 *من مكان واحد يمكنك:*
• 👤 إدارة حسابك ومتابعة رصيدك
• 📡 الاستعلام وتجديد منظومة الوادي
• 🌐 الاطلاع على خدمات وباقات الإنترنت
• 🧾 متابعة عملياتك وإيصالاتك
• 📱 متابعة حساباتنا الرسمية

✨ *خدماتك أقرب… معاملاتك أسهل… وتجربتك أفضل.*

اختر الخدمة التي تريدها من القائمة بالأسفل 👇`;
    const options = { reply_markup: mainMenuKeyboard() };
    if (messageId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", ...options });
            return;
        } catch (error) {
            console.warn("تعذر تحديث قائمة البوت:", error.message);
        }
    }
    await safeSendMessage(bot, chatId, text, options);
}

async function handleMenuCallback(bot, query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const senderId = String(query.from?.id || chatId || "");
    if (!chatId) return;

    await bot.answerCallbackQuery(query.id);

    if (query.data === "link_account") {
        if (isAccountLinked(senderId)) {
            await safeSendMessage(bot, chatId, "✅ حسابك مربوط مسبقًا ولا يمكن تغييره من هذا البوت.", { reply_markup: mainMenuKeyboard() });
            return;
        }
        const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });
        session.state = "LINKING_AWAITING_PHONE";
        await safeSendMessage(bot, chatId, "📱 أرسل رقم جوالك المسجل في تطبيق ستار موبايل.\n\nيجب أن يبدأ بالرقم 7 ويتكون من 9 أرقام، مثال: 770326828", { reply_markup: linkingKeyboard() });
        return;
    }

    if (!isAccountLinked(senderId)) {
        await sendLinkingPrompt(bot, chatId);
        return;
    }

    if (query.data === "alwadi_renew" || query.data === "alwadi_details" || query.data.startsWith("alwadi_package_")) {
        const session = userSessions[senderId];
        if (!session?.lastCardNumber) {
            await safeSendMessage(bot, chatId, "📡 لا يوجد كرت محفوظ حالياً. أرسل رقم الكرت للاستعلام عنه أولاً.", { reply_markup: backKeyboard() });
            return;
        }

        if (query.data === "alwadi_details") {
            await bot.editMessageText(alWadiDetailsText(session), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: alWadiLookupKeyboard()
            });
            return;
        }

        if (query.data === "alwadi_renew") {
            session.state = "AWAITING_PACKAGE_SELECTION";
            await bot.editMessageText(alWadiPackagesText(session), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: alWadiPackagesKeyboard()
            });
            return;
        }

        const packageId = query.data.replace("alwadi_package_", "");
        const selectedPackage = ALWADI_PACKAGES.find(item => item.id === packageId);
        if (!selectedPackage) return;

        const targetMobile = getVerifiedCustomerMobile(senderId, session);
        if (!targetMobile) {
            await safeSendMessage(bot, chatId, "قبل تنفيذ التجديد، أرسل رقم هاتفك اليمني المسجل في Star Mobile أولاً.", { reply_markup: backKeyboard() });
            return;
        }
        const result = await callAlWadiAPI("/alwadi", {
            action: "renew",
            number: session.lastCardNumber,
            packageId: selectedPackage.id,
            mobile: targetMobile
        });

        if (result.success) {
            session.state = null;
            await bot.editMessageText(`✅ *تم التجديد بنجاح*\n\n🎫 الكرت: *${session.lastCardNumber}*\n📦 الباقة: *${selectedPackage.name}*\n💰 المبلغ المخصوم: *${selectedPackage.price} ريال*`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "بيانات الكرت", callback_data: "alwadi_details" }], [{ text: "الرئيسية", callback_data: "menu_home" }]] }
            });
        } else {
            const errorText = result.code === "SM_INSUFFICIENT_BALANCE"
                ? `❌ رصيدك غير كافٍ لتجديد الكرت.\n\nالمطلوب: *${selectedPackage.price} ريال*`
                : `❌ تعذر التجديد: ${result.message || "حدث خطأ غير معروف."}`;
            await bot.editMessageText(errorText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "اختيار باقة أخرى", callback_data: "alwadi_renew" }], [{ text: "الرئيسية", callback_data: "menu_home" }]] }
            });
        }
        return;
    }

    if (query.data === "menu_home") {
        await sendMainMenu(bot, chatId, messageId);
        return;
    }

    if (query.data === "menu_account") {
        const mobileMap = loadUserMobiles();
        const senderMobile = formatMobileForAPI(senderId);
        const mobile = mobileMap[senderId] || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
        if (!mobile) {
            await safeSendMessage(bot, chatId, "👤 *حسابي*\n\nأرسل رقم هاتفك المسجل في Star Mobile لعرض بيانات الحساب والرصيد.", { reply_markup: backKeyboard() });
            return;
        }
        const balanceResponse = await callAlWadiAPI(`/balance?mobile=${encodeURIComponent(mobile)}`);
        if (!balanceResponse.success || !balanceResponse.data) {
            const message = balanceResponse.code === "SM_USER_NOT_FOUND"
                ? "لم يتم العثور على حساب مرتبط بهذا الرقم في نظام ستار موبايل."
                : (balanceResponse.message || "تعذر جلب الرصيد الحقيقي من الخادم حالياً.");
            await safeSendMessage(bot, chatId, `👤 *حسابي | ستار موبايل*\n\n❌ ${message}\n\nيرجى المحاولة لاحقاً أو التواصل مع الدعم.`, { reply_markup: backKeyboard() });
            return;
        }

        const accountData = balanceResponse.data;
        const accountName = accountData.user || accountData.name || accountData.fullName || accountData.customerName || "المشترك العزيز";
        const accountPhone = accountData.mobile || accountData.phone || mobile;
        const accountBalance = accountData.balance;
        const accountCurrency = accountData.currency === "YER" ? "ريال يمني" : (accountData.currency || "ريال يمني");
        await safeSendMessage(bot, chatId, `👤 *حسابي | ستار موبايل*

مرحبًا بك، *${accountName}* 👋

📱 *رقم المشترك:* \`${accountPhone}\`

    💰 *رصيدك الحالي*
*${accountBalance} ${accountCurrency}*

    ━━━━━━━━━━━━━━
    🌟 ستار موبايل
    خدماتك وبيانات حسابك في مكان واحد.`, { reply_markup: backKeyboard() });
        return;
    }

    if (query.data === "menu_alwadi") {
        const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });
        session.state = null;
        await safeSendMessage(bot, chatId, "📡 *منظومة الوادي*\n\nأرسل رقم الكرت للاستعلام عن حالته وتاريخ انتهائه.", { reply_markup: backKeyboard() });
        return;
    }

    if (query.data === "menu_networks") {
        const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });
        const mobileMap = loadUserMobiles();
        const senderMobile = formatMobileForAPI(senderId);
        const mobile = mobileMap[senderId] || session.registeredMobile || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
        const result = await callNetworksAPI({ action: "list_networks", mobile });

        if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
            await safeSendMessage(bot, chatId, `🌐 *شبكات الإنترنت*\n\n❌ ${result.message || "لا توجد شبكات متاحة حالياً."}`, { reply_markup: backKeyboard() });
            return;
        }

        session.availableNetworks = result.data;
        session.state = "AWAITING_NETWORK_SELECTION";
        const networksText = result.data
            .map((network, index) => `${index + 1}. ${network.name}`)
            .join("\n");
        await safeSendMessage(bot, chatId, `🌐 *شبكات الإنترنت المتاحة*\n\n${networksText}\n\nأرسل اسم الشبكة أو رقمها لعرض فئاتها المتاحة.`, { reply_markup: backKeyboard() });
        return;
    }

    if (query.data === "menu_funding") {
        await safeSendMessage(bot, chatId, "💳 *تغذية الحساب*\n\nأرسل صورة واضحة لإيصال التحويل، وسيتم فحصه ومطابقة بياناته ثم إضافة المبلغ إلى حسابك بعد التحقق.", { reply_markup: backKeyboard() });
        return;
    }

    if (query.data === "menu_official_accounts") {
        await safeSendMessage(bot, chatId, `📱 *حساباتنا الرسمية*

تابع *ستار موبايل* على حساباتنا الرسمية وكن أول من يعرف عن جديد خدماتنا، العروض والتحديثات 🌟

🔹 *فيسبوك*

🔹 *انستقرام*

🔹 *واتساب*

━━━━━━━━━━━━━━
🌟 *ستار موبايل*
معك دائمًا… أينما كنت.`, { reply_markup: officialAccountsKeyboard() });
    }
}

async function callAlWadiAPI(endpoint, payload) {
    const isGet = !payload;
    const options = {
        method: isGet ? "GET" : "POST",
        headers: {
            "Authorization": `Bearer ${ALWADI_API_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
    };
    if (!isGet) options.body = JSON.stringify(payload);
    try {
        const res = await fetch(`${ALWADI_BASE_URL}${endpoint}`, options);
        return await res.json();
    } catch (e) {
        console.error("AlWadi API Error:", e.message);
        return { success: false, message: "حدث خطأ أثناء الاتصال بخادم الوادي." };
    }
}

async function callNetworksAPI(payload) {
    try {
        const res = await fetch(NETWORKS_BASE_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NETWORKS_API_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error("Networks API Error:", e.message);
        return { success: false, message: "حدث خطأ أثناء الاتصال بخادم الشبكات." };
    }
}


function formatMobileForAPI(phone) {
    let clean = (phone || "").replace(/[^0-9]/g, "");
    if (clean.startsWith("967") && clean.length > 9) {
        clean = clean.slice(3);
    }
    return clean;
}

function getVerifiedCustomerMobile(senderId, session = {}) {
    const mobileMap = loadUserMobiles();
    const senderMobile = formatMobileForAPI(senderId);
    const candidate = mobileMap[String(senderId)] || session.registeredMobile || senderMobile;
    return isValidYemeniMobile(candidate) ? candidate : null;
}

/**
 * التحقق من صحة رقم الهاتف اليمني (يبدأ بـ 7 ومكون من 9 أرقام)
 */
function isValidYemeniMobile(phone) {
    return /^7\d{8}$/.test(String(phone || ""));
}

/**
 * تنزيل ملف من Telegram باستخدام fileId
 */
async function downloadTelegramFile(bot, fileId) {
    try {
        const fileUrl = await bot.getFileLink(fileId);
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
        return Buffer.from(await res.arrayBuffer());
    } catch (e) {
        console.error("Telegram file download error:", e.message);
        return null;
    }
}

function getTelegramMediaObject(msg) {
    if (!msg) return null;

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        return { type: "image", fileId: photo.file_id, mimeType: "image/jpeg" };
    }

    if (msg.document && msg.document.file_id) {
        const mimeType = msg.document.mime_type || "application/pdf";
        if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
            return { type: "document", fileId: msg.document.file_id, mimeType };
        }
    }

    return null;
}

function extractCardNumber(cleanText, lowerText) {
    const cleanDigits = (cleanText || "").replace(/[^0-9]/g, "");
    if (isValidYemeniMobile(formatMobileForAPI(cleanDigits))) {
        return null; // هذا رقم هاتف يمني وليس رقم كرت!
    }
    // أرقام فقط
    if (/^\d{1,20}$/.test(cleanText)) return cleanText;
    // كلمات دلالية واسعة للاستعلام
    const lookupKeywords = /(?:كرت|الكرت|كرتي|رقم|استعلام|استعلم|استعلمي|الوادي|وادي|اشتراك|باقة|حساب|بيانات|على|اعرف|ابحث|ابغى|ابغا|ابغ|شوف|جيب|اجلب|منظومة)/i;
    if (lookupKeywords.test(lowerText)) {
        const match = cleanText.match(/(\d{1,20})/);
        if (match && !isValidYemeniMobile(formatMobileForAPI(match[1]))) return match[1];
    }
    return null;
}

function extractCleanAIResponse(data) {
    if (!data.candidates || !data.candidates[0]?.content?.parts) return null;
    const parts = data.candidates[0].content.parts;
    let textParts = parts
        .filter(p => !p.thought)
        .map(p => p.text || "")
        .filter(t => !t.includes("Final Output Generation") && !t.includes("Checklist") && !t.includes("Context:"));
    let fullText = textParts.join("\n").trim();
    if (!fullText) return null;
    if (fullText.includes("Final Output")) {
        const splitParts = fullText.split("Final Output Generation");
        fullText = splitParts[splitParts.length - 1].trim();
    }
    return fullText;
}

async function generateFastAIResponse(prompt, history = [], userName = "العميل") {
    const contents = [];
    
    // إرسال آخر 20 رسالة (40 عنصراً: 20 من المستخدم و 20 من البوت)
    if (Array.isArray(history) && history.length > 0) {
        const recentHistory = history.slice(-40);
        for (const item of recentHistory) {
            contents.push({
                role: item.role === 'user' ? 'user' : 'model',
                parts: [{ text: item.text }]
            });
        }
    }

    // إدراج الرسالة الحالية إذا لم تكن مسجلة بالسجل
    if (contents.length === 0 || contents[contents.length - 1].parts[0].text !== prompt) {
        contents.push({
            role: 'user',
            parts: [{ text: prompt }]
        });
    }

    const payload = {
        system_instruction: {
            parts: [{ 
                text: `أنت مساعد خدمة العملاء الذكي لتطبيق ستار موبايل ⭐📱. تطبيقنا يوفر كروت وشحن لأكثر من 150 شبكة محليّة ولاسلكية (مثل الرشيدي، الخير، زين، يمن نت وغيرها) بالإضافة لخدمات منظومة الوادي للبث الرقمي وشحن الحساب بالإيصالات. رد باللغة العربية بأسلوب راقٍ ومختصر (سطرين أو ثلاثة فقط) متبعاً سياق المحادثة بدون أي اعتذارات خاطئة عن الخدمات المتوفرة.

سياسة الخصوصية والأمان (مهم جداً):
- كل مشترك يمكنه الاطلاع على رصيده الشخصي فقط، ولا يمكن لأي شخص الاطلاع على رصيد مشترك آخر تحت أي ظرف.
- جميع العمليات المالية (الشحن، التجديد، الشراء) تُنفَّذ من رصيد صاحب الحساب الموثق فقط.
- إذا سأل أحد عن إمكانية رؤية رصيد شخص آخر، أجب بوضوح: لا، الرصيد خاص وسري لكل مشترك.
- تنبيه هام جداً: لا تذكر أو تبتكر أرصدة حسابات أو مبالغ مالية من عندك إطلاقاً!` 
            }]
        },
        contents: contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 350 }
    };

    const MODELS = ["gemini-3.1-flash-lite"];
    for (const model of MODELS) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
            );
            if (!res.ok) continue;
            const data = await res.json();
            const cleanReply = extractCleanAIResponse(data);
            if (cleanReply) return cleanReply;
        } catch (e) { continue; }
    }
    return `أهلاً بك في *ستار موبايل* ⭐📱\nكيف يمكننا مساعدتك اليوم؟ ✨`;
}

function getMediaMessageObject(msg) {
    if (!msg || !msg.message) return null;
    const m = msg.message;
    const imageMsg = m.imageMessage || m.ephemeralMessage?.message?.imageMessage || m.viewOnceMessage?.message?.imageMessage || m.viewOnceMessageV2?.message?.imageMessage;
    const docMsg = m.documentMessage || m.ephemeralMessage?.message?.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
    if (imageMsg && (imageMsg.url || imageMsg.directPath || imageMsg.mediaKey)) return { type: "image", media: imageMsg, mimeType: imageMsg.mimetype || "image/jpeg" };
    if (docMsg && (docMsg.url || docMsg.directPath || docMsg.mediaKey)) return { type: "document", media: docMsg, mimeType: docMsg.mimetype || "application/pdf" };
    return null;
}

/**
 * دالة تنسيق مدة الصلاحية وتنظيف الأخطاء الإملائية مثل (أيا ام -> أيام)
 */
function formatValidity(validity) {
    if (!validity || validity === '--') return '';
    return String(validity)
        .replace(/أياs*ام/g, "أيام")
        .replace(/أسبوعs*ع/g, "أسبوع")
        .replace(/أسبs*بوعين/g, "أسبوعين")
        .replace(/شهرs*ر/g, "شهر")
        .replace(/s+/g, ' ')
        .trim();
}

/**
 * دالة البحث الذكي عن اسم الشبكة من نص العميل بأي صيغة أو لهجة
 */
function findNetworkInText(text, networks) {
    if (!Array.isArray(networks) || networks.length === 0) return null;
    
    const normalize = (str) => {
        return (str || "").toLowerCase()
            .replace(/[أإآ]/g, "ا")
            .replace(/ة/g, "ه")
            .replace(/ى/g, "ي")
            .replace(/[^\w\s\u0600-\u06FF]/g, " ")
            .trim();
    };

    const textNorm = normalize(text);

    const stopWords = new Set([
        "تعرف", "تعرفون", "تعرفوا", "عندكم", "عندكمش", "عندك", "في", "فية", "من", "عن", "حق", "حقها", "تبع", "تبعها",
        "باقات", "باقة", "كروت", "كرت", "اسعار", "أسعار", "سعر", "موجود", "موجودة", "موجده", "هل", "اريد", "أريد",
        "ابغى", "ابغا", "عايز", "ابي", "أبي", "اعرف", "أعرف", "جيب", "عرض", "شبكة", "شبكه", "نت", "واي", "فاي", "اللاسلكية",
        "عليه", "عليها", "عنها", "عنه", "إليه", "إليها", "اليه", "اليها", "فيها", "فيه", "منه", "منها", "حقهم", "حقين",
        "استعلام", "استعلم", "استعلمي", "استفسار", "فحص", "معرفة", "معرفه", "بيانات", "معلومات", "شيك", "تأكد", "تاكد",
        "شحن", "تجديد", "اشتراك", "منظومة", "الوادي"
    ]);

    const words = textNorm.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
    if (words.length === 0) return null;

    // 1. بحث بالكلمات الأساسية الفردية (مثلاً الرشيدي / رشيدي / stc)
    for (const net of networks) {
        const netNorm = normalize(net.name);
        const netWords = netNorm.split(/\s+/).filter(w => w.length >= 2);

        for (const word of words) {
            const wordNoAl = word.startsWith("ال") ? word.slice(2) : word;
            if (wordNoAl.length < 2) continue;

            const hasMatch = netWords.some(nw => {
                const nwNoAl = nw.startsWith("ال") ? nw.slice(2) : nw;
                if (nw === word || nwNoAl === wordNoAl) return true;
                if (wordNoAl.length >= 4 && nwNoAl.length >= 4) {
                    return nwNoAl.startsWith(wordNoAl) || wordNoAl.startsWith(nwNoAl);
                }
                return false;
            });
            if (hasMatch) return net;
        }
    }

    // 2. مطابقة الجزء النظيف من اسم الشبكة
    for (const net of networks) {
        const netClean = normalize(net.name).replace(/شبكة|شبكه|نت|5g|4g|اللاسلكية/g, "").trim();
        const netCleanNoAl = netClean.startsWith("ال") ? netClean.slice(2) : netClean;
        if (netClean.length >= 3) {
            for (const word of words) {
                const wordNoAl = word.startsWith("ال") ? word.slice(2) : word;
                if (wordNoAl.length >= 3 && (netCleanNoAl === wordNoAl || (netCleanNoAl.length >= 4 && wordNoAl.length >= 4 && (netCleanNoAl.startsWith(wordNoAl) || wordNoAl.startsWith(netCleanNoAl))))) {
                    return net;
                }
            }
        }
    }

    return null;
}

// ===== معالجة رسائل منظومة الوادي والشبكات =====
async function handleTextMessage(textMessage, chatId, senderPhone, pushName, bot, msg) {
    if (!userSessions[senderPhone]) {
        userSessions[senderPhone] = { history: [], state: null };
    }
    const session = userSessions[senderPhone];

    // استرجاع الرقم اليمني المسجل بالملف إن وجد
    const userMobilesMap = loadUserMobiles();
    if (!session.registeredMobile && userMobilesMap[senderPhone]) {
        session.registeredMobile = userMobilesMap[senderPhone];
    }

    const cleanText = textMessage.trim();
    const lowerText = cleanText.toLowerCase();

    // إضافة محادثات العميل للذاكرة
    const addToHistory = (role, text) => {
        session.history.push({ role, text });
        if (session.history.length > 50) session.history.shift();
    };
    addToHistory("user", textMessage);

    let finalReply = null;
    let replyMarkup = null;
    const detectedCardNumber = extractCardNumber(cleanText, lowerText);

    // ==========================================
    // 📺 1. منظومة الوادي (استعلام، باقات، واستفسارات ذكية)
    // ==========================================
    const isAlWadiReq = /(?:منظومة الوادي|الوادي|باقات الوادي|اسعار الوادي|أسعار الوادي|عروض الوادي|تجديد الوادي|اشتراك الوادي|بث الوادي|عندكم الوادي|تعرف الوادي|كرت الوادي|منظومة)/i.test(lowerText);
    const isGeneralInquiry = /(?:استعلام|استعلم|استعلمي|استفسار|فحص الكرت|بيانات الكرت|استعلم عليه|استعلام عليه)/i.test(lowerText);

    // 0. تحديد رقم العميل المشترك (Subscriber Mobile) بأعلى درجات الأمان والخصوصية
    let targetMobile = null;
    const phoneFromJid = formatMobileForAPI(senderPhone);

    // أ. إذا كان رقم الواتساب يمنياً صالحاً، فهو هوية العميل الثابتة والموثقة من واتساب مباشرة
    if (isValidYemeniMobile(phoneFromJid)) {
        targetMobile = phoneFromJid;
    } else {
        // ب. لحسابات الأعمال والمعرفات الخارجية: نستخدم الرقم المربوط بالحساب بالملف/الجلسة
        targetMobile = session.registeredMobile || userMobilesMap[senderPhone] || null;

        // ج. إذا لم يوجد رقم مسجل لحساب الأعمال، وأرسل رقماً يمنياً صريحاً للتسجيل أول مرة
        if (!targetMobile) {
            const mobileMatchInMsg = cleanText.match(/(?:967)?(7[0-8]\d{7})/);
            if (mobileMatchInMsg) {
                targetMobile = mobileMatchInMsg[1];
                session.registeredMobile = targetMobile;
                saveUserMobile(senderPhone, targetMobile);
            }
        }
    }

    const isStandaloneYemeniMobile = /^(\+?967)?(7[0-8]\d{7})$/.test(cleanText.replace(/\s+/g, ''));
    const isBalanceReq = /(?:رصيد|الرصيد|رصيدي|فحص الرصيد|كم رصيد|كم صار الرصيد|كم الحساب|حسابي)/i.test(lowerText) || isStandaloneYemeniMobile;

    // أ. تسجيل وتأكيد الرقم اليمني عند طلب التسجيل لحسابات الأعمال
    if (session.state === 'AWAITING_MOBILE_REGISTRATION' && isStandaloneYemeniMobile) {
        const mobileReg = cleanText.match(/(?:967)?(7[0-8]\d{7})/);
        if (mobileReg) {
            targetMobile = mobileReg[1];
            session.registeredMobile = targetMobile;
            saveUserMobile(senderPhone, targetMobile);
            session.state = null;
        }
    }

    // ب. فحص الرصيد المباشر (رصيد صاحب الحساب الموثق فقط)
    if (!finalReply && isBalanceReq) {
        if (targetMobile) {
            // 🔒 حماية: تحقق إذا كتب المستخدم رقماً مختلفاً عن رقمه المسجل
            const mobileInMsg = cleanText.match(/(?:\+?967)?(7[0-8]\d{7})/);
            const askedMobile = mobileInMsg ? mobileInMsg[1] : null;
            if (askedMobile && askedMobile !== targetMobile) {
                finalReply = `🔒 *خصوصية الحسابات محمية*

❌ لا يمكنك الاطلاع على رصيد مشتركين آخرين.

كل مشترك له حساب خاص وسري. يمكنك فقط الاطلاع على رصيدك الشخصي المرتبط برقمك (${targetMobile}).

للاطلاع على رصيدك أرسل: *رصيدي* 💰`;
            } else {
                console.log(`🔍 طلب فحص الرصيد للمشترك الموثق: ${targetMobile} (المرسل: ${senderPhone})...`);
                const res = await callAlWadiAPI(`/balance?mobile=${targetMobile}`);
                console.log("AlWadi Balance Response:", JSON.stringify(res));
                if (res.success && res.data) {
                    const balanceVal = parseFloat(res.data.balance);
                    const balanceFormatted = isNaN(balanceVal) ? res.data.balance : balanceVal.toFixed(2);
                    const currencyLabel = (res.data.currency || 'YER') === 'YER' ? 'ريال يمني' : (res.data.currency || 'ريال');
                    const registeredName = res.data.user ? `👤 *الاسم:* ${res.data.user}\n` : '';
                    const registeredPhone = res.data.mobile || targetMobile;
                    finalReply = `💰 *رصيدك في ستار موبايل* 💳\n\n━━━━━━━━━━━━━\n${registeredName}📱 *الرقم:* ${registeredPhone}\n💵 *الرصيد:* ${balanceFormatted} ${currencyLabel}\n━━━━━━━━━━━━━`;
                } else if (res.code === 'SM_USER_NOT_FOUND') {
                    finalReply = `📱 *فحص الرصيد:*\nلم يتم العثور على حساب مرتبط بالرقم (${targetMobile}) في نظام ستار موبايل.\n\nللتسجيل أو الاستفسار تواصل مع الدعم الفني. 💬`;
                } else {
                    finalReply = `❌ عذراً: ${res.message || "لم نتمكن من جلب الرصيد حالياً."}`;
                }
            }
        } else {
            session.state = 'AWAITING_MOBILE_REGISTRATION';
            finalReply = `📱 *فحص الرصيد:*\nيرجى إرسال *رقم هاتفك اليمني المسجل* في ستار موبايل (مثال: \`770326828\`) وسيتم ربطه بحسابك تلقائياً لجميع استفساراتك القادمة.`;
        }
    }

    // ب. استفسارات وتساؤلات أو طلب باقات منظومة الوادي (بدون أرقام كروت)
    // ملاحظة: isAlWadiReq له الأولوية على isGeneralInquiry حتى لو كان الاثنان true
    else if (isAlWadiReq && !detectedCardNumber) {
        finalReply = 
`📺 *نعم، خدمات منظومة الوادي للبث الرقمي متوفرة لدينا بالكامل!* 🚀

إليك قائمة باقات وأسعار تجديد الاشتراكات:

1️⃣ *شهرين* 👈 3,000 ريال (أرسل 1)
2️⃣ *4 أشهر* 👈 6,000 ريال (أرسل 2)
3️⃣ *6 أشهر* 👈 9,000 ريال (أرسل 3)
4️⃣ *سنة كاملة* 👈 15,000 ريال (أرسل 4)

━━━━━━━━━━━━━━━━━
تستطيع التجديد مباشرة بإرسال:
*رقم الكرت* + *رقم الباقة* (مثال: تجديد 8020 باقة 1)
أو أرسل رقم الكرت للاستعلام عنه فوراً.`;
    }
    // ج. الاستعلام عن كرت الوادي عند كتابة رقم الكرت بدون طلب تجديد مباشر
    else if (detectedCardNumber && !/(?:تجديد|اشتراك|اجدد|أجدد|باقة|باقه)/i.test(lowerText) && (isAlWadiReq || session.state === 'AWAITING_RENEWAL_DECISION' || !session.state)) {
        const cardNumber = detectedCardNumber;
        console.log(`🔍 استعلام عن كرت الوادي: ${cardNumber}`);
        const res = await callAlWadiAPI('/alwadi', {
            action: "lookup",
            number: cardNumber,
            mobile: targetMobile || session.registeredMobile || null
        });
        console.log("AlWadi Lookup Response:", JSON.stringify(res));
        if (res.success && res.data) {
            session.lastCardNumber = cardNumber;
            session.state = 'AWAITING_RENEWAL_DECISION';
            const d = res.data;
            session.lastCardDetails = {
                name: d.subscriberName || d.name || "—",
                expiry: d.expiryDate || d.expireDate || "—",
                daysLeft: d.daysLeft ?? d.remainingDays ?? "—"
            };
            const name = d.subscriberName || d.name || "—";
            const expiry = d.expiryDate || d.expireDate || "—";
            const days = d.daysLeft ?? d.remainingDays ?? "—";
            const daysStr = typeof days === 'number' && days < 0
                ? `منتهي منذ ${Math.abs(days)} يوم ❗`
                : `${days} يوم`;
            finalReply = 
`🌟 *بيانات الكرت (منظومة الوادي)*

━━━━━━━━━━━━━━━━━
👤 *الاسم:* ${name}
🎫 *رقم الكرت:* ${cardNumber}
📅 *تاريخ الانتهاء:* ${expiry}
⏳ *الأيام المتبقية:* ${daysStr}
━━━━━━━━━━━━━━━━━

هل تريد تجديد الكرت؟ أرسل *نعم* أو اختر الباقة مباشرة:
1️⃣ شهرين بـ 3,000 ريال
2️⃣ 4 أشهر بـ 6,000 ريال
3️⃣ 6 أشهر بـ 9,000 ريال
4️⃣ سنة كاملة بـ 15,000 ريال`;
            replyMarkup = alWadiLookupKeyboard();
        } else if (res.code === 'SM_NOT_FOUND' || !res.success) {
            finalReply = `❌ رقم الكرت (${cardNumber}) غير موجود في منظومة الوادي.\nيرجى التأكد من صحة الرقم وإعادة المحاولة.`;
        } else {
            finalReply = `❌ ${res.message || "حدث خطأ أثناء الاستعلام."}`;
        }
    }
    // د. طلب الاستعلام بدون تحديد رقم الكرت في الرسالة (فقط إذا لم يكن طلب وادي)
    else if (isGeneralInquiry && !isAlWadiReq && !detectedCardNumber) {
        if (session.lastCardNumber) {
            console.log(`🔍 استعلام مجدد عن آخر كرت مرسل: ${session.lastCardNumber}`);
            const res = await callAlWadiAPI('/alwadi', {
                action: "lookup",
                number: session.lastCardNumber,
                mobile: targetMobile || session.registeredMobile || null
            });
            if (res.success && res.data) {
                const d = res.data;
                session.lastCardDetails = {
                    name: d.subscriberName || d.name || "—",
                    expiry: d.expiryDate || d.expireDate || "—",
                    daysLeft: d.daysLeft ?? d.remainingDays ?? "—"
                };
                const name = d.subscriberName || d.name || "—";
                const expiry = d.expiryDate || d.expireDate || "—";
                const days = d.daysLeft ?? d.remainingDays ?? "—";
                const daysStr = typeof days === 'number' && days < 0
                    ? `منتهي منذ ${Math.abs(days)} يوم ❗`
                    : `${days} يوم`;
                finalReply = 
`🌟 *بيانات الكرت (منظومة الوادي)*

━━━━━━━━━━━━━━━━━
👤 *الاسم:* ${name}
🎫 *رقم الكرت:* ${session.lastCardNumber}
📅 *تاريخ الانتهاء:* ${expiry}
⏳ *الأيام المتبقية:* ${daysStr}
━━━━━━━━━━━━━━━━━

هل تريد تجديد الكرت؟ أرسل *نعم* أو اختر الباقة مباشرة:
1️⃣ شهرين بـ 3,000 ريال
2️⃣ 4 أشهر بـ 6,000 ريال
3️⃣ 6 أشهر بـ 9,000 ريال
4️⃣ سنة كاملة بـ 15,000 ريال`;
                replyMarkup = alWadiLookupKeyboard();
            } else {
                finalReply = `📱 *خدمة الاستعلام:* \nيرجى إرسال *رقم الكرت* للاستعلام عنه في منظومة الوادي، أو أرسل اسم الشبكة (مثل: اس تي سي، الرشيدي) للاستعلام عن فئات كروت الواي فاي! ✨`;
            }
        } else {
            finalReply = `📱 *خدمة الاستعلام:* \nيرجى إرسال *رقم الكرت* للاستعلام عن اشتراكك في منظومة الوادي، أو أرسل اسم الشبكة (مثل: اس تي سي، الرشيدي) للاستعلام عن فئات الكروت المتاحة! ✨`;
        }
    }
    // هـ. الموافقة على التجديد بعد الاستعلام
    else if (session.state === 'AWAITING_RENEWAL_DECISION' && /(?:نعم|ايوه|أجل|تجديد|اريد|أريد|ابغى|أبغى|اجدد|أجدد)/i.test(lowerText)) {
        session.state = 'AWAITING_PACKAGE_SELECTION';
        replyMarkup = alWadiPackagesKeyboard();
        finalReply = 
`يرجى اختيار الباقة التي تريد تجديدها للكرت (${session.lastCardNumber}):

1️⃣ *شهرين* 👈 3,000 ريال (أرسل 1)
2️⃣ *4 أشهر* 👈 6,000 ريال (أرسل 2)
3️⃣ *6 أشهر* 👈 9,000 ريال (أرسل 3)
4️⃣ *سنة كاملة* 👈 15,000 ريال (أرسل 4)

أرسل الرقم المطلوب (1، 2، 3، أو 4)`;
    }
    // و. تنفيذ التجديد (سواء مع تحديد الكرت سابقاً أو تحديد الكرت والباقة في نفس الرسالة)
    else if ((detectedCardNumber || session.lastCardNumber) && /(?:تجديد|اشتراك|اجدد|أجدد|باقة|باقه|شهرين|أشهر|اشهر|سنة|سنه|عام|1|2|3|4|3000|6000|9000|15000)/i.test(lowerText)) {
        const targetCard = detectedCardNumber || session.lastCardNumber;
        let packageId = null;
        let packageName = "";
        let packagePrice = "";

        if (cleanText === "1" || lowerText.includes("شهرين") || lowerText.includes("3000")) {
            packageId = "1"; packageName = "شهرين"; packagePrice = "3,000";
        } else if (cleanText === "2" || /(?:اربعة|أربعة|اربعه|4 أشهر|4 اشهر|6000)/.test(lowerText)) {
            packageId = "3"; packageName = "4 أشهر"; packagePrice = "6,000";
        } else if (cleanText === "3" || /(?:ستة|سته|6 أشهر|6 اشهر|9000)/.test(lowerText)) {
            packageId = "7"; packageName = "6 أشهر"; packagePrice = "9,000";
        } else if (cleanText === "4" || lowerText.includes("سنة") || lowerText.includes("سنه") || lowerText.includes("عام") || lowerText.includes("15000")) {
            packageId = "9"; packageName = "سنة كاملة"; packagePrice = "15,000";
        }

        if (packageId && targetCard) {
            const verifiedMobile = getVerifiedCustomerMobile(senderPhone, session);
            if (!verifiedMobile) {
                session.state = 'AWAITING_MOBILE_REGISTRATION';
                finalReply = `📱 قبل تنفيذ التجديد، أرسل رقم هاتفك اليمني المسجل في ستار موبايل أولاً.`;
                return await safeSendMessage(bot, chatId, finalReply, {
                    reply_to_message_id: msg.message_id,
                    reply_markup: backKeyboard()
                });
            }
            console.log(`🔄 تجديد الكرت ${targetCard} - باقة ${packageId} (${packageName})`);
            const res = await callAlWadiAPI('/alwadi', {
                action: "renew",
                number: targetCard,
                packageId: packageId,
                mobile: verifiedMobile
            });
            console.log("AlWadi Renew Response:", JSON.stringify(res));
            if (res.success) {
                finalReply = `✅ تم تجديد باقة (${packageName}) للكرت (${targetCard}) بنجاح! 🎉\n💰 المبلغ المخصوم: ${packagePrice} ريال\nشكراً لك. ⭐`;
                session.state = null;
            } else if (res.code === 'SM_INSUFFICIENT_BALANCE') {
                finalReply = `❌ عذراً: رصيدك في ستار موبايل غير كافٍ لتجديد هذا الكرت (مطلوب: ${packagePrice} ريال).`;
            } else {
                finalReply = `❌ فشل التجديد: ${res.message || "حدث خطأ غير معروف."}`;
            }
        }
    }

    // ==========================================
    // 🌐 2. خدمة الشبكات (الواي فاي والكروت)
    // ==========================================
    if (!finalReply) {
        const isNetworksListReq = /(?:عرض الشبكات|الشبكات المتاحة|شبكات الواي فاي|كروت شبكات|الشبكات|شبكات)/i.test(lowerText) && !session.state && !lowerText.replace(/شبكة|شبكات|كروت/g, "").trim();

        if (isNetworksListReq) {
            console.log("🌐 جاري جلب قائمة الشبكات...");
            const res = await callNetworksAPI({ action: "list_networks", mobile: targetMobile || session.registeredMobile || null });
            if (res.success && Array.isArray(res.data) && res.data.length > 0) {
                session.availableNetworks = res.data;
                session.state = 'AWAITING_NETWORK_SELECTION';
                let netListStr = res.data.map((net, idx) => `${idx + 1}️⃣ ${net.name}${net.location ? ` (${net.location})` : ''}`).join("\n");
                finalReply = `🌐 الشبكات المتاحة حالياً:\n\n${netListStr}\n\nأرسل اسم الشبكة أو رقمها لعرض الفئات المتاحة للشراء.`;
            } else {
                finalReply = `❌ عذراً: ${res.message || "لا توجد شبكات متاحة حالياً."}`;
            }
        }
        // أ. متابعة سياق شبكة سابقة (إذا سأل: "ابغا باقات الكروت حقها" أو "حقها" والشبكة مسبقاً في الجلسة)
        else if (session.selectedNetwork && /(?:حقها|تبعها|باقاتها|فئاتها|الكروت|باقات|كروت|فئة|أسعار|اسعار)/i.test(lowerText) && !session.state) {
            console.log(`📶 جلب فئات الكروت للشبكة المحددة سابقاً: ${session.selectedNetwork.name}`);
            const res = await callNetworksAPI({ action: "list_classes", networkId: session.selectedNetwork.id });
            if (res.success && Array.isArray(res.data) && res.data.length > 0) {
                session.availableClasses = res.data;
                session.state = 'AWAITING_CARD_CLASS_SELECTION';
                let classesStr = res.data.map((c, idx) => {
                    const cleanValidity = formatValidity(c.validity);
                    return `${idx + 1}️⃣ ${c.name} — 💰 ${c.price} ريال${c.dataLimit && c.dataLimit !== '--' ? ` | 📊 ${c.dataLimit}` : ''}${cleanValidity ? ` | ⏳ ${cleanValidity}` : ''}`;
                }).join("\n");
                const selectedNetworkLabel = session.selectedNetwork.location
                    ? `${session.selectedNetwork.name} - ${session.selectedNetwork.location}`
                    : session.selectedNetwork.name;
                finalReply = `📶 فئات كروت ${selectedNetworkLabel} المتاحة:\n\n${classesStr}\n\nأرسل اسم الفئة (مثلاً: أبو 700) أو سعرها أو رقمها لشراء الكرت فوراً.`;
                replyMarkup = backKeyboard();
            } else {
                finalReply = `❌ لا تتوفر فئات كروت حالياً لشبكة ${session.selectedNetwork.name}.`;
            }
        }
        // ب. اختيار الفئة أو شراء الكرت
        else if (session.state === 'AWAITING_CARD_CLASS_SELECTION' && session.selectedNetwork && session.availableClasses) {
            let selectedClass = null;

            const numChoice = parseInt(cleanText, 10);
            if (!isNaN(numChoice) && numChoice >= 1 && numChoice <= session.availableClasses.length) {
                selectedClass = session.availableClasses[numChoice - 1];
            }

            if (!selectedClass) {
                const matchedNumbers = cleanText.match(/\d+/g) || [];
                selectedClass = session.availableClasses.find(c => {
                    const cName = (c.name || "").toLowerCase();
                    const cPriceStr = c.price ? c.price.toString() : "";
                    const priceMatched = matchedNumbers.some(num => num === cPriceStr || cName.includes(num));
                    const nameMatched = lowerText.includes(cName);
                    return priceMatched || nameMatched;
                });
            }

            if (selectedClass) {
                // ✅ بدلاً من الشراء الفوري، نعرض تفاصيل الكرت ونطلب التأكيد
                const cleanValidity = formatValidity(selectedClass.validity);
                session.pendingOrder = { classId: selectedClass.id, className: selectedClass.name, classPrice: selectedClass.price, classData: selectedClass.dataLimit, classValidity: cleanValidity };
                session.state = 'AWAITING_ORDER_CONFIRMATION';

                finalReply = `🛒 *تفاصيل الكرت المطلوب:*

🌐 *الشبكة:* ${session.selectedNetwork.name}
📦 *الفئة:* ${selectedClass.name}${selectedClass.dataLimit && selectedClass.dataLimit !== '--' ? `
📊 *الحجم:* ${selectedClass.dataLimit}` : ''}${cleanValidity ? `
⏳ *الصلاحية:* ${cleanValidity}` : ''}
💰 *السعر:* ${selectedClass.price} ريال يمني

━━━━━━━━━━━━━
⚠️ *هل تريد إتمام عملية الشراء؟*

✅ أرسل *نعم* للتأكيد والشراء
❌ أرسل *لا* للإلغاء`;
            }
        }

        // ب.2 تأكيد أو إلغاء الطلب
        else if (session.state === 'AWAITING_ORDER_CONFIRMATION' && session.pendingOrder) {
            const isConfirmed = /^(نعم|ايوه|أيوه|اوك|أوك|موافق|اشتري|أشتري|تمام|اكيد|أكيد|ok|yes)$/i.test(cleanText.trim());
            const isCancelled = /^(لا|لأ|الغاء|إلغاء|cancel|no|لا شكرا|وقف|بطل)$/i.test(cleanText.trim());

            if (isConfirmed) {
                const { classId, className, classPrice } = session.pendingOrder;
                const verifiedMobile = getVerifiedCustomerMobile(senderPhone, session);
                if (!verifiedMobile) {
                    session.state = 'AWAITING_MOBILE_REGISTRATION';
                    finalReply = `📱 قبل تنفيذ الشراء، أرسل رقم هاتفك اليمني المسجل في ستار موبايل أولاً.`;
                    return;
                }
                console.log(`🛒 جاري تنفيذ الشراء المؤكد: ${session.selectedNetwork.name} - ${className} (${classPrice} ريال)`);
                const res = await callNetworksAPI({
                    action: "order",
                    networkId: session.selectedNetwork.id,
                    classId: classId,
                    mobile: verifiedMobile
                });
                console.log("Networks Order Response:", JSON.stringify(res));

                if (res.success && res.data) {
                    finalReply = `🎉 *تم شراء الكرت بنجاح!*

🌐 *الشبكة:* ${session.selectedNetwork.name}
📦 *الفئة:* ${className}
🎫 *رقم الكرت / الكود:* ${res.data.cardNumber}${res.data.cardPassword ? `
🔑 *كلمة السر:* ${res.data.cardPassword}` : ''}
💰 *السعر:* ${res.data.price || classPrice} ريال
🔖 *رقم العملية:* ${res.transactionId || '-'}

شكراً لاستخدامك خدماتنا! ⭐`;
                    session.state = null; session.selectedNetwork = null; session.availableClasses = null; session.pendingOrder = null;
                } else if (res.code === 'SM_INSUFFICIENT_BALANCE') {
                    finalReply = `❌ عذراً: رصيدك في ستار موبايل غير كافٍ لشراء هذا الكرت (سعر الكرت: ${classPrice} ريال).\nيرجى شحن حسابك ثم إعادة المحاولة.`;
                    session.state = null; session.pendingOrder = null;
                } else if (res.code === 'SM_PROVIDER_ERROR') {
                    finalReply = `❌ عذراً: نفد المخزون حالياً من فئة (${className})، يرجى اختيار فئة أخرى.`;
                    session.state = 'AWAITING_CARD_CLASS_SELECTION'; session.pendingOrder = null;
                } else {
                    finalReply = `❌ فشلت عملية الشراء: ${res.message || "حدث خطأ غير معروف."}\nيمكنك المحاولة مرة أخرى أو اختيار فئة مختلفة.`;
                    session.state = null; session.pendingOrder = null;
                }
            } else if (isCancelled) {
                session.state = null; session.selectedNetwork = null; session.availableClasses = null; session.pendingOrder = null;
                finalReply = `❌ *تم إلغاء عملية الشراء.*

لا يوجد أي خصم من رصيدك. يمكنك اختيار فئة أخرى أو طلب المساعدة في أي وقت. 😊`;
            } else {
                finalReply = `⚠️ *لم نفهم ردك.*

للتأكيد والشراء أرسل: *نعم*
للإلغاء أرسل: *لا*`;
            }
        }
        
        // ج. البحث عن شبكة بالاسم (في أي صيغة أو لهجة: تعرف شبكة الرشيدي، عندكم الرشيدي، باقات الرشيدي...)
        if (!finalReply) {
            if (!session.availableNetworks) {
                const res = await callNetworksAPI({ action: "list_networks" });
                if (res.success && Array.isArray(res.data)) session.availableNetworks = res.data;
            }

            let matchedNet = null;
            if (session.availableNetworks) {
                if (session.state === 'AWAITING_NETWORK_SELECTION') {
                    const netNum = parseInt(cleanText, 10);
                    if (!isNaN(netNum) && netNum >= 1 && netNum <= session.availableNetworks.length) {
                        matchedNet = session.availableNetworks[netNum - 1];
                    }
                }
                if (!matchedNet) {
                    matchedNet = findNetworkInText(textMessage, session.availableNetworks);
                }
            }

            if (matchedNet) {
                console.log(`📶 تم العثور على شبكة مطابقة: ${matchedNet.name}`);
                session.selectedNetwork = matchedNet;
                const res = await callNetworksAPI({ action: "list_classes", networkId: matchedNet.id });
                console.log("Networks Classes Response:", JSON.stringify(res));
                if (res.success && Array.isArray(res.data) && res.data.length > 0) {
                    session.availableClasses = res.data;
                    session.state = 'AWAITING_CARD_CLASS_SELECTION';
                    
                    const matchedNumbers = cleanText.match(/\d+/g) || [];
                    let directClass = res.data.find(c => {
                        const cPriceStr = c.price ? c.price.toString() : "";
                        return matchedNumbers.some(num => num === cPriceStr || (c.name || "").includes(num));
                    });

                    if (directClass) {
                        // ✅ شراء مباشر بنفس الرسالة → عرض التأكيد بدلاً من الشراء الفوري
                        console.log(`🛒 طلب شراء مباشر في نفس الرسالة: فئة ${directClass.name} (${directClass.price} ريال)`);
                        const cleanValidity = formatValidity(directClass.validity);
                        session.pendingOrder = { classId: directClass.id, className: directClass.name, classPrice: directClass.price, classData: directClass.dataLimit, classValidity: cleanValidity };
                        session.state = 'AWAITING_ORDER_CONFIRMATION';

                        finalReply = `🛒 *تفاصيل الكرت المطلوب:*

🌐 *الشبكة:* ${matchedNet.name}
📦 *الفئة:* ${directClass.name}${directClass.dataLimit && directClass.dataLimit !== '--' ? `
📊 *الحجم:* ${directClass.dataLimit}` : ''}${cleanValidity ? `
⏳ *الصلاحية:* ${cleanValidity}` : ''}
💰 *السعر:* ${directClass.price} ريال يمني

━━━━━━━━━━━━━
⚠️ *هل تريد إتمام عملية الشراء؟*

✅ أرسل *نعم* للتأكيد والشراء
❌ أرسل *لا* للإلغاء`;
                    } else {
                        let classesStr = res.data.map((c, idx) => {
                            const cleanValidity = formatValidity(c.validity);
                            return `${idx + 1}️⃣ ${c.name} — 💰 ${c.price} ريال${c.dataLimit && c.dataLimit !== '--' ? ` | 📊 ${c.dataLimit}` : ''}${cleanValidity ? ` | ⏳ ${cleanValidity}` : ''}`;
                        }).join("\n");
                        const selectedNetworkLabel = matchedNet.location
                            ? `${matchedNet.name} - ${matchedNet.location}`
                            : matchedNet.name;
                        finalReply = `📶 نعم، متوفرة لدينا شبكة (${selectedNetworkLabel})!\n\nإليك الفئات المتاحة:\n${classesStr}\n\nأرسل اسم الفئة (مثلاً: أبو 700) أو سعرها أو رقمها لشراء الكرت فوراً.`;
                        replyMarkup = backKeyboard();
                    }
                } else {
                    finalReply = `❌ شبكة ${matchedNet.name} متوفرة لدينا، ولكن لا تتوفر فئات كروت حالياً لهذه الشبكة.`;
                }
            }
        }
    }

    // ==========================================
    // 🤖 3. الذكاء الاصطناعي كـ Fallback (مع الذاكرة)
    // ==========================================
    if (!finalReply) {
        finalReply = await generateFastAIResponse(textMessage, session.history, pushName);
    }

    addToHistory("model", finalReply);

    await safeSendMessage(bot, chatId, finalReply, {
        reply_to_message_id: msg.message_id,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    console.log(`🤖 الرد:\n${finalReply}\n`);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || 2000;
if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN غير موجود في المتغيرات البيئية.");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: {
        interval: TELEGRAM_POLL_INTERVAL_MS,
        autoStart: true
    }
});

bot.on("polling_error", (error) => {
    console.error("⚠️ خطأ في Telegram polling:", error.message || error);
});

bot.on("callback_query", async (query) => {
    try {
        await handleMenuCallback(bot, query);
    } catch (error) {
        console.error("⚠️ خطأ في زر تفاعلي:", error.message || error);
        try {
            await bot.answerCallbackQuery(query.id, { text: "حدث خطأ، حاول مرة أخرى.", show_alert: true });
        } catch (answerError) {
            console.error("⚠️ تعذر إرسال تنبيه الزر:", answerError.message || answerError);
        }
    }
});

bot.on("message", async (msg) => {
    try {
        const chatId = msg.chat?.id;
        if (!chatId) return;

        const senderId = msg.from?.id?.toString() || chatId.toString();
        const pushName = msg.from?.username || `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() || "العميل";
        const textMessage = msg.text || msg.caption || "";
        const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });

        if (/^\/start(?:@\w+)?(?:\s|$)/i.test(msg.text || "")) {
            if (isAccountLinked(senderId)) {
                await sendMainMenu(bot, chatId);
            } else {
                session.state = "LINKING_AWAITING_PHONE";
                await sendLinkingPrompt(bot, chatId);
            }
            return;
        }

        console.log("📩 [Telegram رسالة واردة]:", JSON.stringify({
            chatId,
            senderId,
            username: msg.from?.username,
            firstName: msg.from?.first_name,
            lastName: msg.from?.last_name,
            text: textMessage,
            messageId: msg.message_id
        }, null, 2));

        if (!isAccountLinked(senderId)) {
            const cleanInput = textMessage.trim();
            if (session.state === "LINKING_AWAITING_PHONE") {
                const mobile = formatMobileForAPI(cleanInput);
                if (!isValidLinkingMobile(mobile)) {
                    await safeSendMessage(bot, chatId, "❌ الرقم غير صحيح. أرسل رقمًا يبدأ بـ 7 ويتكون من 9 أرقام، مثال: 770326828", { reply_markup: linkingKeyboard() });
                    return;
                }

                const accountResponse = await callAlWadiAPI(`/balance?mobile=${encodeURIComponent(mobile)}`);
                if (!accountResponse.success || !accountResponse.data) {
                    await safeSendMessage(bot, chatId, "❌ لم يتم العثور على حساب بهذا الرقم في تطبيق ستار موبايل. أرسل رقم الحساب المسجل الصحيح.", { reply_markup: linkingKeyboard() });
                    return;
                }

                const code = String(crypto.randomInt(1000, 10000));
                const smsResult = await sendLinkingOtp(mobile, code);
                if (!smsResult.success) {
                    await safeSendMessage(bot, chatId, `❌ ${smsResult.message}\n\nتعذر بدء الربط حاليًا، حاول لاحقًا.`, { reply_markup: linkingKeyboard() });
                    return;
                }

                session.state = "LINKING_AWAITING_OTP";
                session.linkingOtp = {
                    mobile,
                    hash: hashOtp(code),
                    expiresAt: Date.now() + OTP_TTL_MS,
                    attempts: 0
                };
                await safeSendMessage(bot, chatId, "✅ تم إرسال رمز التحقق إلى رقمك المسجل في تطبيق ستار موبايل.\n\nأرسل الرمز المكون من 4 أرقام خلال 10 دقائق.", { reply_markup: linkingKeyboard() });
                return;
            }

            if (session.state === "LINKING_AWAITING_OTP") {
                const code = cleanInput.replace(/\D/g, "");
                const otp = session.linkingOtp;
                if (!otp || Date.now() > otp.expiresAt) {
                    session.state = "LINKING_AWAITING_PHONE";
                    session.linkingOtp = null;
                    await safeSendMessage(bot, chatId, "⌛ انتهت صلاحية الرمز. اضغط «ربط حسابي» وابدأ من جديد.", { reply_markup: linkingKeyboard() });
                    return;
                }
                if (!/^\d{4}$/.test(code)) {
                    await safeSendMessage(bot, chatId, "❌ أرسل رمز التحقق المكون من 4 أرقام فقط.", { reply_markup: linkingKeyboard() });
                    return;
                }
                otp.attempts += 1;
                if (otp.attempts > OTP_MAX_ATTEMPTS || hashOtp(code) !== otp.hash) {
                    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
                        session.state = "LINKING_AWAITING_PHONE";
                        session.linkingOtp = null;
                    }
                    await safeSendMessage(bot, chatId, "❌ رمز التحقق غير صحيح.", { reply_markup: linkingKeyboard() });
                    return;
                }

                session.linkingOtp = null;
                session.state = null;
                await finishAccountLinking(bot, chatId, senderId, otp.mobile);
                return;
            }

            session.state = "LINKING_AWAITING_PHONE";
            await sendLinkingPrompt(bot, chatId);
            return;
        }

        const mediaObj = getTelegramMediaObject(msg);
        if (mediaObj) {
            console.log(`⚡ إيصال (${mediaObj.type}) من ${senderId} (${pushName})...`);
            try {
                const buffer = await downloadTelegramFile(bot, mediaObj.fileId);
                if (!buffer || buffer.length === 0) throw new Error("بافر الملف فارغ");
                const result = await analyzeReceipt(buffer, mediaObj.mimeType, GEMINI_API_KEY);
                if (!result.success || !result.data || !result.data.isValidReceipt) {
                    await safeSendMessage(bot, chatId, formatInvalidReceiptMessage(result.data?.rejectReason || result.error), { reply_to_message_id: msg.message_id });
                    return;
                }
                const receiptData = result.data;
                console.log("📑 بيانات الإيصال:", receiptData);
                const authCheck = isReceiptAuthorized(receiptData);
                if (!authCheck.authorized) {
                    await safeSendMessage(bot, chatId, `⚠️ إيقاف الإيصال: ${authCheck.reason}. تواصل مع الإدارة.`, { reply_to_message_id: msg.message_id });
                    if (ADMIN_CHAT_ID) {
                        await safeSendMessage(bot, ADMIN_CHAT_ID, `إيصال غير مصدق من ${senderId}: ${authCheck.reason}`);
                    }
                    return;
                }

                const userMobilesMap = loadUserMobiles();
                const senderMobile = formatMobileForAPI(senderId);
                const registeredMobile = userMobilesMap[senderId]
                    || userSessions[senderId]?.registeredMobile
                    || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
                if (!registeredMobile) {
                    await safeSendMessage(bot, chatId,
                        `📱 قبل أن أضيف الإيصال، يرجى إرسال رقم هاتفك اليمني المسجل في ستار موبايل أولاً (مثل: 770326828).
هذا الرقم هو الذي سأستخدمه لربط الإيصال بحسابك في التطبيق.`,
                        { reply_to_message_id: msg.message_id }
                    );
                    return;
                }

                const creditResult = await creditUserAccount(registeredMobile, receiptData.amount, receiptData.receiptNo, {
                    ...receiptData,
                    transferCompany: receiptData.transferCompany
                });
                if (!creditResult.success) {
                    if (creditResult.alreadyProcessed) {
                        await safeSendMessage(bot, chatId, formatDuplicateReceiptMessage(receiptData.receiptNo), { reply_to_message_id: msg.message_id });
                        return;
                    }
                    await safeSendMessage(bot, chatId, `❌ فشل شحن الإيصال: ${creditResult.message || "حدث خطأ أثناء المزامنة مع التطبيق."}`, { reply_to_message_id: msg.message_id });
                    return;
                }
                const successMsg = formatSuccessMessage({
                    customerName: creditResult.customerName,
                    amount: creditResult.addedAmount,
                    currency: creditResult.currency,
                    receiptNo: receiptData.receiptNo,
                    currentBalance: creditResult.newBalance,
                    date: receiptData.date,
                    transferCompany: receiptData.transferCompany,
                    senderName: receiptData.fromAccountName || receiptData.senderName
                });
                await safeSendMessage(bot, chatId, successMsg, { reply_to_message_id: msg.message_id });
                console.log(`✅ تم تأكيد الشحن بنجاح!\n`);
            } catch (err) {
                console.error("❌ خطأ أثناء معالجة الإيصال:", err.message);
                await safeSendMessage(bot, chatId, formatInvalidReceiptMessage("يرجى إرسال صورة أو PDF عادي وواضح للإيصال."), { reply_to_message_id: msg.message_id });
            }
            return;
        }

        if (textMessage) {
            console.log(`📩 رسالة من (${senderId} - ${pushName}): ${textMessage}`);
            await handleTextMessage(textMessage, chatId, senderId, pushName, bot, msg);
        }
    } catch (err) {
        console.error("⚠️ تنبيه معالجة الرسائل:", err.message);
    }
});

console.log("✅ Telegram bot started.");
