const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const envPaths = [path.resolve(__dirname, "../.env"), path.resolve(__dirname, ".env")];
const envPath = envPaths.find(filePath => fs.existsSync(filePath));
require('dotenv').config(envPath ? { path: envPath } : {});
const TelegramBot = require("node-telegram-bot-api");
const { analyzeReceipt } = require("./receiptAnalyzer");
const { getUserAccount, creditUserAccount, isReceiptAuthorized, formatReceiptDate } = require("./starMobileApi");
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

// ===== ربط الحساب عبر OTP من Star SMS =====
const SMS_API_URL = "https://star-sms.vercel.app/api/messages";
const SMS_API_KEY = process.env.SMS_API_KEY;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

// ===== جلسات المستخدمين =====
const userSessions = {};

// ===== حفظ واسترجاع أرقام المستخدمين المسجلة عبر Firebase Firestore =====
const {
    db,
    getUserMobileFromFirebase,
    saveUserMobileToFirebase,
    getAllUserMobilesFromFirebase
} = require("./firebaseAdmin");

async function getUserMobile(senderId) {
    return await getUserMobileFromFirebase(senderId);
}

async function saveUserMobile(senderId, mobile, extraData = {}) {
    return await saveUserMobileToFirebase(senderId, mobile, extraData);
}

function isValidLinkingMobile(phone) {
    return /^7\d{8}$/.test(String(phone || "").trim());
}

async function isAccountLinked(senderId) {
    const mobile = await getUserMobileFromFirebase(senderId);
    return isValidLinkingMobile(mobile);
}

function linkingKeyboard() {
    return { inline_keyboard: [[{ text: "ربط حسابي", callback_data: "link_account" }]] };
}

