/**
 * وحدة ستار موبايل (Star Mobile) - إدارة الحسابات والأرصدة وسجل الإيصالات
 * تتيح إضافة الرصيد، التحقق من عدم تكرار الإيصال، وتوفير ربط مباشر بالـ API الفعلي لتطبيق ستار موبايل مستقبلاً.
 */

const fs = require("fs");
const path = require("path");

// قاعدة بيانات محلية مرجعية لحفظ الأرصدة والسجلات (في الذاكرة / يمكن ربطها بقاعدة بيانات حقيقية أو API)
const userBalances = new Map();
const processedReceipts = new Set();

const STAR_MOBILE_API_URL = process.env.STAR_MOBILE_API_URL || "https://star26.vercel.app/api/webhooks/whatsapp-receipt";
const STAR_MOBILE_API_KEY = process.env.STAR_MOBILE_API_KEY || process.env.WHATSAPP_WEBHOOK_SECRET || "star_default_secret_123";
const STAR_MOBILE_CREDIT_ENDPOINT = process.env.STAR_MOBILE_CREDIT_ENDPOINT || "/webhooks/whatsapp-receipt";
const STAR_MOBILE_BALANCE_URL = process.env.STAR_MOBILE_BALANCE_URL || "https://star26.vercel.app/api/external/v1/balance";
const STAR_MOBILE_BALANCE_TOKEN = process.env.STAR_API_TOKEN || STAR_MOBILE_API_KEY;
const STAR_MOBILE_OWNER_NAME = process.env.STAR_MOBILE_OWNER_NAME || "محمد راضي ربيع باشادي";
const BALANCES_FILE = process.env.STAR_MOBILE_BALANCES_FILE || path.join(__dirname, "data", "user-balances.json");
const RECEIPTS_FILE = process.env.STAR_MOBILE_RECEIPTS_FILE || path.join(__dirname, "data", "processed-receipts.json");

function normalizePhone(phoneNumber) {
    return String(phoneNumber || "").replace(/[^0-9]/g, "");
}

function ensureFileExists(filePath, fallbackValue) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallbackValue, null, 2), "utf8");
        }
    } catch (error) {
        console.error("⚠️ فشل تجهيز ملف التخزين:", error.message);
    }
}

function loadJson(filePath, fallbackValue) {
    try {
        ensureFileExists(filePath, fallbackValue);
        const raw = fs.readFileSync(filePath, "utf8");
        if (!raw.trim()) return fallbackValue;
        return JSON.parse(raw);
    } catch (error) {
        console.error("⚠️ فشل قراءة ملف التخزين:", error.message);
        return fallbackValue;
    }
}

function saveJson(filePath, value) {
    try {
        ensureFileExists(filePath, value);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    } catch (error) {
        console.error("⚠️ فشل حفظ ملف التخزين:", error.message);
    }
}

function hydrateBalancesFromDisk() {
    const saved = loadJson(BALANCES_FILE, {});
    Object.entries(saved).forEach(([phone, account]) => {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return;
        const numericBalance = Number(account?.balance || 0);
        userBalances.set(cleanPhone, {
            phone: cleanPhone,
            name: account?.name || "العميل المحترم",
            balance: Number.isFinite(numericBalance) ? numericBalance : 0,
            currency: account?.currency || "ريال يمني"
        });
    });
}

function persistBalancesToDisk() {
    const payload = {};
    userBalances.forEach((account, phone) => {
        payload[phone] = {
            phone,
            name: account.name || "العميل المحترم",
            balance: Number(account.balance || 0),
            currency: account.currency || "ريال يمني"
        };
    });
    saveJson(BALANCES_FILE, payload);
}

function hydrateReceiptsFromDisk() {
    const saved = loadJson(RECEIPTS_FILE, []);
    const items = Array.isArray(saved) ? saved : [];
    items.forEach(receiptNo => {
        const cleanReceipt = String(receiptNo || "").trim().toUpperCase();
        if (cleanReceipt) processedReceipts.add(cleanReceipt);
    });
}

