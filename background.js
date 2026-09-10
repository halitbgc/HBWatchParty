// auth.js'i (hbGetValidToken vb.) burada da kullanılabilir kılar — service
// worker'lar classic script olduğu için importScripts ile senkron yükleniyor.
// SEBEP: voice-offscreen.js'in KENDİ içinden chrome.storage.local'a erişmesi
// bu ortamda güvenilmez çıktı (teşhis: offscreen document içinde
// typeof chrome.storage === "undefined" dönüyor, muhtemelen chrome.offscreen
// dokümanlarına özgü bir Chrome tuhaflığı) — bu yüzden token okuma işini
// tamamen buraya (her zaman güvenilir çalışan normal bir service worker
// context'i) taşıdık; offscreen document artık token'ı AUTH_GET_TOKEN
// mesajıyla buradan istiyor (bkz. voice-offscreen.js requestTokenFromBackground).
importScripts('auth.js');

chrome.action.onClicked.addListener((tab) => {
    if (tab.url && tab.url.includes("youtube.com/watch")) {
        chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_PANEL" })
            .catch(err => console.log("Lütfen YouTube sayfasını F5 ile yenileyin."));
    }
});

// ESKİ YÖNTEMLER (artık kullanılmıyor): önce YouTube'un thumbnail DOM
// yapısını taklit eden sahte bir <a class="yt-simple-endpoint ..."> click
// dispatch'i, sonra thumbnail yapısına bağımlı olmayan ama YouTube'un iç
// router'ına dayanan history.pushState + 'popstate' event'i denendi. İkisi de
// YouTube'un sürekli değişen iç yapısına/router davranışına bağımlı olduğu
// için kırılgandı ve video hiç değişmeme riskiyle sonuçlanabiliyordu.
//
// GERÇEK ÇÖZÜM (referans alınan ornek.js'te de aynı şekilde): videoyu
// değiştirmek için content.js artık basitçe GERÇEK bir sayfa navigasyonu
// yapıyor (window.location.href = ".../watch?v=..."), bu yüzden MAIN world'de
// çalışan bu yardımcı fonksiyonlara artık gerek yok. Oturum (oda/kullanıcı)
// bilgisi reload öncesi sessionStorage'a kaydedilip sayfa yeniden yüklenince
// content.js tarafından otomatik geri yükleniyor (bkz. content.js
// saveSession/tryAutoRejoin).

// SESLİ SOHBET ORKESTRASYONU
//
// Video değişiminde content.js'in yaşadığı sekme reload'ı, sesli sohbetin
// mikrofon akışını ve WebRTC bağlantılarını da öldürmemesi için bunlar
// content.js'in İÇİNDE değil, background.js'in yönettiği kalıcı bir
// chrome.offscreen document'inde (voice-offscreen.html/js) yaşıyor. Bu
// doküman hiçbir sekmeye bağlı değildir; sekme kaç kez reload olursa olsun
// etkilenmez. content.js sadece ince kontrol mesajları (katıl/ayrıl/bas-konuş)
// gönderir, gerçek iş burada ve offscreen document'te yapılır.
//
// chrome.offscreen API'si uzantı başına TEK doküman izin verir — yani aynı
// anda sadece bir sekmenin sesli sohbeti aktif olabilir. activeVoice bu
// kısıtlamayı takip eder: hangi tabId'nin aktif sesli sohbeti "sahiplendiğini"
// tutar. Video değişimi sırasında tabId AYNI KALDIĞI için (window.location.href
// ile aynı sekmede navigasyon, yeni sekme değil) bu takip video değişiminde
// hiç bozulmaz — tam istenen davranış budur.
//
// Düz bir JS değişkeni yerine chrome.storage.session kullanılıyor çünkü
// background.js bir Manifest V3 service worker'ı — boşta kaldığında
// tarayıcı tarafından kapatılıp daha sonra sıfırdan uyandırılabilir. Bu
// olduğunda düz bir değişken kaybolurdu ama offscreen document (ve
// içindeki gerçek ses bağlantısı) ETKİLENMEDEN yaşamaya devam eder — bu da
// "activeVoice"ın gerçek durumla senkron kalması için session storage'da
// (tarayıcı oturumu boyunca kalıcı, service worker restart'larına dayanıklı)
// tutulmasını gerektiriyor.
async function getActiveVoice() {
    const { activeVoice } = await chrome.storage.session.get("activeVoice");
    return activeVoice || null;
}
async function setActiveVoice(value) {
    if (value) await chrome.storage.session.set({ activeVoice: value });
    else await chrome.storage.session.remove("activeVoice");
}