function contactRequestKeyboard() {
    return {
        keyboard: [
            [{ text: "📱 إرسال رقم هاتفي تلقائياً", request_contact: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    };
}

function linkingMessage() {
    return `🔗 *اربط حسابك في ستار موبايل*

للحصول على خدماتك بشكل آمن، يجب ربط حسابك المسجل في تطبيق ستار موبايل بهذا البوت.

سيتم إرسال رمز تحقق OTP إلى رقمك المسجل، وبعد التحقق ستتمكن من استخدام جميع الخدمات والاطلاع على بيانات حسابك.`;
}

function linkingPromptMessage() {
    return `📱 *يرجى إرسال رقم هاتفك المسجل في ستار موبايل*

لإكمال الربط والتحقق:
1️⃣ اضغط على زر *«📱 إرسال رقم هاتفي تلقائياً»* بالأسفل.
2️⃣ أو اكتب رقم جوالك يدوياً (يبدأ بـ 7 ويتكون من 9 أرقام، مثال: \`770326828\`).

سيصلك رمز تحقق OTP عبر رسالة SMS للتأكيد فوراً.`;
}

function hashOtp(code) {
    return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function sendLinkingOtp(phone, code) {
    if (!SMS_API_KEY) {
        return {
            success: false,
            message: "إعدادات إرسال رمز التحقق غير مكتملة لدى الإدارة."
        };
    }

    try {
        // إزالة أي رموز مثل +967 أو المسافات
        let cleanPhone = String(phone).replace(/\D/g, "");

        // إذا كان الرقم يبدأ بـ 967 نحوله إلى رقم محلي
        if (cleanPhone.startsWith("967")) {
            cleanPhone = cleanPhone.substring(3);
        }

        const response = await fetch(SMS_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": SMS_API_KEY
            },
            body: JSON.stringify({
                phone: cleanPhone,
                message: `رمز التحقق لربط حسابك في ستار موبايل هو: ${code}. صالح لمدة 10 دقائق.`
            })
        });

        const responseText = await response.text();

        let data = {};

        try {
            data = responseText ? JSON.parse(responseText) : {};
        } catch (error) {
            data = { raw: responseText };
        }

        if (!response.ok) {
            console.error(
                "Star SMS OTP error:",
                response.status,
                responseText
            );

            return {
                success: false,
                message: data.error || data.message || "تعذر إرسال رمز التحقق إلى الهاتف."
            };
        }

        console.log("تم إرسال OTP بنجاح:", cleanPhone);

        return {
            success: true,
            data
        };

    } catch (error) {
        console.error(
            "Star SMS connection error:",
            error.message
        );

        return {
            success: false,
            message: "تعذر الاتصال بخدمة الرسائل حالياً."
        };
    }
}

async function sendLinkingPrompt(bot, chatId) {
    await safeSendMessage(bot, chatId, linkingPromptMessage(), { reply_markup: contactRequestKeyboard() });
}

async function finishAccountLinking(bot, chatId, senderId, mobile, pushName = "") {
    const balanceResponse = await callAlWadiAPI(`/balance?mobile=${encodeURIComponent(mobile)}`);
    if (!balanceResponse.success || !balanceResponse.data) {
        await safeSendMessage(bot, chatId, "❌ لم يتم العثور على حساب بهذا الرقم في تطبيق ستار موبايل. تأكد من الرقم وحاول مرة أخرى.", { reply_markup: contactRequestKeyboard() });
        return false;
    }

    await saveUserMobile(senderId, mobile, {
        name: pushName,
        chatId: chatId,
        linkedAt: new Date().toISOString()
    });
    const account = balanceResponse.data;
    const accountName = account.user || account.name || account.fullName || account.customerName || "المشترك العزيز";
    const accountBalance = account.balance ?? 0;
    const currency = account.currency === "YER" ? "ريال يمني" : (account.currency || "ريال يمني");
    await safeSendMessage(bot, chatId, `✅ *تم ربط حسابك وحفظه بنجاح*

مرحبًا بك، *${accountName}* 👋

📱 رقم المشترك: \`${mobile}\`
💰 الرصيد الحالي: *${accountBalance} ${currency}*

أصبح حسابك جاهزًا لاستخدام جميع خدمات ستار موبايل.`, { reply_markup: mainMenuKeyboard() });
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
            try {
                lastSent = await bot.sendMessage(chatId, chunks[index], sendOptions);
            } catch (sendError) {
                if (!/can't parse entities|parse entities|can't find end/i.test(sendError.message || "")) {
                    throw sendError;
                }
                const plainTextOptions = { ...sendOptions };
                delete plainTextOptions.parse_mode;
                lastSent = await bot.sendMessage(chatId, chunks[index], plainTextOptions);
            }
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
            [{ text: "خدمات الاتصالات", callback_data: "menu_telecom" }],
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

const TELECOM_SERVICES = [
    { code: "yem", name: "يمن موبايل", actions: ["query", "solfa", "queryoffer", "bill", "billoffer"] },
    { code: "you", name: "YOU", actions: ["query", "queryoffer", "bill", "billoffer"] },
    { code: "yem4g", name: "يمن فورجي", actions: ["query", "bill"] },
    { code: "post", name: "الهاتف الثابت والإنترنت", actions: ["query", "bill"] },
    { code: "adenet", name: "عدن نت", actions: ["query", "bill"] }
];

function telecomServicesKeyboard() {
    return {
        inline_keyboard: [
            TELECOM_SERVICES.slice(0, 2).map(service => ({ text: service.name, callback_data: `telecom_service_${service.code}` })),
            TELECOM_SERVICES.slice(2, 4).map(service => ({ text: service.name, callback_data: `telecom_service_${service.code}` })),
            [{ text: TELECOM_SERVICES[4].name, callback_data: `telecom_service_${TELECOM_SERVICES[4].code}` }],
            [{ text: "الرئيسية", callback_data: "menu_home" }]
        ]
    };
}

function telecomActionsKeyboard(service) {
    if (service.code === "post") {
        return { inline_keyboard: [
            [{ text: "استعلام الإنترنت", callback_data: "telecom_query_post_query_adsl" }],
            [{ text: "استعلام الهاتف الثابت", callback_data: "telecom_query_post_query_line" }],
            [{ text: "سداد", callback_data: "telecom_pay_post_bill" }],
            [{ text: "اختيار شركة أخرى", callback_data: "menu_telecom" }],
            [{ text: "الرئيسية", callback_data: "menu_home" }]
        ] };
    }
    const buttons = [
        [{ text: service.code === "yem" ? "استعلام شامل" : "استعلام الرصيد", callback_data: `telecom_query_${service.code}_query` }],
        ...(service.code !== "yem" && service.actions.includes("solfa") ? [[{ text: "استعلام السلفة", callback_data: `telecom_query_${service.code}_solfa` }]] : []),
        ...(service.code !== "yem" && service.actions.includes("queryoffer") ? [[{ text: "استعلام الباقات", callback_data: `telecom_query_${service.code}_queryoffer` }]] : []),
        ...(service.actions.includes("bill") ? [[{ text: "سداد رصيد", callback_data: `telecom_pay_${service.code}_bill` }]] : []),
        ...(service.actions.includes("billoffer") ? [[{ text: "سداد باقة", callback_data: `telecom_pay_${service.code}_billoffer` }]] : []),
        [{ text: "اختيار شركة أخرى", callback_data: "menu_telecom" }],
        [{ text: "الرئيسية", callback_data: "menu_home" }]
    ];
    return { inline_keyboard: buttons };
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

function getAlWadiResponseData(response) {
    return response?.data?.data || response?.data || response?.result || response || {};
}

function getAlWadiCardValue(response) {
    const data = getAlWadiResponseData(response);
    return data.cardNumber || data.cardNo || data.cardCode || data.number || data.card || "";
}

function formatAlWadiRenewalResult(response, cardNumber, packageName, packagePrice) {
    const data = getAlWadiResponseData(response);
    const expiry = data.expiryDate || data.expireDate || data.expirationDate || data.expiry || "";
    const days = data.daysLeft ?? data.remainingDays ?? data.days ?? "";
    const returnedCard = getAlWadiCardValue(response);
    const cardLine = returnedCard ? `\n🎫 *الكرت:* ${returnedCard}` : `\n🎫 *الكرت:* ${cardNumber}`;
    const expiryLine = expiry ? `\n📅 *تاريخ الانتهاء:* ${expiry}` : "";
    const daysLine = days !== "" ? `\n⏳ *الأيام المتبقية:* ${days}` : "";
    return `✅ *تم التجديد بنجاح*${cardLine}\n📦 *الباقة:* ${packageName}\n💰 *المبلغ المخصوم:* ${packagePrice} ريال${expiryLine}${daysLine}\n\nتم التحقق من بيانات الاشتراك الجديدة من النظام.`;
}

async function sendMainMenu(bot, chatId, messageId) {
    const text = `🌟 *مرحبًا بك في ستار موبايل*

أهلًا وسهلًا بك في تطبيق ستار موبايل 💙
منصتك الموثوقة لإدارة خدماتك بكل سهولة وسرعة.

🚀 *من مكان واحد يمكنك:*
• 👤 إدارة حسابك ومتابعة رصيدك
• 📡 الاستعلام وتجديد منظومة الوادي
• 🌐 الاطلاع على خدمات وباقات الإنترنت
• 📱 الاستعلام والسداد لشركات الاتصالات
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
        if (await isAccountLinked(senderId)) {
            await safeSendMessage(bot, chatId, "✅ حسابك مربوط مسبقًا ولا يمكن تغييره من هذا البوت.", { reply_markup: mainMenuKeyboard() });
            return;
        }
        const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });
        session.state = "LINKING_AWAITING_PHONE";
        await safeSendMessage(bot, chatId, linkingPromptMessage(), { reply_markup: contactRequestKeyboard() });
        return;
    }

    if (!(await isAccountLinked(senderId))) {
        await sendLinkingPrompt(bot, chatId);
        return;
    }

    const session = userSessions[senderId] || (userSessions[senderId] = { history: [], state: null });

    if (query.data === "menu_telecom") {
        await safeSendMessage(bot, chatId, "📱 *خدمات الاتصالات*\n\nاختر الشركة للاستعلام أو السداد:", { reply_markup: telecomServicesKeyboard() });
        return;
    }

    if (query.data.startsWith("telecom_service_")) {
        const serviceCode = query.data.replace("telecom_service_", "");
        const service = TELECOM_SERVICES.find(item => item.code === serviceCode);
        if (!service) return;
        await safeSendMessage(bot, chatId, `📱 *${service.name}*\n\nاختر نوع العملية:`, { reply_markup: telecomActionsKeyboard(service) });
        return;
    }

    if (query.data.startsWith("telecom_query_")) {
        const parts = query.data.split("_");
        const serviceCode = parts[2];
        const action = parts[3];
        const type = parts[4];
        const service = TELECOM_SERVICES.find(item => item.code === serviceCode);
        const verifiedMobile = await getVerifiedCustomerMobile(senderId, userSessions[senderId]);
        if (!service || !verifiedMobile) {
            await safeSendMessage(bot, chatId, "تعذر تحديد حسابك الموثق. أعد ربط الحساب ثم حاول مرة أخرى.", { reply_markup: backKeyboard() });
            return;
        }
        session.state = "AWAITING_TELECOM_NUMBER";
        session.pendingTelecomQuery = { service: serviceCode, action, type, serviceName: service.name };
        await safeSendMessage(bot, chatId, `📱 *${service.name}*\n\nأرسل رقم الهاتف أو الحساب الذي تريد الاستعلام عنه.`, { reply_markup: telecomActionsKeyboard(service) });
        return;
    }

    if (query.data.startsWith("telecom_pay_")) {
        const parts = query.data.split("_");
        const serviceCode = parts[2];
        const action = parts[3];
        const service = TELECOM_SERVICES.find(item => item.code === serviceCode);
        const payerMobile = await getVerifiedCustomerMobile(senderId, userSessions[senderId]);
        if (!service || !payerMobile) {
            await safeSendMessage(bot, chatId, "تعذر تحديد حسابك الموثق. أعد ربط الحساب ثم حاول مرة أخرى.", { reply_markup: backKeyboard() });
            return;
        }
        session.state = "AWAITING_TELECOM_NUMBER_FOR_PAYMENT";
        session.pendingTelecomPayment = { service: serviceCode, action, payerMobile, serviceName: service.name };
        await safeSendMessage(bot, chatId, `💳 *${service.name}*\n\nأرسل رقم الهاتف أو الحساب المراد السداد له.\n\nبعد ذلك سيُطلب مبلغ السداد، ويكون الدافع هو حسابك الموثق.`, { reply_markup: telecomActionsKeyboard(service) });
        return;
    }

    if (query.data === "alwadi_renew" || query.data === "alwadi_details" || query.data.startsWith("alwadi_package_")) {
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

        const targetMobile = await getVerifiedCustomerMobile(senderId, session);
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
            console.log("AlWadi Renew Response:", JSON.stringify(result));
            const verification = await callAlWadiAPI("/alwadi", {
                action: "lookup",
                number: session.lastCardNumber,
                mobile: targetMobile
            });
            console.log("AlWadi Renewal Verification:", JSON.stringify(verification));
            const verifiedResponse = verification.success ? verification : result;
            session.state = null;
            await bot.editMessageText(formatAlWadiRenewalResult(verifiedResponse, session.lastCardNumber, selectedPackage.name, selectedPackage.price), {
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
        const senderMobile = formatMobileForAPI(senderId);
        const storedMobile = await getUserMobile(senderId);
        const mobile = storedMobile || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
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
        const senderMobile = formatMobileForAPI(senderId);
        const storedMobile = await getUserMobile(senderId);
        const mobile = storedMobile || session.registeredMobile || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
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

async function callTelecomQuery(service, action, mobile, type) {
    const params = new URLSearchParams({
        service,
        action,
        mobile
    });
    if (type) params.set("type", type);
    try {
        const response = await fetch(`${ALWADI_BASE_URL}/query?${params.toString()}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${MASTER_API_TOKEN}`,
                "Accept": "application/json"
            }
        });
        const data = await response.json();
        return response.ok ? data : { success: false, statusCode: response.status, ...data };
    } catch (error) {
        console.error("Telecom query API error:", error.message);
        return { success: false, message: "حدث خطأ أثناء الاستعلام من شركة الاتصالات." };
    }
}

async function callTelecomPayment(service, action, mobile, amount, payerMobile) {
    try {
        const response = await fetch(`${ALWADI_BASE_URL}/pay`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${MASTER_API_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({ service, action, mobile, amount, payerMobile })
        });
        const data = await response.json();
        return response.ok ? data : { success: false, statusCode: response.status, ...data };
    } catch (error) {
        console.error("Telecom payment API error:", error.message);
        return { success: false, message: "حدث خطأ أثناء تنفيذ السداد." };
    }
}

function formatTelecomPayload(label, response) {
    if (response?.success !== true) {
        const message = extractArabicTelecomText(response?.message);
        return `❌ ${label}: ${message || "تعذر جلب البيانات من شركة الاتصالات."}`;
    }
    const data = response.data || response.result || response;
    const usefulText = extractArabicTelecomText(data);
    if (usefulText) return `✅ *${label}:*\n${usefulText}`;
    return `✅ *${label}:*\nلا توجد تفاصيل إضافية متاحة.`;
}

function extractArabicTelecomText(value) {
    if (typeof value === "string") {
        const text = value.replace(/\s+/g, " ").trim();
        return /[\u0600-\u06FF]/.test(text) ? text : "";
    }
    if (!value || typeof value !== "object") return "";

    const preferredKeys = ["message", "msg", "description", "statusMessage", "resultMessage", "text"];
    for (const key of preferredKeys) {
        const message = extractArabicTelecomText(value[key]);
        if (message) return message;
    }

    if (Array.isArray(value)) {
        const items = value.map(item => extractArabicTelecomText(item)).filter(Boolean);
        return [...new Set(items)].join("\n");
    }

    const lines = [];
    const fieldLabels = {
        balance: "الرصيد",
        credit: "الرصيد",
        amount: "المبلغ",
        debt: "المستحق",
        loan: "السلفة",
        solfa: "السلفة",
        remaining: "المتبقي",
        expiry: "تاريخ الانتهاء",
        expiryDate: "تاريخ الانتهاء",
        packageName: "الباقة",
        offerName: "الباقة",
        name: "الاسم",
        price: "السعر",
        dataLimit: "الحجم",
        data: "البيانات",
        validity: "الصلاحية"
    };
    for (const [key, fieldLabel] of Object.entries(fieldLabels)) {
        const fieldValue = value[key];
        if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "object") {
            lines.push(`${fieldLabel}: ${String(fieldValue)}`);
        }
    }

    for (const key of ["offers", "packages", "data", "items"]) {
        if (Array.isArray(value[key])) {
            const items = value[key].map(item => extractArabicTelecomText(item)).filter(Boolean);
            lines.push(...items);
        }
    }
    return [...new Set(lines)].join("\n");
}

async function queryYemMobile(mobile) {
    const [balance, solfa, offers] = await Promise.all([
        callTelecomQuery("yem", "query", mobile),
        callTelecomQuery("yem", "solfa", mobile),
        callTelecomQuery("yem", "queryoffer", mobile)
    ]);
    return `📱 *استعلام يمن موبايل الشامل*\n\nرقم الخدمة: \`${mobile}\`\n\n━━━━━━━━━━━━━━\n${formatTelecomPayload("الرصيد", balance)}\n\n━━━━━━━━━━━━━━\n${formatTelecomPayload("السلفة", solfa)}\n\n━━━━━━━━━━━━━━\n${formatTelecomPayload("الباقات", offers)}`;
}


function formatMobileForAPI(phone) {
    let clean = (phone || "").replace(/[^0-9]/g, "");
    if (clean.startsWith("967") && clean.length > 9) {
        clean = clean.slice(3);
    }
    return clean;
}

async function getVerifiedCustomerMobile(senderId, session = {}) {
    const mobile = await getUserMobile(senderId);
    const senderMobile = formatMobileForAPI(senderId);
    const candidate = mobile || session.registeredMobile || (isValidYemeniMobile(senderMobile) ? senderMobile : null);
    return isValidYemeniMobile(candidate) ? candidate : null;
}

function normalizeTelecomTarget(value) {
    return String(value || "").replace(/[٠-٩]/g, digit => "٠١٢٣٤٥٦٧٨٩".indexOf(digit)).replace(/\D/g, "");
}

function isValidTelecomTarget(service, value) {
    const target = normalizeTelecomTarget(value);
    if (service === "yem") return /^77\d{7}$/.test(target);
    if (service === "you") return /^73\d{7}$/.test(target);
    if (service === "yem4g") return /^10\d{7}$/.test(target);
    if (service === "post" || service === "adenet") return /^0\d{4,11}$/.test(target);
    return false;
}

function telecomTargetHint(service) {
    if (service === "yem") return "يمن موبايل يجب أن يبدأ بـ 77 ويتكون من 9 أرقام.";
    if (service === "you") return "رقم YOU يجب أن يبدأ بـ 73 ويتكون من 9 أرقام.";
    if (service === "yem4g") return "رقم يمن فورجي يجب أن يبدأ بـ 10 ويتكون من 9 أرقام.";
    if (service === "post") return "رقم الهاتف الثابت أو الإنترنت يجب أن يبدأ بـ 0.";
    if (service === "adenet") return "رقم عدن نت يجب أن يبدأ بـ 0.";
    return "أرسل رقمًا صحيحًا للخدمة.";
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
    if (!GEMINI_API_KEY) {
        console.error("Gemini API error: GEMINI_API_KEY is missing.");
        return "عذراً، خدمة المساعد الذكي غير مهيأة حالياً. تواصل مع الإدارة.";
    }
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
            if (!res.ok) {
                const errorText = await res.text();
                console.error(`Gemini ${model} HTTP ${res.status}: ${errorText.slice(0, 500)}`);
                continue;
            }
            const data = await res.json();
            const cleanReply = extractCleanAIResponse(data);
            if (cleanReply) return cleanReply;
            console.error(`Gemini ${model} returned no usable text.`);
        } catch (error) {
            console.error(`Gemini ${model} connection error:`, error.message);
        }
    }
    return "عذراً، تعذر تشغيل المساعد الذكي حالياً. تواصل مع الإدارة أو حاول لاحقاً.";
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
                const verification = await callAlWadiAPI('/alwadi', {
                    action: "lookup",
                    number: targetCard,
                    mobile: verifiedMobile
                });
                console.log("AlWadi Renewal Verification:", JSON.stringify(verification));
                finalReply = formatAlWadiRenewalResult(
                    verification.success ? verification : res,
                    targetCard,
                    packageName,
                    packagePrice
                );
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

if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("❌ TELEGRAM_BOT_TOKEN غير موجود في المتغيرات البيئية.");
}

// البوت يعمل عبر Webhook وليس Polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

async function handleTelegramCallback(query) {
    try {
        await handleMenuCallback(bot, query);
    } catch (error) {
        console.error("⚠️ خطأ في زر تفاعلي:", error.message || error);

        try {
            await bot.answerCallbackQuery(query.id, {
                text: "حدث خطأ، حاول مرة أخرى.",
                show_alert: true
            });
        } catch (answerError) {
            console.error(
                "⚠️ تعذر إرسال تنبيه الزر:",
                answerError.message || answerError
            );
        }
    }
}

async function handleTelegramMessage(msg) {
    try {
        const chatId = msg.chat?.id;
        if (!chatId) return;

        const senderId = msg.from?.id?.toString() || chatId.toString();
        const pushName =
            msg.from?.username ||
            `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() ||
            "العميل";

        const textMessage = msg.text || msg.caption || "";
        const hasContact = !!(msg.contact && msg.contact.phone_number);
        const inputMobileRaw = hasContact ? msg.contact.phone_number : textMessage;
        const session =
            userSessions[senderId] ||
            (userSessions[senderId] = { history: [], state: null });

        if (/^\/start(?:@\w+)?(?:\s|$)/i.test(msg.text || "")) {
            if (await isAccountLinked(senderId)) {
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
            hasContact,
            contactPhone: msg.contact?.phone_number,
            messageId: msg.message_id
        }, null, 2));

        if (!(await isAccountLinked(senderId))) {
            const cleanInput = (inputMobileRaw || "").trim();

            if (hasContact || session.state === "LINKING_AWAITING_PHONE" || (!session.state && isValidLinkingMobile(formatMobileForAPI(cleanInput)))) {
                const mobile = formatMobileForAPI(cleanInput);

                if (!isValidLinkingMobile(mobile)) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        "❌ الرقم غير صحيح. اضغط على زر «📱 إرسال رقم هاتفي تلقائياً» أو أرسل رقمًا يبدأ بـ 7 ويتكون من 9 أرقام، مثال: 770326828",
                        { reply_markup: contactRequestKeyboard() }
                    );
                    return;
                }

                const accountResponse = await callAlWadiAPI(
                    `/balance?mobile=${encodeURIComponent(mobile)}`
                );

                if (!accountResponse.success || !accountResponse.data) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        "❌ لم يتم العثور على حساب بهذا الرقم في تطبيق ستار موبايل. تأكد من الرقم وحاول مجدداً.",
                        { reply_markup: contactRequestKeyboard() }
                    );
                    return;
                }

                const code = String(crypto.randomInt(1000, 10000));
                const smsResult = await sendLinkingOtp(mobile, code);

                if (!smsResult.success) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        `❌ ${smsResult.message}\n\nتعذر بدء الربط حاليًا، حاول لاحقًا.`,
                        { reply_markup: contactRequestKeyboard() }
                    );
                    return;
                }

                session.state = "LINKING_AWAITING_OTP";
                session.linkingOtp = {
                    mobile,
                    hash: hashOtp(code),
                    expiresAt: Date.now() + OTP_TTL_MS,
                    attempts: 0
                };

                await safeSendMessage(
                    bot,
                    chatId,
                    `✅ تم إرسال رمز التحقق (OTP) في رسالة SMS إلى هاتفك (\`${mobile}\`).\n\nأرسل الرمز المكون من 4 أرقام لتأكيد الربط خلال 10 دقائق:`,
                    { reply_markup: { remove_keyboard: true } }
                );
                return;
            }

            if (session.state === "LINKING_AWAITING_OTP") {
                const code = cleanInput.replace(/\D/g, "");
                const otp = session.linkingOtp;

                if (!otp || Date.now() > otp.expiresAt) {
                    session.state = "LINKING_AWAITING_PHONE";
                    session.linkingOtp = null;

                    await safeSendMessage(
                        bot,
                        chatId,
                        "⌛ انتهت صلاحية الرمز. اضغط «📱 إرسال رقم هاتفي تلقائياً» وابدأ من جديد.",
                        { reply_markup: contactRequestKeyboard() }
                    );
                    return;
                }

                if (!/^\d{4}$/.test(code)) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        "❌ أرسل رمز التحقق المكون من 4 أرقام فقط.",
                        { reply_markup: { remove_keyboard: true } }
                    );
                    return;
                }

                otp.attempts += 1;

                if (
                    otp.attempts > OTP_MAX_ATTEMPTS ||
                    hashOtp(code) !== otp.hash
                ) {
                    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
                        session.state = "LINKING_AWAITING_PHONE";
                        session.linkingOtp = null;
                    }

                    await safeSendMessage(
                        bot,
                        chatId,
                        "❌ رمز التحقق غير صحيح. تأكد من الرسالة النصية وأعد إدخاله.",
                        { reply_markup: { remove_keyboard: true } }
                    );
                    return;
                }

                session.linkingOtp = null;
                session.state = null;

                await finishAccountLinking(
                    bot,
                    chatId,
                    senderId,
                    otp.mobile,
                    pushName
                );
                return;
            }

            session.state = "LINKING_AWAITING_PHONE";
            await sendLinkingPrompt(bot, chatId);
            return;
        }

        if (
            session.state === "AWAITING_TELECOM_NUMBER" &&
            session.pendingTelecomQuery
        ) {
            const pendingQuery = session.pendingTelecomQuery;
            const targetMobile = normalizeTelecomTarget(textMessage);

            if (!isValidTelecomTarget(pendingQuery.service, targetMobile)) {
                await safeSendMessage(
                    bot,
                    chatId,
                    `❌ الرقم غير صحيح. ${telecomTargetHint(pendingQuery.service)}`,
                    { reply_markup: backKeyboard() }
                );
                return;
            }

            session.state = null;
            session.pendingTelecomQuery = null;

            let resultText;

            if (
                pendingQuery.service === "yem" &&
                pendingQuery.action === "query"
            ) {
                resultText = await queryYemMobile(targetMobile);
            } else {
                const result = await callTelecomQuery(
                    pendingQuery.service,
                    pendingQuery.action,
                    targetMobile,
                    pendingQuery.type
                );

                resultText =
                    result.success === true
                        ? `📱 *نتيجة الاستعلام - ${pendingQuery.serviceName}*\n\nرقم الخدمة: \`${targetMobile}\`\n\n${formatTelecomPayload("النتيجة", result)}`
                        : `❌ ${extractArabicTelecomText(result.message) || "تعذر تنفيذ الاستعلام."}`;
            }

            await safeSendMessage(
                bot,
                chatId,
                resultText,
                { reply_markup: backKeyboard() }
            );
            return;
        }

        if (
            session.state === "AWAITING_TELECOM_NUMBER_FOR_PAYMENT" &&
            session.pendingTelecomPayment
        ) {
            const targetMobile = normalizeTelecomTarget(textMessage);
            const pendingPayment = session.pendingTelecomPayment;

            if (!isValidTelecomTarget(pendingPayment.service, targetMobile)) {
                await safeSendMessage(
                    bot,
                    chatId,
                    `❌ الرقم غير صحيح. ${telecomTargetHint(pendingPayment.service)}`,
                    { reply_markup: backKeyboard() }
                );
                return;
            }

            pendingPayment.targetMobile = targetMobile;
            session.state = "AWAITING_TELECOM_AMOUNT";

            await safeSendMessage(
                bot,
                chatId,
                `💳 أرسل مبلغ السداد للرقم \`${targetMobile}\` بالريال اليمني.\n\nسيتم الخصم من حسابك الموثق (${pendingPayment.payerMobile}) فقط.`,
                { reply_markup: backKeyboard() }
            );
            return;
        }

        if (
            session.state === "AWAITING_TELECOM_AMOUNT" &&
            session.pendingTelecomPayment
        ) {
            const amountText = textMessage
                .trim()
                .replace(/[٠-٩]/g, digit => "٠١٢٣٤٥٦٧٨٩".indexOf(digit));

            const amount = Number(
                amountText.replace(/[^0-9.]/g, "")
            );

            const pendingPayment = session.pendingTelecomPayment;
            const payerMobile = await getVerifiedCustomerMobile(
                senderId,
                session
            );

            if (
                !payerMobile ||
                payerMobile !== pendingPayment.payerMobile ||
                !pendingPayment.targetMobile
            ) {
                session.state = null;
                session.pendingTelecomPayment = null;

                await safeSendMessage(
                    bot,
                    chatId,
                    "❌ تعذر التحقق من حسابك. لم يتم تنفيذ أي خصم.",
                    { reply_markup: backKeyboard() }
                );
                return;
            }

            if (!Number.isFinite(amount) || amount <= 0) {
                await safeSendMessage(
                    bot,
                    chatId,
                    "❌ أرسل مبلغًا صحيحًا أكبر من صفر، مثال: 1000",
                    { reply_markup: backKeyboard() }
                );
                return;
            }

            const paymentResult = await callTelecomPayment(
                pendingPayment.service,
                pendingPayment.action,
                pendingPayment.targetMobile,
                amount,
                payerMobile
            );

            console.log(
                "Telecom Payment Response:",
                JSON.stringify({
                    service: pendingPayment.service,
                    action: pendingPayment.action,
                    mobile: pendingPayment.targetMobile,
                    payerMobile,
                    amount,
                    response: paymentResult
                })
            );

            session.state = null;
            session.pendingTelecomPayment = null;

            if (paymentResult.success === true) {
                await safeSendMessage(
                    bot,
                    chatId,
                    `✅ *تم تنفيذ السداد بنجاح*\n\n📱 الحساب المسدد: \`${pendingPayment.targetMobile}\`\n🏢 الخدمة: *${pendingPayment.serviceName}*\n💰 المبلغ: *${amount} ريال يمني*\n\nتم الخصم من حسابك الموثق فقط.`,
                    { reply_markup: backKeyboard() }
                );
            } else {
                await safeSendMessage(
                    bot,
                    chatId,
                    `❌ *لم يتم تنفيذ السداد*\n\n${paymentResult.message || "رفض النظام العملية."}\n\nلم يتم اعتماد العملية من البوت.`,
                    { reply_markup: backKeyboard() }
                );
            }

            return;
        }

        const mediaObj = getTelegramMediaObject(msg);

        if (mediaObj) {
            console.log(
                `⚡ إيصال (${mediaObj.type}) من ${senderId} (${pushName})...`
            );

            try {
                const buffer = await downloadTelegramFile(
                    bot,
                    mediaObj.fileId
                );

                if (!buffer || buffer.length === 0) {
                    throw new Error("بافر الملف فارغ");
                }

                const result = await analyzeReceipt(
                    buffer,
                    mediaObj.mimeType,
                    GEMINI_API_KEY
                );

                if (
                    !result.success ||
                    !result.data ||
                    !result.data.isValidReceipt
                ) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        formatInvalidReceiptMessage(
                            result.data?.rejectReason || result.error
                        ),
                        {
                            reply_to_message_id: msg.message_id
                        }
                    );
                    return;
                }

                const receiptData = result.data;

                console.log("📑 بيانات الإيصال:", receiptData);

                const authCheck = isReceiptAuthorized(receiptData);

                if (!authCheck.authorized) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        `⚠️ إيقاف الإيصال: ${authCheck.reason}. تواصل مع الإدارة.`,
                        {
                            reply_to_message_id: msg.message_id
                        }
                    );

                    if (ADMIN_CHAT_ID) {
                        await safeSendMessage(
                            bot,
                            ADMIN_CHAT_ID,
                            `إيصال غير مصدق من ${senderId}: ${authCheck.reason}`
                        );
                    }

                    return;
                }

                const storedMobile = await getUserMobile(senderId);
                const senderMobile = formatMobileForAPI(senderId);

                const registeredMobile =
                    storedMobile ||
                    userSessions[senderId]?.registeredMobile ||
                    (
                        isValidYemeniMobile(senderMobile)
                            ? senderMobile
                            : null
                    );

                if (!registeredMobile) {
                    await safeSendMessage(
                        bot,
                        chatId,
                        `📱 قبل أن أضيف الإيصال، يرجى إرسال رقم هاتفك اليمني المسجل في ستار موبايل أولاً (مثل: 770326828).
هذا الرقم هو الذي سأستخدمه لربط الإيصال بحسابك في التطبيق.`,
                        {
                            reply_to_message_id: msg.message_id
                        }
                    );
                    return;
                }

                const creditResult = await creditUserAccount(
                    registeredMobile,
                    receiptData.amount,
                    receiptData.receiptNo,
                    {
                        ...receiptData,
                        transferCompany: receiptData.transferCompany
                    }
                );

                if (!creditResult.success) {
                    if (creditResult.alreadyProcessed) {
                        await safeSendMessage(
                            bot,
                            chatId,
                            formatDuplicateReceiptMessage(
                                receiptData.receiptNo
                            ),
                            {
                                reply_to_message_id: msg.message_id
                            }
                        );
                        return;
                    }

                    await safeSendMessage(
                        bot,
                        chatId,
                        `❌ فشل شحن الإيصال: ${creditResult.message || "حدث خطأ أثناء المزامنة مع التطبيق."}`,
                        {
                            reply_to_message_id: msg.message_id
                        }
                    );
                    return;
                }

                const successMsg = formatSuccessMessage({
                    customerName: creditResult.customerName,
                    amount: creditResult.addedAmount,
                    currency: creditResult.currency,
                    receiptNo: receiptData.receiptNo,
                    currentBalance: creditResult.newBalance,
                    date: formatReceiptDate(receiptData.date),
                    transferCompany: receiptData.transferCompany,
                    senderName:
                        receiptData.fromAccountName ||
                        receiptData.senderName
                });

                await safeSendMessage(
                    bot,
                    chatId,
                    successMsg,
                    {
                        reply_to_message_id: msg.message_id
                    }
                );

                console.log("✅ تم تأكيد الشحن بنجاح!\n");

            } catch (err) {
                console.error(
                    "❌ خطأ أثناء معالجة الإيصال:",
                    err.message
                );

                await safeSendMessage(
                    bot,
                    chatId,
                    formatInvalidReceiptMessage(
                        "يرجى إرسال صورة أو PDF عادي وواضح للإيصال."
                    ),
                    {
                        reply_to_message_id: msg.message_id
                    }
                );
            }

            return;
        }

        if (textMessage) {
            console.log(
                `📩 رسالة من (${senderId} - ${pushName}): ${textMessage}`
            );

            await handleTextMessage(
                textMessage,
                chatId,
                senderId,
                pushName,
                bot,
                msg
            );
        }

    } catch (err) {
        console.error(
            "⚠️ تنبيه معالجة الرسائل:",
            err.message
        );
    }
}

async function handleTelegramUpdate(update) {
    if (!update || typeof update !== "object") {
        return;
    }

    if (update.callback_query) {
        await handleTelegramCallback(update.callback_query);
        return;
    }

    if (update.message) {
        await handleTelegramMessage(update.message);
        return;
    }
}

module.exports = {
    bot,
    handleTelegramUpdate
};

console.log("✅ Telegram webhook bot ready.");