function persistReceiptsToDisk() {
    saveJson(RECEIPTS_FILE, Array.from(processedReceipts));
}

hydrateBalancesFromDisk();
hydrateReceiptsFromDisk();

/**
 * الحصول على بيانات ورصيد العميل بناءً على رقم هاتفه
 * @param {string} phoneNumber - رقم هاتف العميل (مثال: 967770000000)
 * @returns {Promise<Object>}
 */
async function getUserAccount(phoneNumber) {
    const cleanPhone = normalizePhone(phoneNumber);

    if (cleanPhone && STAR_MOBILE_BALANCE_URL && STAR_MOBILE_BALANCE_TOKEN) {
        try {
            const response = await fetch(`${STAR_MOBILE_BALANCE_URL}?mobile=${encodeURIComponent(cleanPhone)}`, {
                headers: {
                    "Authorization": `Bearer ${STAR_MOBILE_BALANCE_TOKEN}`,
                    "Accept": "application/json"
                }
            });
            const data = await response.json();
            const accountData = data?.data || data?.user || data;
            const remoteBalance = Number(accountData?.balance);
            const remoteName = accountData?.user || accountData?.name || accountData?.fullName || accountData?.customerName;
            if (response.ok && (Number.isFinite(remoteBalance) || remoteName)) {
                const account = {
                    phone: normalizePhone(accountData?.mobile || accountData?.phone || cleanPhone),
                    name: remoteName || "العميل المحترم",
                    balance: Number.isFinite(remoteBalance) ? remoteBalance : 0,
                    currency: accountData?.currency || "ريال يمني",
                    source: "remote"
                };
                userBalances.set(cleanPhone, account);
                persistBalancesToDisk();
                return account;
            }
        } catch (error) {
            console.error("⚠️ فشل جلب حساب العميل من تطبيق ستار موبايل:", error.message);
        }
    }

    if (STAR_MOBILE_API_KEY) {
        try {
            // مثال للربط الفعلي المستقبلي:
            // const res = await fetch(`${STAR_MOBILE_API_URL}/users/balance?phone=${cleanPhone}`, {
            //     headers: { "Authorization": `Bearer ${STAR_MOBILE_API_KEY}` }
            // });
            // return await res.json();
        } catch (e) {
            console.error("⚠️ فشل جلب الرصيد من سيرفر ستار موبايل:", e.message);
        }
    }

    if (!userBalances.has(cleanPhone)) {
        const newAccount = {
            phone: cleanPhone,
            name: "العميل المحترم",
            balance: 0,
            currency: "ريال يمني"
        };
        userBalances.set(cleanPhone, newAccount);
        persistBalancesToDisk();
    }

    return userBalances.get(cleanPhone);
}

/**
 * التحقق مما إذا كان رقم الإيصال تم شحنه وتأكيده سابقاً لمنع الاحتيال والتكرار
 * @param {string} receiptNo
 * @returns {boolean}
 */
function isReceiptProcessed(receiptNo) {
    if (!receiptNo) return false;
    const cleanNo = String(receiptNo).trim().toUpperCase();
    return processedReceipts.has(cleanNo);
}

