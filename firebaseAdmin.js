const admin = require("firebase-admin");
const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function cleanEnvVal(val) {
    if (!val) return "";
    let s = String(val).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    if (s.endsWith(',')) {
        s = s.slice(0, -1).trim();
    }
    return s;
}

const projectId = cleanEnvVal(process.env.FIREBASE_PROJECT_ID || process.env.project_id) || "studio-239662212-1b7b6";
const clientEmail = cleanEnvVal(process.env.FIREBASE_CLIENT_EMAIL || process.env.client_email) || `firebase-adminsdk-fbsvc@${projectId}.iam.gserviceaccount.com`;
let privateKey = cleanEnvVal(process.env.FIREBASE_PRIVATE_KEY || process.env.private_key);

if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, "\n");
}

let db = null;

try {
    const apps = getApps();
    const app = apps.length > 0
        ? apps[0]
        : initializeApp({
            credential: cert({
                projectId,
                clientEmail,
                privateKey,
            }),
        });

    db = getFirestore(app);
    console.log("✅ Firebase Firestore initialized successfully for project:", projectId);
} catch (error) {
    console.error("⚠️ Firebase initialization error:", error.message);
}

// Memory cache for fast lookups & fallback
const userMobilesCache = {};

/**
 * جلب رقم هاتف المستخدم من فايربيس (مع كاش في الذاكرة)
 */
async function getUserMobileFromFirebase(senderId) {
    const key = String(senderId || "").trim();
    if (!key) return null;

    if (userMobilesCache[key]) {
        return userMobilesCache[key];
    }

    if (!db) return null;

    try {
        const doc = await db.collection("telegram_users").doc(key).get();
        if (doc.exists) {
            const data = doc.data();
            const mobile = data?.mobile || data?.phone || null;
            if (mobile) {
                userMobilesCache[key] = String(mobile).trim();
                return userMobilesCache[key];
            }
        }
    } catch (err) {
        console.error(`⚠️ خطأ قراءة مستخدم ${key} من فايربيس:`, err.message);
    }
    return null;
}

/**
 * حفظ رقم هاتف المستخدم ومعرف تليجرام في فايربيس
 */
async function saveUserMobileToFirebase(senderId, mobile, extraData = {}) {
    const key = String(senderId || "").trim();
    const cleanMobile = String(mobile || "").trim();
    if (!key || !cleanMobile) return false;

    userMobilesCache[key] = cleanMobile;

    if (!db) {
        console.warn("⚠️ Firebase DB not initialized; cached in memory only.");
        return true;
    }

    try {
        await db.collection("telegram_users").doc(key).set({
            telegramId: key,
            mobile: cleanMobile,
            updatedAt: new Date().toISOString(),
            ...extraData
        }, { merge: true });
        console.log(`✅ تم حفظ المستخدم في فايربيس: Telegram ID [${key}] -> Mobile [${cleanMobile}]`);
        return true;
    } catch (err) {
        console.error(`⚠️ فشل حفظ المستخدم ${key} في فايربيس:`, err.message);
        return false;
    }
}

/**
 * جلب جميع الأرقام المسجلة (للتوافق)
 */
async function getAllUserMobilesFromFirebase() {
    if (!db) return { ...userMobilesCache };

    try {
        const snapshot = await db.collection("telegram_users").get();
        const result = { ...userMobilesCache };
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data?.mobile) {
                result[doc.id] = String(data.mobile).trim();
                userMobilesCache[doc.id] = String(data.mobile).trim();
            }
        });
        return result;
    } catch (err) {
        console.error("⚠️ فشل جلب المستخدمين من فايربيس:", err.message);
        return { ...userMobilesCache };
    }
}

module.exports = {
    admin,
    db,
    userMobilesCache,
    getUserMobileFromFirebase,
    saveUserMobileToFirebase,
    getAllUserMobilesFromFirebase
};
