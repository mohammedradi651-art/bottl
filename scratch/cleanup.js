const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { db } = require("../firebaseAdmin");

async function cleanup() {
    if (db) {
        await db.collection("telegram_users").doc("test_telegram_12345").delete();
        console.log("Cleanup done.");
    }
}
cleanup();
