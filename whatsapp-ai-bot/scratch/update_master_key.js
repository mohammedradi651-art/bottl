const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

// 1. Update Tokens to Master API Token
code = code.replace(
    /const ALWADI_API_TOKEN = "star_fia3uwe3d6cxunmfhuwl5";/g,
    'const MASTER_API_TOKEN = process.env.STAR_API_TOKEN || "star_usit4xl5dd9f3fcss6ft";\nconst ALWADI_API_TOKEN = MASTER_API_TOKEN;'
);
code = code.replace(
    /const NETWORKS_API_TOKEN = "star_usit4xl5dd9f3fcss6ft";/g,
    'const NETWORKS_API_TOKEN = MASTER_API_TOKEN;'
);

// 2. Add formatMobileForAPI helper function
const helperFunc = `
function formatMobileForAPI(phone) {
    let clean = (phone || "").replace(/[^0-9]/g, "");
    if (clean.startsWith("967") && clean.length > 9) {
        clean = clean.slice(3);
    }
    return clean;
}
`;

if (!code.includes('formatMobileForAPI')) {
    code = code.replace('function extractCardNumber', helperFunc + '\nfunction extractCardNumber');
}

// 3. Update Balance Check logic to pass ?mobile=
const oldBalanceBlock = `    // أ. فحص الرصيد المباشر
    if (/(?:رصيد|الرصيد|كم رصيدي|رصيدي|فحص الرصيد)/i.test(lowerText)) {
        console.log("🔍 طلب فحص الرصيد...");
        const res = await callAlWadiAPI('/balance');
        console.log("AlWadi Balance Response:", JSON.stringify(res));
        finalReply = res.success && res.data
            ? \`💰 رصيدك المتاح هو: \${res.data.balance} \${res.data.currency || 'ريال'}\`
            : \`❌ عذراً: \${res.message || "لم نتمكن من جلب الرصيد حالياً."}\`;
    }`;

const newBalanceBlock = `    // أ. فحص الرصيد المباشر (باستخدام Master Scope ورقم الهاتف)
    if (/(?:رصيد|الرصيد|كم رصيدي|رصيدي|فحص الرصيد)/i.test(lowerText)) {
        let targetMobile = formatMobileForAPI(senderPhone);
        const mobileMatch = cleanText.match(/(?:967)?(7[0-8]\\d{7})/);
        if (mobileMatch) {
            targetMobile = mobileMatch[1];
        }
        console.log(\`🔍 طلب فحص الرصيد للمشترك: \${targetMobile}...\`);
        const res = await callAlWadiAPI(\`/balance?mobile=\${targetMobile}\`);
        console.log("AlWadi Balance Response:", JSON.stringify(res));
        finalReply = res.success && res.data
            ? \`💰 رصيدك المتاح هو: \${res.data.balance} \${res.data.currency || 'ريال'}\`
            : \`❌ عذراً: \${res.message || "لم نتمكن من جلب الرصيد حالياً."}\`;
    }`;

code = code.replace(oldBalanceBlock, newBalanceBlock);

fs.writeFileSync('index.js', code, 'utf8');
console.log('Successfully updated index.js with Master API Key and ?mobile= parameter!');