async function processReceiptWebhook(payload = {}) {
    const phone = normalizePhone(payload.phone || payload.mobile || payload.customerPhone);
    const receiptNumber = String(payload.receiptNumber || payload.receiptNo || payload.receipt || "").trim();
    const amountValue = Number(payload.amount || payload.total || payload.balanceToAdd || 0);

    if (!phone) {
        return {
            success: false,
            statusCode: 400,
            message: "رقم الهاتف مطلوب في الحقل phone."
        };
    }

    if (!Number.isFinite(amountValue) || amountValue <= 0) {
        return {
            success: false,
            statusCode: 400,
            message: "القيمة amount يجب أن تكون رقمًا صحيحًا أكبر من صفر."
        };
    }

    const result = await creditUserAccount(phone, amountValue, receiptNumber, {
        source: "webhook",
        currency: payload.currency || "ريال"
    });

    if (!result.success) {
        return {
            success: false,
            statusCode: result.alreadyProcessed ? 409 : 400,
            alreadyProcessed: Boolean(result.alreadyProcessed),
            message: result.message || "تعذّر إتمام الشحن."
        };
    }

    return {
        success: true,
        statusCode: 200,
        message: "تمت إضافة الرصيد بنجاح.",
        phone,
        addedAmount: result.addedAmount,
        oldBalance: result.oldBalance,
        newBalance: result.newBalance,
        currency: result.currency,
        receiptNumber: receiptNumber || undefined
    };
}

/**
 * إضافة المبلغ لحساب العميل وتسجيل الإيصال
 * @param {string} phoneNumber - رقم العميل
 * @param {number} amount - المبلغ المضاف
 * @param {string} receiptNo - رقم الإيصال
 * @param {Object} extraDetails - بيانات إضافية (الشركة، المحول، الخ)
 * @returns {Promise<Object>} النتيجة مع الرصيد القديم والجديد
 */
