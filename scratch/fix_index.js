const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

const targetMarker = "}bile = mobileMatchInMsg ? mobileMatchInMsg[1] : null;";
const idx = code.indexOf(targetMarker);
if (idx !== -1) {
    const nextWadi = code.indexOf("// ب. استفسارات وتساؤلات أو طلب باقات منظومة الوادي", idx);
    if (nextWadi !== -1) {
        code = code.slice(0, idx) + "\n    }\n\n    " + code.slice(nextWadi);
    }
}

fs.writeFileSync('index.js', code, 'utf8');
console.log('Cleaned leftover duplicate code cleanly!');
