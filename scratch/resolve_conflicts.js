const fs = require("fs");
const path = require("path");

const indexPath = path.join(__dirname, "../index.js");
let content = fs.readFileSync(indexPath, "utf8");

// Function to resolve git conflict by choosing HEAD
function resolveConflicts(str) {
    const conflictRegex = /<<<<<<< HEAD\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> [^\r\n]*/g;
    return str.replace(conflictRegex, (match, headContent, remoteContent) => {
        return headContent;
    });
}

let resolved = resolveConflicts(content);

// Check if any conflict markers remain
if (resolved.includes("<<<<<<<")) {
    console.error("Some conflict markers could not be parsed by regex!");
} else {
    fs.writeFileSync(indexPath, resolved, "utf8");
    console.log("Successfully resolved all conflict markers in index.js!");
}