async function ensureOffscreenDocument() {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) return;
    await chrome.offscreen.createDocument({
        url: "voice-offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Watch party sesli sohbeti için mikrofon erişimi ve WebRTC bağlantıları"
    });
}

async function closeOffscreenDocumentIfExists() {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
}

async function sendToOffscreen(message) {
    try {
        return await chrome.runtime.sendMessage({ target: "voiceOffscreen", ...message });
    } catch (e) {
        // Offscreen doküman hiç oluşturulmamışsa (ör. daha önce hiç katılmadan
        // VOICE_LEAVE denenirse) "Receiving end does not exist" hatası fırlar —
        // bu durumda zaten yapacak bir şey yok, sessizce başarısız say.
        return { success: false };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "background") return false;

    // voice-offscreen.js'in chrome.storage.local'a KENDİ içinden erişmek
    // yerine token'ı buradan istemesi için (bkz. importScripts yorumu).
    if (message.action === "AUTH_GET_TOKEN") {
        (async () => {
            const token = await hbGetValidToken();
            sendResponse({ token });
        })();
        return true;
    }

    if (message.action === "VOICE_JOIN") {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: "Sekme bulunamadı." }); return false; }

        (async () => {
            const activeVoice = await getActiveVoice();
            // Farklı bir sekmede zaten aktif bir sesli sohbet varsa (offscreen
            // document tekilliği yüzünden) yeni bir tane açamayız.
            if (activeVoice && activeVoice.tabId !== tabId) {
                sendResponse({ success: false, error: "Başka bir sekmede zaten aktif bir sesli sohbet var." });
                return;
            }

            await ensureOffscreenDocument();
            const result = await sendToOffscreen({ action: "VOICE_JOIN", room: message.room, user: message.user });
            if (result?.success) {
                await setActiveVoice({ tabId, room: message.room, user: message.user });
            } else if (result?.permissionNeeded) {
                // Offscreen doküman görünmez olduğu için mikrofon izin balonunu
                // gösteremiyor (bkz. voice-offscreen.js joinVoice). Görünür küçük
                // bir pencerede izni bir kez tetikleyelim; kullanıcı izin verince
                // aynı origin için kalıcı olur ve sonraki denemeler direkt çalışır.
                chrome.windows.create({
                    url: chrome.runtime.getURL("mic-permission.html"),
                    type: "popup",
                    width: 420,
                    height: 260
                });
            }
            sendResponse(result);
        })();
        return true;
    }

    if (message.action === "VOICE_LEAVE") {
        const tabId = sender.tab?.id;
        (async () => {
            const result = await sendToOffscreen({ action: "VOICE_LEAVE" });
            const activeVoice = await getActiveVoice();
            if (activeVoice?.tabId === tabId) {
                await setActiveVoice(null);
                await closeOffscreenDocumentIfExists();
            }
            sendResponse(result);
        })();
        return true;
    }

    if (message.action === "VOICE_PTT_START" || message.action === "VOICE_PTT_STOP") {
        const tabId = sender.tab?.id;
        (async () => {
            const activeVoice = await getActiveVoice();
            // Sadece sesli sohbeti "sahiplenen" sekme mikrofonu kontrol edebilir.
            if (activeVoice?.tabId !== tabId) { sendResponse({ success: false }); return; }
            sendResponse(await sendToOffscreen({ action: message.action }));
        })();
        return true;
    }

    if (message.action === "VOICE_GET_STATUS") {
        const tabId = sender.tab?.id;
        (async () => {
            const activeVoice = await getActiveVoice();
            const inVoice = !!activeVoice && activeVoice.tabId === tabId;
            sendResponse({ inVoice, room: inVoice ? activeVoice.room : null, user: inVoice ? activeVoice.user : null });
        })();
        return true;
    }

    return false;
});

// Sekme gerçekten kapatılırsa (video değişimindeki reload'da tabId AYNI
// KALDIĞI için bu asla tetiklenmez) sesli sohbetten temiz bir şekilde çık.
chrome.tabs.onRemoved.addListener((tabId) => {
    (async () => {
        const activeVoice = await getActiveVoice();
        if (activeVoice?.tabId !== tabId) return;
        await setActiveVoice(null);
        try { await sendToOffscreen({ action: "VOICE_LEAVE" }); } catch (e) { /* yoksay */ }
        await closeOffscreenDocumentIfExists();
    })();
});
