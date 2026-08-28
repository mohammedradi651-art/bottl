const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

async function verifyAll() {
    console.log("1. Testing index.js module import...");
    const indexModule = require("../index");
    console.log("✅ index.js imported successfully, webhook handler available:", typeof indexModule.handleTelegramUpdate === "function");

    console.log("2. Testing Firebase Admin...");
    const { getUserMobileFromFirebase, saveUserMobileToFirebase, db } = require("../firebaseAdmin");
    const testId = "test_user_flow_" + Date.now();
    const testMobile = "770326828";

    console.log("3. Testing saving user to Firebase Firestore...");
    const saved = await saveUserMobileToFirebase(testId, testMobile, { test: true });
    console.log("Save status:", saved);

    console.log("4. Testing retrieving user from Firebase Firestore...");
    const fetchedMobile = await getUserMobileFromFirebase(testId);
    console.log("Fetched mobile:", fetchedMobile);

    if (fetchedMobile === testMobile) {
        console.log("✅ User mobile verified in Firebase Firestore successfully!");
    } else {
        console.error("❌ Failed to match stored mobile!");
    }

    if (db) {
        await db.collection("telegram_users").doc(testId).delete();
        console.log("✅ Cleaned up temporary test document from Firestore.");
    }
}

verifyAll().catch(err => console.error("Flow verification error:", err));
