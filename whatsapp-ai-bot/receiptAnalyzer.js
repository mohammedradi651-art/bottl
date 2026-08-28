function extractCleanJsonText(data) {
    if (!data.candidates || !data.candidates[0]?.content?.parts) return null;
    return data.candidates[0].content.parts
        .filter(part => !part.thought)
        .map(part => part.text || "")
        .join("")
        .trim();
}

async function analyzeReceipt(fileBuffer, mimeType, apiKey) {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        return { success: false, error: "ملف الإيصال فارغ أو غير صالح." };
    }
    if (!apiKey) {
        return { success: false, error: "مفتاح Gemini API غير موجود في الإعدادات." };
    }

    let cleanMimeType = mimeType || "image/jpeg";
    if (cleanMimeType.includes("pdf")) {
        cleanMimeType = "application/pdf";
    } else if (!cleanMimeType.startsWith("image/")) {
        cleanMimeType = "image/jpeg";
    }

    const promptText = `أنت خبير فحص وقراءة إيصالات الحوالات والسداد لتطبيق ستار موبايل.
اقرأ الإيصال المرفق بدقة، واستخرج البيانات من النص الحقيقي داخل الإيصال.
أخرج JSON فقط بهذا الشكل:
{
  "isValidReceipt": true,
  "receiptNo": "رقم الإيصال أو رقم الحوالة",
  "amount": 5000,
  "currency": "ريال يمني",
  "fromAccountName": "اسم حساب المرسل كاملاً",
  "toAccountName": "اسم حساب المستلم كاملاً",
  "transferCompany": "العمقي أو الكريمي أو اسم الشركة الظاهر",
  "date": "التاريخ كما يظهر في الإيصال",
  "rejectReason": ""
}

القواعد:
- اقرأ الاسم من تفاصيل الحوالة الفعلية، وليس من العناوين أو الإشعارات العلوية.
- إذا ظهر نص من حساب ... إلى حساب ... فاستخرج الاسمين كاملين.
- اسم المرسل اختياري ولا ترفض الإيصال إذا لم يظهر بوضوح.
- يجب أن يكون اسم المستلم وشركة التحويل والمبلغ والتاريخ واضحة.
- لا تخترع أي قيمة غير موجودة؛ استخدم نصاً فارغاً عند عدم وضوح الحقل.
- أعد JSON صالحاً فقط بدون Markdown أو شرح.`;

    const payload = {
        contents: [{
            parts: [
                {
                    inlineData: {
                        mimeType: cleanMimeType,
                        data: fileBuffer.toString("base64")
                    }
                },
                { text: promptText }
            ]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
            maxOutputTokens: 600
        }
    };

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Gemini 3.1 receipt analysis failed (${response.status}):`, errorText);
            return { success: false, error: "تعذّر الاتصال بنموذج فحص الإيصالات." };
        }

        const result = await response.json();
        const text = extractCleanJsonText(result);
        if (!text) {
            return { success: false, error: "لم يُرجع نموذج Gemini بيانات الإيصال." };
        }

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { success: false, error: "تعذّر قراءة بيانات الإيصال من استجابة النموذج." };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const fromAccountName = String(parsed.fromAccountName || parsed.senderName || "").trim();
        const toAccountName = String(parsed.toAccountName || parsed.beneficiaryName || parsed.receiverName || "").trim();
        const amount = Number(parsed.amount) || 0;
        const data = {
            isValidReceipt: Boolean(parsed.isValidReceipt),
            receiptNo: String(parsed.receiptNo || parsed.receiptNumber || "").trim(),
            amount,
            currency: String(parsed.currency || "ريال يمني").trim(),
            senderName: fromAccountName,
            fromAccountName,
            toAccountName,
            transferCompany: String(parsed.transferCompany || "").trim(),
            date: String(parsed.date || parsed.transferDate || "").trim(),
            rejectReason: String(parsed.rejectReason || "").trim()
        };

        return { success: true, modelUsed: "gemini-3.1-flash-lite", data };
    } catch (error) {
        console.error("Gemini receipt analysis error:", error.message || error);
        return { success: false, error: "حدث خطأ أثناء تحليل الإيصال. يرجى المحاولة مرة أخرى." };
    }
}

module.exports = { analyzeReceipt };
