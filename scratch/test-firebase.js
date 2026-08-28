const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const {
    getUserMobileFromFirebase,
    saveUserMobileToFirebase,
    getAllUserMobilesFromFirebase
} = require("../firebaseAdmin");

async function test() {
    console.log("Saving test user...");
    await saveUserMobileToFirebase("test_telegram_12345", "770326828", { name: "Test User" });

    console.log("Getting test user...");
    const mobile = await getUserMobileFromFirebase("test_telegram_12345");
    console.log("Retrieved mobile:", mobile);

    console.log("Getting all users...");
    const all = await getAllUserMobilesFromFirebase();
    console.log("All users keys:", Object.keys(all));
}

test();