async function creditUserAccount(phoneNumber, amount, receiptNo, extraDetails = {}) {
    const cleanPhone = normalizePhone(phoneNumber);
    const cleanReceiptNo = String(receiptNo || "").trim().toUpperCase();
    const amountValue = Number(amount);

    if (!cleanPhone) {
        return {
            success: false,
            alreadyProcessed: false,
            message: "رقم الهاتف غير صالح."
        };
    }

    if (!Number.isFinite(amountValue) || amountValue <= 0) {
        return {
            success: false,
            alreadyProcessed: false,
            message: "المبلغ غير صالح."
        };
    }

    if (cleanReceiptNo && processedReceipts.has(cleanReceiptNo)) {
        return {
            success: false,
            alreadyProcessed: true,
            message: `عذراً! رقم الإيصال (${cleanReceiptNo}) تم استخدامه وإضافته سابقاً.`
        };
    }

    const account = await getUserAccount(cleanPhone);
    const oldBalance = Number(account.balance || 0);
    const newBalance = oldBalance + amountValue;

    const shouldSendToExternalApp = Boolean(STAR_MOBILE_API_URL && STAR_MOBILE_API_KEY);

    const endpoint = STAR_MOBILE_API_URL.includes("://")
        ? STAR_MOBILE_API_URL
        : `${STAR_MOBILE_API_URL.replace(/\/$/, "")}${STAR_MOBILE_CREDIT_ENDPOINT}`;

    let webhookSuccess = true;
    let webhookMessage = "";
    let webhookAccount = null;

    const transferCompany = normalizeName(String(extraDetails.transferCompany || ""));
    const isKiremiTransfer = /الكريمي|حاسب/i.test(transferCompany);

    if (shouldSendToExternalApp) {
        try {
            console.log(`📡 جاري إرسال إيداع إلى Webhook: ${endpoint}`);
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-API-Key": STAR_MOBILE_API_KEY,
                    "Authorization": `Bearer ${STAR_MOBILE_API_KEY}`
                },
                body: JSON.stringify({
                    phone: cleanPhone,
                    amount: amountValue,
                    receiptNumber: cleanReceiptNo || "NO_RECEIPT",
                    receipt_number: cleanReceiptNo || "NO_RECEIPT",
                    currency: extraDetails.currency || "YER",
                    details: extraDetails
                })
            });

            const responseText = await res.text();
            console.log(`📡 استجابة Webhook الإيداع: ${res.status} ${responseText}`);
            try {
                const webhookResponse = JSON.parse(responseText);
                const webhookData = webhookResponse?.data || webhookResponse;
                const webhookBalance = Number(webhookData?.newBalance ?? webhookData?.balance);
                const webhookName = webhookData?.userName || webhookData?.name || webhookData?.fullName;
                if (res.ok && (Number.isFinite(webhookBalance) || webhookName)) {
                    webhookAccount = {
                        phone: cleanPhone,
                        name: webhookName || account.name,
                        balance: Number.isFinite(webhookBalance) ? webhookBalance : newBalance,
                        currency: extraDetails.currency || account.currency || "ريال يمني",
                        source: "remote"
                    };
                }
            } catch (error) {
                console.warn("⚠️ تعذر قراءة بيانات حساب العميل من استجابة الإيداع:", error.message);
            }
            if (!res.ok) {
                webhookSuccess = false;
                webhookMessage = responseText || `Webhook returned status ${res.status}`;
            }
        } catch (err) {
            webhookSuccess = false;
            webhookMessage = err.message;
            console.error("❌ فشل إرسال الإيداع عبر Webhook:", err.message);
        }
    }

    if (shouldSendToExternalApp && !webhookSuccess) {
        const isIgnoredKiremiError = isKiremiTransfer && /غير مسجل/i.test(webhookMessage);
        if (!isIgnoredKiremiError) {
            return {
                success: false,
                alreadyProcessed: false,
                message: `فشل مزامنة الإيداع مع التطبيق الحقيقي: ${webhookMessage}`,
                externalSync: false
            };
        }
        console.warn("⚠️ خطأ Webhook الكريمي بسبب رقم غير مسجل، سيتم اعتماد الإيداع محلياً فقط.");
    }

    let currentAccount = account;
    if (webhookSuccess && shouldSendToExternalApp) {
        currentAccount = webhookAccount || await getUserAccount(cleanPhone);
        if (currentAccount.source !== "remote") {
            return {
                success: false,
                alreadyProcessed: false,
                message: "تمت مزامنة الإيداع، لكن تعذّر التحقق من اسم ورصيد الحساب من تطبيق ستار موبايل.",
                externalSync: true
            };
        }
    }

    const hasRemoteBalance = webhookSuccess && shouldSendToExternalApp && currentAccount.source === "remote";
    account.balance = hasRemoteBalance ? currentAccount.balance : newBalance;
    account.name = currentAccount.name || account.name;
    account.currency = currentAccount.currency || account.currency;
    userBalances.set(cleanPhone, account);
    persistBalancesToDisk();

    if (cleanReceiptNo) {
        processedReceipts.add(cleanReceiptNo);
        persistReceiptsToDisk();
    }

    if (!shouldSendToExternalApp) {
        console.warn("⚠️ لا يوجد STAR_MOBILE_API_URL/STAR_MOBILE_API_KEY مفعّل، لذلك التحديث يحدث محلياً فقط وليس في التطبيق الحقيقي.");
    }

    return {
        success: true,
        alreadyProcessed: false,
        oldBalance,
        newBalance: account.balance,
        addedAmount: amountValue,
        customerName: account.name,
        currency: account.currency || extraDetails.currency || "ريال",
        externalSync: shouldSendToExternalApp
    };
}

// قائمة الشركات المسموح بها مع تفاصيل الحساب والاسم المتوقع للمرسل
const allowedCompanies = {
    "العمقي": {
        accountNumber: "254157699",
        expectedSender: "محمد راضي ربيع باشادي",
        expectedRecipient: "محمد راضي ربيع باشادي"
    },
    "الكريمي": {
        accountNumber: "1844928",
        expectedSender: "محمد راضي ربيع باشادي",
        expectedRecipient: "ستار ميديا للاعلان"
    }
};

/**
 * تحقق ما إذا كان الإيصال من شركة مسموح بها ويطابق اسم المرسل المتوقع.
 * @param {Object} receipt - كائن بيانات الإيصال المستخرج من Gemini
 * @returns {{authorized: boolean, reason?: string}}
 */
function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function isSameCalendarDay(dateA, dateB) {
    return dateA.getFullYear() === dateB.getFullYear() &&
        dateA.getMonth() === dateB.getMonth() &&
        dateA.getDate() === dateB.getDate();
}

function parseReceiptDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const arabicDigits = {
        '٠': '0','١': '1','٢': '2','٣': '3','٤': '4','٥': '5','٦': '6','٧': '7','٨': '8','٩': '9'
    };
    const normalized = raw.replace(/[٠-٩]/g, (d) => arabicDigits[d] || d)
        .replace(/[٫،]/g, ',')
        .replace(/-/g, '/')
        .replace(/\s+/g, ' ')
        .trim();

    const datePatterns = [
        /^(\d{1,2})[\/](\d{1,2})[\/](\d{4})$/,
        /^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/,
        /^(\d{1,2})[\.](\d{1,2})[\.](\d{4})$/
    ];

    for (const pattern of datePatterns) {
        const match = normalized.match(pattern);
        if (match) {
            let year, month, day;
            if (pattern === datePatterns[0] || pattern === datePatterns[2]) {
                day = Number(match[1]);
                month = Number(match[2]) - 1;
                year = Number(match[3]);
            } else {
                year = Number(match[1]);
                month = Number(match[2]) - 1;
                day = Number(match[3]);
            }
            const parsed = new Date(year, month, day);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
    }

    const parsedDate = new Date(normalized);
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate;

    return null;
}

function namesMatch(actual, expected) {
    return normalizeName(actual).toLowerCase() === normalizeName(expected).toLowerCase();
}

function isReceiptAuthorized(receipt) {
    if (!receipt || !receipt.transferCompany) {
        return { authorized: false, reason: "Missing transferCompany information" };
    }
    let companyKey = Object.keys(allowedCompanies).find(key =>
        receipt.transferCompany.includes(key)
    );
    if (!companyKey && /حاسب/i.test(receipt.transferCompany)) {
        companyKey = "الكريمي";
    }
    if (!companyKey) {
        return { authorized: false, reason: `الشركة (${receipt.transferCompany}) غير مسموحة` };
    }

    const companyRules = allowedCompanies[companyKey];
    const expectedSender = normalizeName(companyRules.expectedSender || STAR_MOBILE_OWNER_NAME);
    const expectedRecipient = normalizeName(companyRules.expectedRecipient || STAR_MOBILE_OWNER_NAME);
    const toAccountName = normalizeName(receipt.toAccountName || receipt.beneficiaryName || receipt.receiverName || receipt.accountName || "");
    const fromAccountName = normalizeName(receipt.fromAccountName || receipt.senderName || "");
    const rawDate = String(receipt.date || receipt.transferDate || receipt.receiptDate || "").trim();
    const parsedDate = parseReceiptDate(rawDate);

    if (!parsedDate) {
        return { authorized: false, reason: "تاريخ الإيصال غير واضح أو غير قابل للقراءة." };
    }

    if (!isSameCalendarDay(parsedDate, new Date())) {
        return { authorized: false, reason: "تاريخ الإيصال يجب أن يكون نفس تاريخ اليوم." };
    }

    if (!toAccountName) {
        return { authorized: false, reason: "اسم المستلم غير واضح في الإيصال." };
    }

    if (!namesMatch(toAccountName, expectedRecipient)) {
        return { authorized: false, reason: `اسم الحساب المستلم (${toAccountName}) يجب أن يكون ${expectedRecipient}.` };
    }

    if (companyKey !== "الكريمي") {
        if (!fromAccountName) {
            return { authorized: false, reason: "اسم المرسل غير واضح في الإيصال." };
        }
        if (!namesMatch(fromAccountName, expectedSender)) {
            return { authorized: false, reason: `اسم المرسل (${fromAccountName}) يجب أن يطابق ${expectedSender} بالحرف الواحد.` };
        }
    }

    return { authorized: true };
}

module.exports = {
    getUserAccount,
    isReceiptProcessed,
    creditUserAccount,
    processReceiptWebhook,
    isReceiptAuthorized
};
