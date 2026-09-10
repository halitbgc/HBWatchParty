// ORTAK AUTH YARDIMCILARI — hem content.js (YouTube sekmesindeki isolated
// world) hem voice-offscreen.js (background.js'in yönettiği offscreen
// document) bu dosyayı AYRI AYRI script tag'i ile yükler; ikisi de farklı JS
// bağlamı olduğu için fonksiyonlar paylaşılmıyor, ama chrome.storage.local
// PAYLAŞIMLI olduğu için tek bir yerde login olunca ikisi de aynı token'ı
// görüyor. Sunucuda refresh token YOK — süre dolunca kullanıcı tekrar login
// olmalı (bkz. görev tanımı).

const BACKEND_BASE_URL = "https://hbwatch.arztakvim.com.tr";

const HB_AUTH_STORAGE_KEY = "hbAuth"; // { token, expiresAtUtc, username, userId }
// expiresAtUtc'e tam o an değil, biraz önceden "süresi dolmuş" say — negotiate
// isteği ağda giderken token gerçekten dolmasın diye küçük bir güvenlik payı.
const HB_AUTH_EXPIRY_SKEW_MS = 30000;

function hbGetStoredAuth() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(HB_AUTH_STORAGE_KEY, (result) => {
                resolve(result?.[HB_AUTH_STORAGE_KEY] || null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function hbSaveAuth(auth) {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.set({ [HB_AUTH_STORAGE_KEY]: auth }, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

function hbClearAuth() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.remove(HB_AUTH_STORAGE_KEY, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

function hbIsAuthValid(auth) {
    if (!auth?.token || !auth?.expiresAtUtc) return false;
    const expiresAt = new Date(auth.expiresAtUtc).getTime();
    if (Number.isNaN(expiresAt)) return false;
    return expiresAt - HB_AUTH_EXPIRY_SKEW_MS > Date.now();
}

// SignalR accessTokenFactory ile doğrudan uyumlu: geçerli token varsa onu,
// yoksa/süresi dolmuşsa null döner (SignalR token olmadan bağlanmayı dener ve
// hub [Authorize] olduğu için sunucu 401 ile reddeder — çağıran taraf bunu
// yakalayıp login ekranına yönlendirmeli).
async function hbGetValidToken() {
    const auth = await hbGetStoredAuth();
    return hbIsAuthValid(auth) ? auth.token : null;
}

// Hem /api/auth/login hem /api/auth/register için ortak istemci. Sunucu 400
// (validation/Identity hata listesi) ya da 401 (login'de yanlış kullanıcı
// adı/şifre) dönebilir — ikisi de tek tek parse edilmeden generic bir mesaja
// düşürülüyor (bkz. görev tanımı: login'de "kullanıcı bulunamadı"/"şifre
// yanlış" ayrımı BİLEREK yapılmıyor, güvenlik kararı).
async function hbAuthRequest(path, username, password) {
    const isLogin = path === "/api/auth/login";
    try {
        const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        if (res.ok) {
            return { ok: true, data: await res.json() };
        }
        if (isLogin) {
            return { ok: false, error: "Kullanıcı adı veya şifre hatalı." };
        }
        return { ok: false, error: "Kayıt başarısız. Kullanıcı adı 3-64, şifre en az 8 karakter olmalı ya da bu kullanıcı adı zaten alınmış olabilir." };
    } catch (e) {
        return { ok: false, error: "Sunucuya bağlanılamadı." };
    }
}

// SignalR negotiate/start 401 ile reddedince fırlattığı hatanın mesajında
// "Unauthorized" geçer (kesin bir hata kodu/tipi yerine metin araması —
// SignalR JS istemcisi negotiate hatalarını sarmalayıp yeniden fırlatıyor).
function hbIsAuthError(err) {
    const msg = String(err?.message || err || "");
    return /unauthorized|401/i.test(msg);
}
