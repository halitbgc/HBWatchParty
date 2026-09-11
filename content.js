// BACKEND_BASE_URL, hbGetStoredAuth/hbIsAuthValid/hbGetValidToken/hbAuthRequest/
// hbIsAuthError auth.js'ten geliyor — manifest.json'da bu dosyadan önce, aynı
// (isolated world) content script bağlamına yükleniyor, bu yüzden ayrıca
// import etmeye gerek yok.
const hubUrl = `${BACKEND_BASE_URL}/watchpartyhub`;

let connection = null;
let currentRoom = "";
let currentUser = ""; // artık serbest metin değil — her zaman giriş yapılan hesabın GÖRÜNEN ADI (displayName), hesap username'i DEĞİL (bkz. connectToRoom) — sadece EKRANDA gösterilir (ör. kendi mesajının başlığı), artık hiçbir yerde adresleme/eşleştirme için kullanılmıyor
let currentUserId = ""; // hesap bazında BENZERSİZ ve SABİT userId — hub event'lerinde "bu bana mı ait" karşılaştırması ve sesli sohbet peer eşleştirmesi ARTIK BUNUNLA yapılıyor, displayName ile değil (görünen ad benzersiz olmak zorunda değil)
let pendingRejoinRoom = null; // login sonrası tekrar doldurulacak oda kodu (bkz. tryAutoRejoin/showRoomArea)
let videoElement = null;
let roomUsers = []; // ReceiveUserList ile dolan, odadaki katılımcılar — {userId, displayName} objeleri (hp-user-count popover'ı bundan besleniyor)

// userId -> displayName ÖNBELLEĞİ. ReceiveChatMessage/ReceiveTyping artık
// displayName TAŞIMIYOR (sadece userId) — backend bu bilgiyi ayrı olarak
// ReceiveUserList (tam liste, katılım/ayrılmada) ve ReceiveDisplayNameChanged
// (biri adını değiştirdiğinde, tek bir push) ile gönderiyor. İsim değişince
// artık HİÇBİR bağlantının kapanıp yeniden kurulmasına gerek yok — backend
// odadaki herkese (adını değiştiren dahil) bu event'i canlı yayınlıyor, biz
// sadece önbelleği güncelliyoruz.
const displayNameCache = new Map();
function resolveDisplayName(userId) {
    return displayNameCache.get(userId) || "Bilinmeyen kullanıcı";
}
let isPanelOpen = false; // Kullanıcının panelin açık olmasını istediği bilgisi (DOM'dan bağımsız, kalıcı)

// SESLİ SOHBET AYARLARI (Normal Mod / Bas-Konuş Modu + bas-konuş tuşu).
// Bunlar sadece content.js'in mevcut VOICE_PTT_START/VOICE_PTT_STOP mesajlarını
// NE ZAMAN gönderdiğini belirliyor — voice-offscreen.js/background.js'teki
// mikrofon/WebRTC/gürültü kapısı mekanizmasına hiç dokunulmuyor (bkz. setupVoiceUI,
// setupSettingsUI). Varsayılanlar mevcut (tek) davranışla birebir aynı: Bas-Konuş
// Modu + "V" tuşu — böylece ayarlar hiç açılmasa bile eski davranış değişmiyor.
let voiceMode = 'ptt'; // 'ptt' | 'normal'
let pttKeyCode = 'KeyV';

// GENEL ARAYÜZ AYARLARI (panel boyutu / mesaj bildirim sesi / tema). Voice
// ayarlarıyla aynı desende: chrome.storage.local'da kalıcı, varsayılanlar
// mevcut (tek) davranışla birebir aynı olacak şekilde seçildi.
let panelSize = 'medium'; // 'small' | 'medium' | 'large'
let notificationSoundEnabled = true;
let theme = 'dark'; // 'dark' | 'light'
let messageFontSize = 13; // 9 | 11 | 13 | 15 | 17

// "X yazıyor..." göstergesi. Sunucudan açık bir "yazmayı bıraktı" event'i
// istemiyoruz (ekstra round-trip) — her ReceiveTyping bir kullanıcı için
// TYPING_EXPIRE_MS'lik bir sayaç kurar/sıfırlar; süre içinde yeni sinyal
// gelmezse o kullanıcı otomatik olarak listeden düşer. Bu, karşı taraf
// sekmeyi aniden kapatsa bile göstergenin asılı kalmamasını sağlıyor.
let typingUsers = new Map(); // userId -> { timeoutId, displayName } — anahtar userId (benzersiz), displayName sadece göstergede yazı olarak kullanılır
let lastTypingSentAt = 0;
const TYPING_THROTTLE_MS = 2000; // yazarken en fazla bu sıklıkta sinyal gönder
const TYPING_EXPIRE_MS = 3000;   // bu süre yeni sinyal gelmezse "yazıyor" listesinden düş

// SENKRON KONTROLÜ: artık sunucu-merkezli — istemci hiçbir zamanlayıcı/
// karşılaştırma yapmıyor. Sunucu (PlaybackSyncBackgroundService) periyodik
// olarak "RequestPlaybackTime" ile soruyor, biz sadece cevap veriyoruz;
// karşılaştırmayı (en büyük - en küçük fark) sunucu yapıp sonucu
// ReceiveSyncWarning/ReceiveSyncOk ile bildiriyor.

// KÖK NEDEN: videoElement.currentTime = x atamak ile play()/pause() çağırmak
// tarayıcıda AYRI ZAMANLARDA event doğurur ('seeked' asenkron gelir, 'play'/
// 'pause' hemen gelir). Eskiden tek bir isExternalEvent bayrağı vardı ve "ilk
// gelen event bayrağı tüketsin" mantığıyla çalışıyordu; bu yüzden örn.
// ReceivePause sırasında currentTime + pause() ikisi de tetiklenince önce
// 'pause' eventi bayrağı tüketiyor, sonra asenkron gelen 'seeked' eventi
// bayrağı boş bulup bunu KULLANICININ bizzat sardığı bir hareket sanıp
// sunucuya SendSeek gönderiyordu (sahte "X saniyeye sardı" mesajı).
// Çözüm: event tipine özel bastırma seti — her beklenen event türü ayrı ayrı
// işaretlenir ve sadece o türden event geldiğinde tüketilir.
const suppressedVideoEvents = new Set();
function suppressVideoEvent(type, ttl = 2000) {
    suppressedVideoEvents.add(type);
    // Beklenen event bir sebepten (ör. currentTime zaten aynı değerdeyse
    // 'seeked' hiç ateşlenmeyebilir) hiç gelmezse bayrak sonsuza kadar takılı
    // kalıp sıradaki GERÇEK kullanıcı hareketini yanlışlıkla yutmasın diye
    // bir süre sonra kendiliğinden temizlenir.
    setTimeout(() => suppressedVideoEvents.delete(type), ttl);
}
function consumeSuppressedVideoEvent(type) {
    return suppressedVideoEvents.delete(type);
}

// OTURUM KALICILIĞI: panel açık/kapalı bilgisi ve son oda/kullanıcı bilgisi,
// sayfa gerçekten yeniden yüklenirse (ör. kullanıcının kendi F5'i) content
// script'in odaya sessizce otomatik yeniden katılabilmesi için sessionStorage'da
// tutuluyor (bkz. tryAutoRejoin). chrome.storage.local yerine bilerek
// sessionStorage kullanılıyor: chrome.storage tüm sekmeler ve tarayıcı
// oturumları arasında KALICI ve PAYLAŞIMLI olduğu için kullanıcı partiden
// tamamen ayrılıp haftalar sonra alakasız bir YouTube videosu açsa bile
// sessizce eski odaya otomatik bağlanırdı. sessionStorage ise tam istediğimiz
// kapsamda: bu SEKME içinde navigasyonlar arası hayatta kalır ama sekme
// kapanınca kendiliğinden temizlenir.
const SESSION_STORAGE_KEY = "hbWatchPartySession";

function saveSession() {
    if (!currentRoom || !currentUser) return;
    try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ room: currentRoom, user: currentUser, panelOpen: isPanelOpen }));
    } catch (e) { /* yoksay */ }
}

// VİDEO DEĞİŞTİRME: sayfa HİÇ yeniden yüklenmiyor. Chrome extension content
// script'leri "isolated world"da çalışıyor — DOM'u sayfayla paylaşır ama
// YouTube'un kendi script'lerinin #movie_player'a eklediği GERÇEK Player API
// metodları (loadVideoById vb.) sadece sayfanın kendi JS ortamından ("MAIN
// world") görünüyor. Çözüm: page-bridge.js adında, manifest.json'da
// "world":"MAIN" ile kayıtlı ayrı bir script MAIN world'de çalışıyor; biz ona
// bir CustomEvent ile videoId gönderiyoruz, o da gerçek player'a erişip
// videoyu (ve başlığı) değiştiriyor. Açıklama/yorumlar bölümü bu yöntemle
// güncellenmiyor (YouTube'un sayfa router'ı hiç tetiklenmediği için) — bu
// bilinen ve kabul edilen bir sınırlama.
function changeVideoInPlace(videoId) {
    const current = new URL(window.location.href);
    if (current.searchParams.get('v') === videoId) return; // zaten bu videodayız

    // Yeni videonun otomatik oynatması KULLANICININ bizzat yaptığı bir hareket
    // sanılıp sunucuya echo gitmesin diye kısa süreliğine bastırılıyor.
    suppressVideoEvent('play', 5000);
    suppressVideoEvent('pause', 5000);
    suppressVideoEvent('seeked', 5000);

    lastVideoId = videoId;
    window.dispatchEvent(new CustomEvent('hb-watchparty-change-video', { detail: { videoId } }));
}

// 1. İKONA TIKLANDIĞINDA ÇALIŞAN DİNLEYİCİ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "TOGGLE_PANEL") {
        toggleHBPanel();
    }
});

// YouTube'un video oynatıcısı genişliğini CSS flex reflow'una göre değil,
// kendi JS'i ile 'resize'/'fullscreenchange' gibi event'lere tepki olarak
// hesaplayıp uyguluyor. Panel ilk kez görünür hale geldiğinde (veya
// açılıp/kapanıp genişlik değiştiğinde) bu hesaplamayı biz tetiklemezsek
// video eski (panelsiz) genişliğinde kalıp panelin altında/üstünde görsel
// olarak çakışıyor — tam ekrana girip çıkmak YouTube'un kendi resize
// mantığını tetiklediği için "kendiliğinden düzeliyormuş" gibi görünüyordu.
// Burada aynı tetiklemeyi programatik olarak yapıyoruz; bir miktar gecikmeli
// tekrar deneme, CSS'in henüz uygulanmamış olma ihtimaline karşı güvenlik.
function nudgePlayerResize() {
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

// 2. İKON TIKLAMASI: paneli aç/kapa
function toggleHBPanel() {
    const panel = ensurePanelExists(true);
    if (!panel) return;

    isPanelOpen = !isPanelOpen;
    panel.style.display = isPanelOpen ? 'flex' : 'none';
    saveSession();
    if (isPanelOpen) setupVideoListeners();
    nudgePlayerResize();
}

// PANELİ OLUŞTUR (yoksa) VE #ytd-player'IN KARDEŞİ (sibling) OLARAK EKLE.
// Bilerek childı değil kardeşi yapıyoruz: YouTube video değiştiğinde
// #ytd-player'ın İÇİNİ (kendi Polymer şablonunu) yeniden çizebiliyor — bu
// panel onun çocuğu olsaydı silinip giderdi. Sibling olduğu için bu iç
// yeniden çizimden etkilenmiyor. Yine de her ihtimale karşı (ör. tüm
// #player-container yeniden oluşturulursa) bu fonksiyon yt-navigate-finish
// üzerinden her navigasyonda çağrılıp panel yoksa aynı bağlantı/oda
// state'iyle sıfırdan kuruluyor.
function ensurePanelExists(alertIfMissing = false) {
    let panel = document.getElementById('hb-party-panel');
    if (panel) return panel;

    const playerEl = document.querySelector('#ytd-player') || document.querySelector('#player-container');
    if (!playerEl) {
        if (alertIfMissing) alert("YouTube oynatıcısı henüz yüklenmedi.");
        return null;
    }

    panel = document.createElement('div');
    panel.id = 'hb-party-panel';
    panel.innerHTML = `
        <div id="hp-header">
            <span><img id="hp-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="">Watch Party</span>
            <span id="hp-header-right">
                <span id="hp-status"><div class="hp-dot" id="hp-dot"></div> <span id="hp-room-text">Bağlanmadı</span></span>
                <span id="hp-sync-warning" title="Videonuz diğer katılımcılarla senkron değil" hidden>⚠️ Senkron değil</span>
                <button id="hp-user-count" type="button" hidden></button>
                <button id="hp-settings-btn" class="hp-icon-btn" type="button" title="Ayarlar" aria-label="Ayarlar">⚙️</button>
            </span>
        </div>

        <div id="hp-user-list-popover" hidden>
            <div id="hp-user-list-title">Odadakiler</div>
            <ul id="hp-user-list"></ul>
        </div>

        <div id="hp-login-area">
            <div id="hp-auth-area">
                <div id="hp-auth-info" class="hp-auth-info" hidden></div>
                <div class="hp-segmented" id="hp-auth-mode-group">
                    <button type="button" class="hp-segmented-option" data-auth-mode="login">Giriş Yap</button>
                    <button type="button" class="hp-segmented-option" data-auth-mode="register">Kayıt Ol</button>
                </div>
                <input type="text" id="hp-auth-username" class="hp-input" placeholder="Kullanıcı adı" autocomplete="username">
                <input type="password" id="hp-auth-password" class="hp-input" placeholder="Şifre" autocomplete="current-password">
                <div id="hp-auth-error" class="hp-auth-error" hidden></div>
                <button id="hp-auth-submit-btn" class="hp-btn" type="button">Giriş Yap</button>
            </div>

            <div id="hp-room-area" hidden>
                <div id="hp-room-account-row" class="hp-account-row">
                    <span id="hp-room-account-label"></span>
                </div>
                <div id="hp-room-error" class="hp-auth-error" hidden></div>
                <button id="hp-create-room-btn" class="hp-btn" type="button">Oda Oluştur</button>
                <div class="hp-room-divider">veya</div>
                <input type="text" id="hp-roomname" class="hp-input" placeholder="Oda Kodu (Örn: TQWHJO)" maxlength="6" autocomplete="off">
                <button id="hp-join-room-btn" class="hp-btn" type="button">Odaya Katıl</button>
            </div>
        </div>

        <div id="hp-chat-area">
            <button id="hp-ptt-btn" class="hp-btn hp-ptt-btn" style="display:none;">🎙️ Basılı Tut, Konuş ("V")</button>
            <div id="hp-messages"></div>
            <div id="hp-emoji-picker" hidden>
                <div id="hp-emoji-search-row">
                    <input type="text" id="hp-emoji-search" class="hp-input" placeholder="Emoji ara...">
                </div>
                <div id="hp-emoji-tabs">
                    <button type="button" class="hp-emoji-tab" data-category="recent" title="Sık Kullanılanlar">🕒</button>
                    <button type="button" class="hp-emoji-tab" data-category="smileys" title="Yüzler ve İnsanlar">😀</button>
                    <button type="button" class="hp-emoji-tab" data-category="animals" title="Hayvanlar ve Doğa">🐻</button>
                    <button type="button" class="hp-emoji-tab" data-category="food" title="Yiyecek ve İçecek">🍔</button>
                    <button type="button" class="hp-emoji-tab" data-category="activities" title="Aktiviteler">⚽</button>
                    <button type="button" class="hp-emoji-tab" data-category="travel" title="Seyahat ve Yerler">🚗</button>
                    <button type="button" class="hp-emoji-tab" data-category="objects" title="Nesneler">💡</button>
                    <button type="button" class="hp-emoji-tab" data-category="symbols" title="Semboller">❤️</button>
                    <button type="button" class="hp-emoji-tab" data-category="flags" title="Bayraklar">🚩</button>
                </div>
                <div id="hp-emoji-body"></div>
            </div>
            <div id="hp-composer">
                <input type="text" id="hp-msg-input" class="hp-composer-input" placeholder="Mesaj yazın...">
                <div id="hp-composer-toolbar">
                    <div id="hp-composer-toolbar-left">
                        <button id="hp-voice-toggle-btn" class="hp-icon-btn hp-composer-icon" type="button" title="Sesli Sohbete Katıl" aria-label="Sesli Sohbete Katıl">🎤</button>
                    </div>
                    <div id="hp-composer-toolbar-right">
                        <button id="hp-emoji-btn" class="hp-icon-btn hp-composer-icon" type="button" title="Emoji" aria-label="Emoji">😊</button>
                        <button id="hp-send-btn" class="hp-icon-btn hp-composer-icon hp-send-icon" type="button" title="Gönder" aria-label="Gönder">➤</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="hp-settings-panel" hidden>
            <div id="hp-settings-header">
                <span>Ayarlar</span>
                <button id="hp-settings-close-btn" class="hp-icon-btn" type="button" title="Kapat" aria-label="Kapat">✕</button>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Hesap</div>
                <div id="hp-settings-account-row" class="hp-account-row">
                    <span id="hp-settings-account-username">—</span>
                </div>
                <button id="hp-logout-btn" class="hp-btn hp-btn-danger" type="button" hidden>Çıkış Yap</button>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Görünen Ad</div>
                <input type="text" id="hp-display-name-input" class="hp-input" placeholder="Görünen adın" maxlength="20" autocomplete="off">
                <div id="hp-display-name-error" class="hp-auth-error" hidden></div>
                <button id="hp-display-name-save-btn" class="hp-btn" type="button">Kaydet</button>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Sesli Sohbet Modu</div>
                <div class="hp-segmented" id="hp-voice-mode-group">
                    <button type="button" class="hp-segmented-option" data-mode="ptt">Bas-Konuş Modu</button>
                    <button type="button" class="hp-segmented-option" data-mode="normal">Normal Mod</button>
                </div>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Bas-Konuş Tuşu</div>
                <button id="hp-ptt-key-capture-btn" class="hp-btn hp-key-capture-btn" type="button">
                    Tuş: <span id="hp-ptt-key-label">V</span>
                </button>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Panel Boyutu</div>
                <div class="hp-segmented" id="hp-panel-size-group">
                    <button type="button" class="hp-segmented-option" data-size="small">Küçük</button>
                    <button type="button" class="hp-segmented-option" data-size="medium">Orta</button>
                    <button type="button" class="hp-segmented-option" data-size="large">Büyük</button>
                </div>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Mesaj Yazı Boyutu</div>
                <div class="hp-segmented" id="hp-msg-font-size-group">
                    <button type="button" class="hp-segmented-option" data-font-size="9">9</button>
                    <button type="button" class="hp-segmented-option" data-font-size="11">11</button>
                    <button type="button" class="hp-segmented-option" data-font-size="13">13</button>
                    <button type="button" class="hp-segmented-option" data-font-size="15">15</button>
                    <button type="button" class="hp-segmented-option" data-font-size="17">17</button>
                </div>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Bildirimler</div>
                <button type="button" class="hp-toggle-row" id="hp-sound-toggle-btn" aria-pressed="true">
                    <span>Yeni mesaj geldiğinde ses çal</span>
                    <span class="hp-toggle-switch"></span>
                </button>
            </div>

            <div class="hp-settings-section">
                <div class="hp-settings-label">Görünüm</div>
                <div class="hp-segmented" id="hp-theme-group">
                    <button type="button" class="hp-segmented-option" data-theme="dark">Koyu</button>
                    <button type="button" class="hp-segmented-option" data-theme="light">Açık</button>
                </div>
            </div>
        </div>
    `;

    playerEl.after(panel);
    setupUIEvents();

    panel.style.display = isPanelOpen ? 'flex' : 'none';
    nudgePlayerResize(); // panel ilk kez DOM'a eklenip görünür olduğunda video'yu doğru genişliğe zorla

    // Content script her navigasyonda (video değişimi dahil) yeniden çalışabilir
    // (bkz. reload tabanlı video değiştirme); SignalR bağlantısı hâlâ bu script
    // instance'ı içinde ayaktaysa arayüzü login ekranı yerine doğrudan bağlı
    // görünümle göster. Değilse (ör. taze bir reload sonrası) kayıtlı bir
    // oturum var mı diye bakıp varsa sessizce otomatik yeniden bağlan.
    if (connection?.state === signalR.HubConnectionState.Connected) {
        showConnectedUI();
    } else {
        tryAutoRejoin();
    }

    return panel;
}

function showConnectedUI() {
    const loginArea = document.getElementById('hp-login-area');
    const chatArea = document.getElementById('hp-chat-area');
    if (!loginArea || !chatArea) return;
    loginArea.style.display = 'none';
    chatArea.style.display = 'flex';
    document.getElementById('hp-room-text').textContent = currentRoom;
    document.getElementById('hp-dot').classList.add('connected');

    // Sesli sohbet, background.js'in yönettiği kalıcı bir offscreen document'te
    // yaşıyor ve video-değişim reload'larından etkilenmiyor (bkz. VOICE
    // ORKESTRASYONU, background.js). Panel her yeniden oluşturulduğunda
    // (reload sonrası dahil) gerçek durumu sorup butonu ona göre gösteriyoruz —
    // ASLA otomatik olarak yeniden katılmaya çalışmıyoruz çünkü zaten hiç kopmadı.
    refreshVoiceUIFromBackground();
}

// Sayfa (video değişimi ya da başka bir sebeple) gerçekten yeniden yüklendiğinde
// bu script sıfırdan çalışır ve connection/currentRoom/currentUser kaybolur.
// sessionStorage'da kayıtlı bir oda oturumu varsa VE hâlâ geçerli bir giriş
// (token) varsa kullanıcıya login formu göstermek yerine sessizce aynı odaya
// yeniden bağlanıyoruz. Token yoksa/süresi dolmuşsa (bkz. hbIsAuthValid) oda
// bilgisini kaybetmeden (pendingRejoinRoom) login ekranını gösteriyoruz.
async function tryAutoRejoin() {
    if (connection) return;
    let session = null;
    try {
        session = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY));
    } catch (e) { /* yoksay */ }

    if (session?.panelOpen) {
        isPanelOpen = true;
        const panel = document.getElementById('hb-party-panel');
        if (panel) panel.style.display = 'flex';
        nudgePlayerResize();
    }

    const auth = await hbGetStoredAuth();
    if (!hbIsAuthValid(auth)) {
        pendingRejoinRoom = session?.room || null;
        showAuthArea(auth ? "Oturumun sona erdi, tekrar giriş yap." : null);
        return;
    }

    showRoomArea(auth.username);
    if (!session?.room) return;

    const roomInput = document.getElementById('hp-roomname');
    if (roomInput) roomInput.value = session.room;

    connectToRoom(session.room);
}

// 3. SIGNALR BAĞLANTISI
// roomCode: hub'a bağlanılacak oda kodu — ÇAĞIRAN TARAF bu kodun gerçekten var
// olduğunu (ya da az önce backend tarafından üretildiğini) önceden doğrulamış
// olmalı (bkz. setupRoomUI: hbCreateRoom/hbCheckRoom). Bu fonksiyon sadece hub
// bağlantısını kurar, oda kodu doğrulaması yapmaz.
async function connectToRoom(roomCode) {
    // /watchpartyhub artık [Authorize] — bağlanmadan önce token'ın gerçekten
    // geçerli olduğunu kontrol ediyoruz (süresi dolmuşsa sessizce reddedilip
    // kullanıcıyı şaşırtmak yerine net bir mesajla login ekranına dönüyoruz).
    const auth = await hbGetStoredAuth();
    if (!hbIsAuthValid(auth)) {
        pendingRejoinRoom = roomCode || null;
        showAuthArea("Oturumun sona erdi, tekrar giriş yap.");
        return false;
    }
    currentUser = auth.displayName || auth.username;
    currentUserId = auth.userId;
    currentRoom = roomCode;

    connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl, { accessTokenFactory: () => hbGetValidToken() })
        .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: (retryContext) => {
                if (retryContext.previousRetryCount === 0) return 0;
                if (retryContext.previousRetryCount === 1) return 2000;
                if (retryContext.previousRetryCount === 2) return 5000;
                return 10000;
            }
        })
        .build();

    connection.on("ReceiveSystemMessage", msg => appendMessage(msg, 'system'));
    // Kendi mesajımız zaten gönderirken optimistic olarak ekrana eklendiği için
    // (bkz. btnSend click handler'ı) sunucudan geri gelen kendi echo'muzu
    // yoksayıyoruz — aksi halde aynı mesaj iki kez görünürdü. Karşılaştırma
    // userId ile yapılıyor (displayName ile DEĞİL — aynı görünen ada sahip
    // başka biri varsa displayName karşılaştırması yanlış sonuç verirdi).
    // Event artık displayName TAŞIMIYOR (sadece userId, msg) — isim
    // displayNameCache'ten çözülüyor (bkz. ReceiveUserList/ReceiveDisplayNameChanged).
    connection.on("ReceiveChatMessage", (userId, msg) => {
        if (userId === currentUserId) return;
        clearTyping(userId);
        appendMessage(msg, 'other', resolveDisplayName(userId));
        playNotificationSound();
    });

    connection.on("ReceiveTyping", (userId) => {
        if (userId === currentUserId) return;
        registerTyping(userId, resolveDisplayName(userId));
    });

    connection.on("ReceivePlay", (time) => {
        if (!videoElement) return;
        if (Math.abs(videoElement.currentTime - time) > 1) {
            suppressVideoEvent('seeked');
            videoElement.currentTime = time;
        }
        suppressVideoEvent('play');
        videoElement.play();
    });

    connection.on("ReceivePause", (time) => {
        if (!videoElement) return;
        suppressVideoEvent('seeked');
        suppressVideoEvent('pause');
        videoElement.currentTime = time;
        videoElement.pause();
    });

    connection.on("ReceiveSeek", (time) => {
        if (!videoElement) return;
        suppressVideoEvent('seeked');
        videoElement.currentTime = time;
    });

    connection.on("ReceiveChangeVideo", (newVideoId) => {
        changeVideoInPlace(newVideoId);
    });

    connection.on("ReceiveUserCount", (count) => {
        const el = document.getElementById('hp-user-count');
        if (!el) return;
        el.textContent = `👥 ${count}`;
        el.hidden = false;
    });

    connection.on("ReceiveUserList", (participants) => {
        // participants: [{ userId, displayName }, ...] — düz string listesi DEĞİL.
        // Bu, displayNameCache'in ANA doldurma kaynağı (tam liste, katılım/
        // ayrılmada gelir) — ReceiveChatMessage/ReceiveTyping'in artık taşımadığı
        // ismi buradan çözüyoruz.
        roomUsers = Array.isArray(participants) ? participants : [];
        roomUsers.forEach(({ userId, displayName }) => displayNameCache.set(userId, displayName));
        renderUserList();
    });

    // Biri (adını değiştiren kullanıcı dahil) görünen adını değiştirdiğinde
    // backend odadaki HERKESE bunu canlı yayınlıyor — artık ne yeni bir token
    // ne de bağlantının yeniden kurulması gerekiyor (bkz. handleSaveDisplayName,
    // eski "connection.stop()+yeniden bağlan" mantığı kaldırıldı).
    connection.on("ReceiveDisplayNameChanged", (userId, newDisplayName) => {
        displayNameCache.set(userId, newDisplayName);
        const entry = roomUsers.find(p => p.userId === userId);
        if (entry) entry.displayName = newDisplayName;
        renderUserList(); // popover açıksa yeni adı anında yansıt

        // Kendi adımız değiştiyse (ör. başka bir sekmeden değiştirilmişse)
        // optimistic self-mesaj etiketimizi de güncelleyelim.
        if (userId === currentUserId) currentUser = newDisplayName;
    });

    // Sunucu (PlaybackSyncBackgroundService) periyodik olarak soruyor, biz
    // sadece o anki oynatma zamanımızla cevap veriyoruz. Video yoksa/duraklatılmışsa
    // da gerçek zamanı gönderiyoruz — karşılaştırmayı sunucu yapıyor. Kullanıcı
    // TAM O AN videoyu sarıyorsa (videoElement.seeking) hiç cevap vermiyoruz —
    // sarma bitene kadar geçici/gürültülü bir değer o turun karşılaştırmasına
    // hiç karışmasın diye.
    connection.on("RequestPlaybackTime", () => {
        if (!videoElement || videoElement.seeking) return;
        connection.invoke("ReportPlaybackTime", currentRoom, videoElement.currentTime).catch(() => { /* yoksay */ });
    });

    connection.on("ReceiveSyncWarning", () => {
        const el = document.getElementById('hp-sync-warning');
        if (el) el.hidden = false;
    });

    connection.on("ReceiveSyncOk", () => {
        const el = document.getElementById('hp-sync-warning');
        if (el) el.hidden = true;
    });

    try {
        await connection.start();
        await connection.invoke("JoinRoom", currentRoom);
        showConnectedUI();
        saveSession();
        setupVideoListeners(); // panel kapalıyken bağlanılsa (ör. otomatik yeniden katılım) bile video event'leri izlensin
        return true;
    } catch (err) {
        console.error("SignalR Hatası:", err);
        connection = null;

        // Negotiate/start 401 ile reddedildiyse (token yok/geçersiz/süresi
        // dolmuş) mevcut oda kodunu kaybetmeden temiz bir şekilde login
        // ekranına dön — aksi halde (ör. sunucu gerçekten kapalıysa) oda
        // ekranında genel bir hata göster.
        if (hbIsAuthError(err)) {
            pendingRejoinRoom = currentRoom || null;
            await hbClearAuth();
            showAuthArea("Oturumun sona erdi, tekrar giriş yap.");
        } else {
            showRoomError("Bağlantı kurulamadı. Sunucu açık mı?");
        }
        return false;
    }
}

// 4. BUTONLAR
function setupUIEvents() {
    const btnSend = document.getElementById('hp-send-btn');
    const inputMsg = document.getElementById('hp-msg-input');

    btnSend.addEventListener('click', async () => {
        const text = inputMsg.value.trim();
        if (text === "" || !connection) return;

        // Optimistic UI: sunucudan echo beklemeden mesajı hemen ekle — ReceiveChatMessage
        // handler'ı zaten kendi mesajımızın echo'sunu yoksayıyor, bu yüzden iki kez görünmez.
        appendMessage(text, 'self', currentUser);
        inputMsg.value = "";

        try {
            await connection.invoke("SendChatMessage", currentRoom, text);
        } catch (err) {
            console.error("HB WatchParty: mesaj gönderilemedi", err);
        }
    });

    inputMsg.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') btnSend.click();
    });

    // "X yazıyor..." göstergesi: her tuş vuruşunda değil, en fazla
    // TYPING_THROTTLE_MS'de bir sinyal gönderiyoruz — sunucuyu/hub'ı gereksiz
    // yere yormamak için. Kutuyu tamamen silince de sinyal göndermiyoruz.
    inputMsg.addEventListener('input', () => {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
        if (inputMsg.value.trim() === "") return;
        const now = Date.now();
        if (now - lastTypingSentAt < TYPING_THROTTLE_MS) return;
        lastTypingSentAt = now;
        connection.invoke("SendTyping", currentRoom).catch(() => { /* yoksay — kritik değil */ });
    });

    setupAuthUI();
    setupRoomUI();
    setupVoiceUI();
    setupSettingsUI();
    setupEmojiPicker();
    setupUserListPopover();
}

// AUTH (Giriş Yap / Kayıt Ol / Oda Kodu) ARAYÜZÜ: bkz. görev tanımı — backend'e
// artık kullanıcı hesabı sistemi eklendiği için odaya katılmadan önce bir hesap
// login'i gerekiyor. #hp-login-area içinde iki alt bölüm var: #hp-auth-area
// (giriş/kayıt formu) ve #hp-room-area (sadece oda kodu — kullanıcı adı artık
// serbest metin değil, giriş yapılan hesabın username'i, bkz. connectToRoom).
function setupAuthUI() {
    const modeButtons = Array.from(document.querySelectorAll('#hp-auth-mode-group .hp-segmented-option'));
    const usernameInput = document.getElementById('hp-auth-username');
    const passwordInput = document.getElementById('hp-auth-password');
    const errorEl = document.getElementById('hp-auth-error');
    const submitBtn = document.getElementById('hp-auth-submit-btn');
    if (!modeButtons.length || !usernameInput || !passwordInput || !errorEl || !submitBtn) return;

    let authMode = 'login';

    function setError(message) {
        if (!message) { errorEl.hidden = true; errorEl.textContent = ''; return; }
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function applyAuthModeUI() {
        modeButtons.forEach(btn => btn.classList.toggle('selected', btn.dataset.authMode === authMode));
        submitBtn.textContent = authMode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
        setError(null);
    }

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.authMode === authMode) return;
            authMode = btn.dataset.authMode;
            applyAuthModeUI();
        });
    });

    async function submitAuth() {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        setError(null);

        if (username.length < 3 || username.length > 64) return setError("Kullanıcı adı 3-64 karakter olmalı.");
        if (password.length < 8) return setError("Şifre en az 8 karakter olmalı.");

        submitBtn.disabled = true;
        submitBtn.textContent = authMode === 'login' ? "Giriş yapılıyor..." : "Kayıt olunuyor...";

        const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const result = await hbAuthRequest(path, username, password);

        submitBtn.disabled = false;
        applyAuthModeUI();

        if (!result.ok) return setError(result.error);

        await hbSaveAuth(result.data);
        usernameInput.value = '';
        passwordInput.value = '';
        showRoomArea(result.data.username);
        updateSettingsAccountSection();
    }

    submitBtn.addEventListener('click', submitAuth);
    [usernameInput, passwordInput].forEach(input => {
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAuth(); });
    });

    applyAuthModeUI();
}

// ODA OLUŞTUR / ODAYA KATIL REST İSTEMCİSİ: backend'de artık oda kodu
// kullanıcı tarafından seçilemiyor — /api/rooms [Authorize] korumalı, ya yeni
// bir kod üretiyor (POST) ya da girilen kodun var olup olmadığını doğruluyor
// (GET /api/rooms/{code}). İkisi de aynı hata deseniyle (401/404/400) dönüyor,
// bu yüzden tek bir ortak istemci fonksiyonu yeterli.
async function hbRoomApiRequest(path, method) {
    const token = await hbGetValidToken();
    if (!token) return { ok: false, authRequired: true, error: "Oturumun sona erdi, tekrar giriş yap." };

    try {
        const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) return { ok: true, data: await res.json() };
        if (res.status === 401) return { ok: false, authRequired: true, error: "Oturumun sona erdi, tekrar giriş yap." };
        if (res.status === 404) return { ok: false, error: "Bu kodla bir oda bulunamadı, kodu kontrol edin." };
        if (res.status === 400) return { ok: false, error: "Geçersiz oda kodu formatı." };
        return { ok: false, error: "Sunucuya bağlanılamadı." };
    } catch (e) {
        return { ok: false, error: "Sunucuya bağlanılamadı." };
    }
}

function hbCreateRoom() {
    return hbRoomApiRequest('/api/rooms', 'POST');
}

function hbCheckRoom(code) {
    return hbRoomApiRequest(`/api/rooms/${encodeURIComponent(code)}`, 'GET');
}

function showRoomError(message) {
    const errorEl = document.getElementById('hp-room-error');
    if (!errorEl) return;
    if (!message) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.textContent = message;
    errorEl.hidden = false;
}

// "Oda Oluştur" (kod backend'den geliyor, kullanıcı hiçbir şey yazmıyor) ve
// "Odaya Katıl" (kullanıcı kodu yazar, hub'a bağlanmadan ÖNCE GET ile var
// olduğu doğrulanır) akışlarını yönetir. Doğrulama/oluşturma başarılı olunca
// mevcut connectToRoom(roomCode) ile hub bağlantısı kurulur — hub tarafında
// (JoinRoom ve sonrası) hiçbir değişiklik yok.
function setupRoomUI() {
    const createBtn = document.getElementById('hp-create-room-btn');
    const joinBtn = document.getElementById('hp-join-room-btn');
    const roomInput = document.getElementById('hp-roomname');
    if (!createBtn || !joinBtn || !roomInput) return;

    // Sadece A-Z/0-9 kabul et, otomatik büyük harfe çevir, en fazla 6 karakter
    // (bkz. backend roomCode formatı) — backend zaten doğruluyor ama önden
    // engellemek daha iyi UX.
    roomInput.addEventListener('input', () => {
        const cleaned = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (cleaned !== roomInput.value) roomInput.value = cleaned;
    });

    async function handleAuthRequiredOrError(result) {
        if (result.authRequired) {
            await hbClearAuth();
            showAuthArea("Oturumun sona erdi, tekrar giriş yap.");
        } else {
            showRoomError(result.error);
        }
    }

    createBtn.addEventListener('click', async () => {
        showRoomError(null);
        createBtn.disabled = true;
        joinBtn.disabled = true;
        const originalText = createBtn.textContent;
        createBtn.textContent = "Oluşturuluyor...";

        const result = await hbCreateRoom();
        if (!result.ok) {
            await handleAuthRequiredOrError(result);
        } else {
            createBtn.textContent = "Bağlanıyor...";
            await connectToRoom(result.data.roomCode);
        }

        createBtn.disabled = false;
        joinBtn.disabled = false;
        createBtn.textContent = originalText;
    });

    async function submitJoin() {
        const code = roomInput.value.trim().toUpperCase();
        showRoomError(null);
        if (code.length !== 6) return showRoomError("Oda kodu 6 karakter olmalı.");

        joinBtn.disabled = true;
        createBtn.disabled = true;
        const originalText = joinBtn.textContent;
        joinBtn.textContent = "Kontrol ediliyor...";

        const result = await hbCheckRoom(code);
        if (!result.ok) {
            await handleAuthRequiredOrError(result);
        } else {
            joinBtn.textContent = "Bağlanıyor...";
            await connectToRoom(result.data.roomCode);
        }

        joinBtn.disabled = false;
        createBtn.disabled = false;
        joinBtn.textContent = originalText;
    }

    joinBtn.addEventListener('click', submitJoin);
    roomInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitJoin(); });
}

// Login/Kayıt formunu gösterir (oda alanı gizlenir). infoMessage verilirse
// (ör. "Oturumun sona erdi, tekrar giriş yap.") formun üstünde bir bilgi
// kutusu olarak gösterilir — session'ı sessizce kaybetmiş gibi göstermemek için.
function showAuthArea(infoMessage) {
    const loginArea = document.getElementById('hp-login-area');
    const chatArea = document.getElementById('hp-chat-area');
    const authArea = document.getElementById('hp-auth-area');
    const roomArea = document.getElementById('hp-room-area');
    const infoEl = document.getElementById('hp-auth-info');
    if (!loginArea || !authArea || !roomArea) return;

    if (chatArea) chatArea.style.display = 'none';
    loginArea.style.display = 'flex';
    authArea.hidden = false;
    roomArea.hidden = true;

    if (infoEl) {
        if (infoMessage) { infoEl.textContent = infoMessage; infoEl.hidden = false; }
        else { infoEl.hidden = true; infoEl.textContent = ''; }
    }

    document.getElementById('hp-dot')?.classList.remove('connected');
    const roomText = document.getElementById('hp-room-text');
    if (roomText) roomText.textContent = 'Bağlanmadı';
}

// Giriş yapılmış ama henüz bir odaya bağlanılmamış durumda gösterilen ekran
// (sadece oda kodu girilir). pendingRejoinRoom doluysa (ör. token süresi
// dolduğu için login'e düşülmüş, kullanıcı tekrar giriş yaptı) oda kodunu
// otomatik doldurur ama OTOMATİK BAĞLANMAZ — kullanıcı "Odaya Katıl"a basmalı.
function showRoomArea(username) {
    const loginArea = document.getElementById('hp-login-area');
    const chatArea = document.getElementById('hp-chat-area');
    const authArea = document.getElementById('hp-auth-area');
    const roomArea = document.getElementById('hp-room-area');
    if (!loginArea || !authArea || !roomArea) return;

    if (chatArea) chatArea.style.display = 'none';
    loginArea.style.display = 'flex';
    authArea.hidden = true;
    roomArea.hidden = false;
    showRoomError(null);

    const accountLabel = document.getElementById('hp-room-account-label');
    if (accountLabel) accountLabel.textContent = `${username} olarak giriş yaptın`;

    if (pendingRejoinRoom) {
        const roomInput = document.getElementById('hp-roomname');
        if (roomInput && !roomInput.value) roomInput.value = pendingRejoinRoom;
        pendingRejoinRoom = null;
    }
}

// Ayarlar panelindeki "Hesap" (kullanıcı adı + Çıkış Yap) ve "Görünen Ad"
// (input'un mevcut değeri) bölümlerini güncel auth durumuna göre tazeler —
// panel her açıldığında çağrılır.
async function updateSettingsAccountSection() {
    const usernameEl = document.getElementById('hp-settings-account-username');
    const logoutBtn = document.getElementById('hp-logout-btn');
    const displayNameInput = document.getElementById('hp-display-name-input');
    const displayNameSaveBtn = document.getElementById('hp-display-name-save-btn');
    if (!usernameEl || !logoutBtn) return;
    const auth = await hbGetStoredAuth();
    if (hbIsAuthValid(auth)) {
        usernameEl.textContent = `${auth.username} olarak giriş yaptın`;
        logoutBtn.hidden = false;
        if (displayNameInput) { displayNameInput.disabled = false; displayNameInput.value = auth.displayName || auth.username; }
        if (displayNameSaveBtn) displayNameSaveBtn.disabled = false;
        setDisplayNameError(null);
    } else {
        usernameEl.textContent = "Giriş yapılmadı";
        logoutBtn.hidden = true;
        if (displayNameInput) { displayNameInput.disabled = true; displayNameInput.value = ''; }
        if (displayNameSaveBtn) displayNameSaveBtn.disabled = true;
    }
}

function setDisplayNameError(message) {
    const errorEl = document.getElementById('hp-display-name-error');
    if (!errorEl) return;
    if (!message) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.textContent = message;
    errorEl.hidden = false;
}

// GÖRÜNEN ADI KAYDET: backend artık displayName'i JWT'ye hiç gömmüyor — token
// DEĞİŞMİYOR, bu yüzden burada token saklamaya ya da hub bağlantısını yeniden
// kurmaya GEREK YOK (eski mimaride vardı, backend değişikliğiyle kaldırıldı).
// Odadaki/sesli sohbetteki herkese (biz dahil) yeni adı backend zaten
// ReceiveDisplayNameChanged/VoicePeerDisplayNameChanged event'leriyle canlı
// yayınlıyor — biz sadece storage'daki displayName alanını (sonraki panel
// açılışlarında input'u doğru doldurmak için) ve in-memory currentUser'ı
// güncelleyip kısa bir onay gösteriyoruz.
async function handleSaveDisplayName() {
    const input = document.getElementById('hp-display-name-input');
    const saveBtn = document.getElementById('hp-display-name-save-btn');
    if (!input || !saveBtn) return;

    const displayName = input.value.trim();
    setDisplayNameError(null);
    if (!displayName) return setDisplayNameError("Görünen ad boş olamaz.");
    if (displayName.length > 20) return setDisplayNameError("Görünen ad en fazla 20 karakter olabilir.");

    const token = await hbGetValidToken();
    if (!token) {
        await hbClearAuth();
        showAuthArea("Oturumun sona erdi, tekrar giriş yap.");
        return;
    }

    saveBtn.disabled = true;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "Kaydediliyor...";

    try {
        const res = await fetch(`${BACKEND_BASE_URL}/api/users/display-name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ displayName })
        });

        if (res.ok) {
            // Yanıt artık sadece { userId, displayName } — token/expiresAtUtc/
            // username YOK. Storage'daki auth objesinin geri kalanına
            // dokunmadan sadece displayName alanını güncelliyoruz (blind
            // overwrite yaparsak token'ı silmiş oluruz).
            const data = await res.json();
            const existingAuth = await hbGetStoredAuth();
            if (existingAuth) await hbSaveAuth({ ...existingAuth, displayName: data.displayName });
            input.value = data.displayName;
            currentUser = data.displayName; // bağlıysak/değilsek fark etmeden anında güncelle

            saveBtn.textContent = "Kaydedildi ✓";
            setTimeout(() => { saveBtn.textContent = originalText; }, 1500);
            saveBtn.disabled = false;
            return;
        } else if (res.status === 401) {
            await hbClearAuth();
            showAuthArea("Oturumun sona erdi, tekrar giriş yap.");
        } else if (res.status === 400) {
            setDisplayNameError("Görünen ad boş olamaz ya da 20 karakterden uzun olamaz.");
        } else {
            setDisplayNameError("Sunucuya bağlanılamadı.");
        }
    } catch (e) {
        setDisplayNameError("Sunucuya bağlanılamadı.");
    }

    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
}

// ÇIKIŞ YAP: aktif oda bağlantısını ve sesli sohbeti temiz bir şekilde
// kapatır, sessionStorage'daki oda oturumunu ve chrome.storage'daki token'ı
// temizler, ardından login ekranına döner. Sesli sohbet offscreen document'te
// yaşadığı için (bkz. background.js) burada da açıkça VOICE_LEAVE gönderiliyor.
async function handleLogout() {
    try { await chrome.runtime.sendMessage({ target: "background", action: "VOICE_LEAVE" }); } catch (e) { /* yoksay */ }

    if (connection) {
        try { await connection.stop(); } catch (e) { /* yoksay */ }
        connection = null;
    }

    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* yoksay */ }
    currentRoom = "";
    currentUser = "";
    currentUserId = "";
    roomUsers = [];

    await hbClearAuth();
    await closeSettingsPanel();
}

// EMOJİ VERİSİ: [emoji, kategori, arama anahtar kelimeleri] üçlüleri.
// Sadece seçici arayüzü için statik bir veri kümesi — mesaj gönderme akışıyla
// (SendChatMessage) hiçbir ilgisi yok, seçilen emoji sadece #hp-msg-input'a
// eklenen sıradan bir metin karakteri.
const EMOJI_DATA = [
    // Yüzler ve İnsanlar
    ["😀", "smileys", "gülümseme mutlu"], ["😃", "smileys", "gülümseme mutlu"], ["😄", "smileys", "gülme mutlu"],
    ["😁", "smileys", "sırıtma"], ["😆", "smileys", "kahkaha"], ["😅", "smileys", "ter gülümseme"],
    ["🤣", "smileys", "yerlerde gülmek"], ["😂", "smileys", "sevinç gözyaşı gülme"], ["🙂", "smileys", "hafif gülümseme"],
    ["🙃", "smileys", "ters yüz"], ["😉", "smileys", "göz kırpma"], ["😊", "smileys", "mahcup gülümseme"],
    ["😇", "smileys", "melek masum"], ["🥰", "smileys", "aşık sevgi kalpler"], ["😍", "smileys", "aşık kalp gözler"],
    ["🤩", "smileys", "yıldız gözler hayran"], ["😘", "smileys", "öpücük"], ["😗", "smileys", "öpücük"],
    ["😚", "smileys", "öpücük"], ["😋", "smileys", "lezzetli"], ["😛", "smileys", "dil çıkarma"],
    ["😜", "smileys", "göz kırpma dil"], ["🤪", "smileys", "çılgın"], ["😝", "smileys", "dil sıkı göz"],
    ["🤑", "smileys", "para ağız"], ["🤗", "smileys", "sarılma"], ["🤭", "smileys", "el ağız kapatma"],
    ["🤫", "smileys", "sus"], ["🤔", "smileys", "düşünme"], ["🤨", "smileys", "kaş kaldırma şüphe"],
    ["😐", "smileys", "ifadesiz"], ["😑", "smileys", "ifadesiz yorgun"], ["😏", "smileys", "alaycı gülümseme"],
    ["😒", "smileys", "tatminsiz"], ["🙄", "smileys", "gözlerini devirme"], ["😬", "smileys", "gerginlik"],
    ["😌", "smileys", "rahatlamış"], ["😔", "smileys", "üzgün düşünceli"], ["😪", "smileys", "uykulu"],
    ["🤤", "smileys", "salyalı uyku"], ["😴", "smileys", "uyku"], ["😷", "smileys", "maske hasta"],
    ["🤒", "smileys", "termometre hasta"], ["🤕", "smileys", "sargılı yaralı"], ["🤢", "smileys", "mide bulantısı"],
    ["🤮", "smileys", "kusma"], ["🤧", "smileys", "hapşırma"], ["🥵", "smileys", "çok sıcak"],
    ["🥶", "smileys", "çok soğuk"], ["🥴", "smileys", "sersem"], ["😵", "smileys", "baş dönmesi"],
    ["🤯", "smileys", "patlayan kafa şaşkın"], ["🥳", "smileys", "parti kutlama"], ["😎", "smileys", "güneş gözlüğü havalı"],
    ["🤓", "smileys", "inek gözlük"], ["😕", "smileys", "kafası karışık"], ["🙁", "smileys", "hafif üzgün"],
    ["😮", "smileys", "şaşkın ağız açık"], ["😲", "smileys", "çok şaşkın"], ["😳", "smileys", "kızarmış utanmış"],
    ["🥺", "smileys", "yalvaran gözler"], ["😨", "smileys", "korkmuş"], ["😰", "smileys", "endişeli terli"],
    ["😢", "smileys", "ağlama"], ["😭", "smileys", "hüngür hüngür ağlama"], ["😱", "smileys", "çığlık korku"],
    ["😖", "smileys", "acı çekme"], ["😞", "smileys", "hayal kırıklığı"], ["😩", "smileys", "bitkin"],
    ["🥱", "smileys", "esneme"], ["😤", "smileys", "öfkeli buhar"], ["😡", "smileys", "çok kızgın"],
    ["😠", "smileys", "kızgın"], ["🤬", "smileys", "küfür"], ["😈", "smileys", "şeytan gülümseme"],
    ["👿", "smileys", "şeytan kızgın"], ["💀", "smileys", "kafatası ölüm"], ["💩", "smileys", "kaka"],
    ["🤡", "smileys", "palyaço"], ["👻", "smileys", "hayalet"], ["👽", "smileys", "uzaylı"],
    ["🤖", "smileys", "robot"], ["👍", "smileys", "beğeni tamam"], ["👎", "smileys", "beğenmedim"],
    ["👏", "smileys", "alkış"], ["🙌", "smileys", "kutlama eller"], ["🤝", "smileys", "el sıkışma anlaşma"],
    ["🙏", "smileys", "dua lütfen teşekkür"], ["💪", "smileys", "güç kas"], ["👀", "smileys", "bakma gözler"],
    ["💋", "smileys", "öpücük dudak"], ["💖", "smileys", "parlayan kalp"], ["💘", "smileys", "okla kalp"],
    ["💝", "smileys", "kalp kurdele hediye"],

    // Hayvanlar ve Doğa
    ["🐶", "animals", "köpek"], ["🐱", "animals", "kedi"], ["🐭", "animals", "fare"], ["🐹", "animals", "hamster"],
    ["🐰", "animals", "tavşan"], ["🦊", "animals", "tilki"], ["🐻", "animals", "ayı"], ["🐼", "animals", "panda"],
    ["🐨", "animals", "koala"], ["🐯", "animals", "kaplan"], ["🦁", "animals", "aslan"], ["🐮", "animals", "inek"],
    ["🐷", "animals", "domuz"], ["🐸", "animals", "kurbağa"], ["🐵", "animals", "maymun"], ["🙈", "animals", "görmüyorum maymun"],
    ["🙉", "animals", "duymuyorum maymun"], ["🙊", "animals", "konuşmuyorum maymun"], ["🐔", "animals", "tavuk"],
    ["🐧", "animals", "penguen"], ["🐦", "animals", "kuş"], ["🐤", "animals", "civciv"], ["🦆", "animals", "ördek"],
    ["🦅", "animals", "kartal"], ["🦉", "animals", "baykuş"], ["🦇", "animals", "yarasa"], ["🐺", "animals", "kurt"],
    ["🐗", "animals", "yaban domuzu"], ["🐴", "animals", "at"], ["🦄", "animals", "tek boynuzlu at"], ["🐝", "animals", "arı"],
    ["🐛", "animals", "tırtıl"], ["🦋", "animals", "kelebek"], ["🐌", "animals", "salyangoz"], ["🐞", "animals", "uğur böceği"],
    ["🐜", "animals", "karınca"], ["🕷️", "animals", "örümcek"], ["🦂", "animals", "akrep"], ["🐢", "animals", "kaplumbağa"],
    ["🐍", "animals", "yılan"], ["🦎", "animals", "kertenkele"], ["🐙", "animals", "ahtapot"], ["🦑", "animals", "kalamar"],
    ["🦀", "animals", "yengeç"], ["🐠", "animals", "balık"], ["🐬", "animals", "yunus"], ["🐳", "animals", "balina"],
    ["🦈", "animals", "köpekbalığı"], ["🐊", "animals", "timsah"], ["🦓", "animals", "zebra"], ["🦍", "animals", "goril"],
    ["🐘", "animals", "fil"], ["🦛", "animals", "su aygırı"], ["🦏", "animals", "gergedan"], ["🐪", "animals", "deve"],
    ["🦒", "animals", "zürafa"], ["🐄", "animals", "inek"], ["🐑", "animals", "koyun"], ["🐐", "animals", "keçi"],
    ["🦌", "animals", "geyik"], ["🐓", "animals", "horoz"], ["🦃", "animals", "hindi"], ["🦚", "animals", "tavus kuşu"],
    ["🦜", "animals", "papağan"], ["🦢", "animals", "kuğu"], ["🦔", "animals", "kirpi"], ["🌵", "animals", "kaktüs"],
    ["🌲", "animals", "ağaç"], ["🌳", "animals", "ağaç"], ["🌴", "animals", "palmiye"], ["🌸", "animals", "çiçek"],
    ["🌹", "animals", "gül"], ["🌻", "animals", "ayçiçeği"], ["🍀", "animals", "yonca şans"], ["🌙", "animals", "ay"],
    ["⭐", "animals", "yıldız"], ["☀️", "animals", "güneş"], ["⚡", "animals", "şimşek"], ["🔥", "animals", "ateş"],

    // Yiyecek ve İçecek
    ["🍏", "food", "yeşil elma"], ["🍎", "food", "kırmızı elma"], ["🍐", "food", "armut"], ["🍊", "food", "mandalina"],
    ["🍋", "food", "limon"], ["🍌", "food", "muz"], ["🍉", "food", "karpuz"], ["🍇", "food", "üzüm"],
    ["🍓", "food", "çilek"], ["🍈", "food", "kavun"], ["🍒", "food", "kiraz"], ["🍑", "food", "şeftali"],
    ["🥭", "food", "mango"], ["🍍", "food", "ananas"], ["🥥", "food", "hindistan cevizi"], ["🥝", "food", "kivi"],
    ["🍅", "food", "domates"], ["🍆", "food", "patlıcan"], ["🥑", "food", "avokado"], ["🥦", "food", "brokoli"],
    ["🥒", "food", "salatalık"], ["🌶️", "food", "acı biber"], ["🌽", "food", "mısır"], ["🥕", "food", "havuç"],
    ["🧄", "food", "sarımsak"], ["🧅", "food", "soğan"], ["🥔", "food", "patates"], ["🥐", "food", "kruvasan"],
    ["🍞", "food", "ekmek"], ["🥨", "food", "simit"], ["🧀", "food", "peynir"], ["🥚", "food", "yumurta"],
    ["🍳", "food", "kızarmış yumurta"], ["🥞", "food", "pankek"], ["🥓", "food", "pastırma"], ["🥩", "food", "et"],
    ["🍗", "food", "tavuk budu"], ["🌭", "food", "sosisli"], ["🍔", "food", "hamburger"], ["🍟", "food", "patates kızartması"],
    ["🍕", "food", "pizza"], ["🥪", "food", "sandviç"], ["🌮", "food", "taco"], ["🌯", "food", "burrito"],
    ["🥙", "food", "döner"], ["🥗", "food", "salata"], ["🍿", "food", "patlamış mısır"], ["🍱", "food", "bento kutusu"],
    ["🍚", "food", "pilav"], ["🍛", "food", "köri"], ["🍜", "food", "noodle çorbası"], ["🍝", "food", "makarna"],
    ["🍣", "food", "suşi"], ["🍤", "food", "karides"], ["🥟", "food", "mantı"], ["🍦", "food", "dondurma"],
    ["🍧", "food", "tıraşlanmış buz"], ["🍨", "food", "dondurma kase"], ["🍩", "food", "donut"], ["🍪", "food", "kurabiye"],
    ["🎂", "food", "doğum günü pastası"], ["🍰", "food", "pasta"], ["🧁", "food", "kek cupcake"], ["🍫", "food", "çikolata"],
    ["🍬", "food", "şeker"], ["🍭", "food", "lolipop"], ["🍯", "food", "bal"], ["🥛", "food", "süt"],
    ["☕", "food", "kahve"], ["🍵", "food", "çay"], ["🍾", "food", "şampanya"], ["🍷", "food", "şarap"],
    ["🍸", "food", "kokteyl"], ["🍹", "food", "tropik içecek"], ["🍺", "food", "bira"], ["🥂", "food", "kadeh kutlama"],

    // Aktiviteler
    ["⚽", "activities", "futbol"], ["🏀", "activities", "basketbol"], ["🏈", "activities", "amerikan futbolu"],
    ["⚾", "activities", "beyzbol"], ["🎾", "activities", "tenis"], ["🏐", "activities", "voleybol"],
    ["🏉", "activities", "ragbi"], ["🎱", "activities", "bilardo"], ["🏓", "activities", "masa tenisi"],
    ["🏸", "activities", "badminton"], ["🥅", "activities", "kale"], ["🏒", "activities", "hokey"],
    ["🏑", "activities", "çim hokeyi"], ["🥍", "activities", "lakros"], ["🏏", "activities", "kriket"],
    ["🥊", "activities", "boks"], ["🥋", "activities", "dövüş sanatları"], ["🎽", "activities", "koşu forması"],
    ["🛹", "activities", "kaykay"], ["🛼", "activities", "paten"], ["🎯", "activities", "hedef dart"],
    ["🎣", "activities", "balık tutma"], ["🥏", "activities", "frizbi"], ["🎮", "activities", "oyun kolu"],
    ["🕹️", "activities", "joystick oyun"], ["🎲", "activities", "zar"], ["♟️", "activities", "satranç"],
    ["🎳", "activities", "bowling"], ["🎨", "activities", "sanat resim"], ["🎬", "activities", "film klaket"],
    ["🎤", "activities", "mikrofon"], ["🎧", "activities", "kulaklık"], ["🎸", "activities", "gitar"],
    ["🥁", "activities", "davul"], ["🎹", "activities", "piyano"], ["🎺", "activities", "trompet"],
    ["🎻", "activities", "keman"], ["🎉", "activities", "kutlama parti"], ["🎊", "activities", "konfeti"],
    ["🏆", "activities", "kupa"], ["🥇", "activities", "altın madalya"], ["🥈", "activities", "gümüş madalya"],
    ["🥉", "activities", "bronz madalya"], ["🏅", "activities", "madalya"],

    // Seyahat ve Yerler
    ["🚗", "travel", "araba"], ["🚕", "travel", "taksi"], ["🚙", "travel", "suv"], ["🚌", "travel", "otobüs"],
    ["🚎", "travel", "troleybüs"], ["🏎️", "travel", "yarış arabası"], ["🚓", "travel", "polis arabası"],
    ["🚑", "travel", "ambulans"], ["🚒", "travel", "itfaiye"], ["🚐", "travel", "minibüs"], ["🛻", "travel", "kamyonet"],
    ["🚚", "travel", "kamyon"], ["🚛", "travel", "tır"], ["🚜", "travel", "traktör"], ["🏍️", "travel", "motosiklet"],
    ["🛵", "travel", "scooter"], ["🚲", "travel", "bisiklet"], ["🛴", "travel", "scooter"], ["🚨", "travel", "polis ışığı"],
    ["🚔", "travel", "polis"], ["🚍", "travel", "otobüs önden"], ["🚂", "travel", "tren buharlı"],
    ["🚆", "travel", "tren"], ["🚇", "travel", "metro"], ["🚊", "travel", "tramvay"], ["✈️", "travel", "uçak"],
    ["🛫", "travel", "uçak kalkış"], ["🛬", "travel", "uçak iniş"], ["🚀", "travel", "roket uzay"],
    ["🛸", "travel", "ufo"], ["🚁", "travel", "helikopter"], ["⛵", "travel", "yelkenli"], ["🚤", "travel", "motorbot"],
    ["🛳️", "travel", "gemi"], ["⛴️", "travel", "feribot"], ["🚢", "travel", "gemi büyük"], ["⚓", "travel", "çapa"],
    ["🗼", "travel", "kule"], ["🗽", "travel", "özgürlük anıtı"], ["🗿", "travel", "moai heykel"],
    ["🏰", "travel", "kale"], ["🏯", "travel", "japon kalesi"], ["🎡", "travel", "dönme dolap"],
    ["🎢", "travel", "roller coaster"], ["🏖️", "travel", "plaj"], ["🏝️", "travel", "ada"], ["⛰️", "travel", "dağ"],
    ["🏔️", "travel", "karlı dağ"], ["🌋", "travel", "volkan"], ["🏕️", "travel", "kamp"], ["🏠", "travel", "ev"],
    ["🏡", "travel", "bahçeli ev"], ["🏢", "travel", "ofis binası"], ["🕌", "travel", "cami"], ["⛪", "travel", "kilise"],
    ["🌉", "travel", "köprü gece"], ["🌆", "travel", "şehir gün batımı"], ["🎆", "travel", "havai fişek"],

    // Nesneler
    ["💡", "objects", "ampul fikir"], ["🔦", "objects", "el feneri"], ["🕯️", "objects", "mum"], ["📱", "objects", "telefon"],
    ["💻", "objects", "laptop bilgisayar"], ["⌨️", "objects", "klavye"], ["🖥️", "objects", "masaüstü bilgisayar"],
    ["🖱️", "objects", "fare mouse"], ["🖨️", "objects", "yazıcı"], ["📷", "objects", "kamera fotoğraf"],
    ["📹", "objects", "video kamera"], ["📺", "objects", "televizyon"], ["📻", "objects", "radyo"], ["☎️", "objects", "telefon"],
    ["⏰", "objects", "alarm saat"], ["⌚", "objects", "kol saati"], ["⏳", "objects", "kum saati"], ["🔋", "objects", "pil"],
    ["🔌", "objects", "fiş priz"], ["💰", "objects", "para çuvalı"], ["💵", "objects", "para dolar"], ["💳", "objects", "kredi kartı"],
    ["💎", "objects", "elmas"], ["🔧", "objects", "somun anahtarı"], ["🔨", "objects", "çekiç"], ["⚙️", "objects", "dişli ayar"],
    ["🔒", "objects", "kilit kapalı"], ["🔓", "objects", "kilit açık"], ["🔑", "objects", "anahtar"], ["🗝️", "objects", "eski anahtar"],
    ["🔍", "objects", "büyüteç arama"], ["📚", "objects", "kitaplar"], ["📖", "objects", "açık kitap"], ["✏️", "objects", "kalem"],
    ["🖊️", "objects", "tükenmez kalem"], ["📝", "objects", "not defteri"], ["📌", "objects", "raptiye pin"], ["📎", "objects", "ataş"],
    ["✂️", "objects", "makas"], ["📦", "objects", "kutu paket"], ["🎁", "objects", "hediye"], ["🎈", "objects", "balon"],
    ["🔔", "objects", "zil"], ["📢", "objects", "megafon"], ["🎁", "objects", "hediye kutusu"], ["🧸", "objects", "oyuncak ayı"],
    ["🕶️", "objects", "güneş gözlüğü"], ["👑", "objects", "taç"], ["💄", "objects", "ruj makyaj"], ["💊", "objects", "hap ilaç"],
    ["🩹", "objects", "yara bandı"], ["🧴", "objects", "şişe losyon"], ["🪑", "objects", "sandalye"], ["🛋️", "objects", "koltuk"],
    ["🛏️", "objects", "yatak"],

    // Semboller
    ["❤️", "symbols", "kalp kırmızı sevgi"], ["🧡", "symbols", "turuncu kalp"], ["💛", "symbols", "sarı kalp"],
    ["💚", "symbols", "yeşil kalp"], ["💙", "symbols", "mavi kalp"], ["💜", "symbols", "mor kalp"],
    ["🖤", "symbols", "siyah kalp"], ["🤍", "symbols", "beyaz kalp"], ["🤎", "symbols", "kahverengi kalp"],
    ["💔", "symbols", "kırık kalp"], ["❣️", "symbols", "kalp ünlem"], ["💯", "symbols", "yüz puan mükemmel"],
    ["✅", "symbols", "onay doğru tamam"], ["❌", "symbols", "çarpı hatalı"], ["⭕", "symbols", "daire boş"],
    ["❗", "symbols", "ünlem"], ["❓", "symbols", "soru işareti"], ["‼️", "symbols", "çift ünlem"],
    ["⁉️", "symbols", "ünlem soru"], ["💤", "symbols", "uyku zzz"], ["💢", "symbols", "öfke sembolü"],
    ["💥", "symbols", "patlama"], ["💦", "symbols", "ter su damlası"], ["💨", "symbols", "hız rüzgar"],
    ["🕐", "symbols", "saat"], ["♻️", "symbols", "geri dönüşüm"], ["⚠️", "symbols", "uyarı dikkat"],
    ["🚫", "symbols", "yasak"], ["🔞", "symbols", "18 yaş sınırı"], ["📵", "symbols", "telefon yasak"],
    ["♠️", "symbols", "maça iskambil"], ["♥️", "symbols", "kupa iskambil"], ["♦️", "symbols", "karo iskambil"],
    ["♣️", "symbols", "sinek iskambil"], ["🔀", "symbols", "karıştır"], ["🔁", "symbols", "tekrar"],
    ["▶️", "symbols", "oynat"], ["⏸️", "symbols", "duraklat"], ["⏹️", "symbols", "durdur"], ["🔊", "symbols", "ses açık"],
    ["🔇", "symbols", "ses kapalı"], ["🆗", "symbols", "tamam"], ["🆕", "symbols", "yeni"], ["🔝", "symbols", "en üst"],
    ["💠", "symbols", "elmas şekil"], ["🔰", "symbols", "acemi rozet"],

    // Bayraklar
    ["🏳️", "flags", "beyaz bayrak"], ["🏴", "flags", "siyah bayrak"], ["🏁", "flags", "damalı bayrak yarış"],
    ["🚩", "flags", "kırmızı bayrak"], ["🏳️‍🌈", "flags", "gökkuşağı bayrak"], ["🇹🇷", "flags", "türkiye bayrağı"],
    ["🇺🇸", "flags", "amerika bayrağı"], ["🇬🇧", "flags", "ingiltere bayrağı"], ["🇩🇪", "flags", "almanya bayrağı"],
    ["🇫🇷", "flags", "fransa bayrağı"], ["🇮🇹", "flags", "italya bayrağı"], ["🇪🇸", "flags", "ispanya bayrağı"],
    ["🇯🇵", "flags", "japonya bayrağı"], ["🇰🇷", "flags", "güney kore bayrağı"], ["🇨🇳", "flags", "çin bayrağı"],
    ["🇧🇷", "flags", "brezilya bayrağı"], ["🇷🇺", "flags", "rusya bayrağı"], ["🇨🇦", "flags", "kanada bayrağı"],
];

const EMOJI_CATEGORY_LABELS = {
    smileys: "Yüzler ve İnsanlar",
    animals: "Hayvanlar ve Doğa",
    food: "Yiyecek ve İçecek",
    activities: "Aktiviteler",
    travel: "Seyahat ve Yerler",
    objects: "Nesneler",
    symbols: "Semboller",
    flags: "Bayraklar"
};

const EMOJI_RECENTS_KEY = "hbEmojiRecents";
const EMOJI_RECENTS_MAX = 24;

// EMOJİ SEÇİCİ: sadece seçilen emojiyi mevcut #hp-msg-input'a ekliyor.
// Gönderme, mevcut btnSend/"Enter" akışıyla (connection.invoke("SendChatMessage", ...))
// AYNEN devam ediyor — emoji zaten sıradan bir Unicode karakter olduğu için
// SignalR/backend tarafında hiçbir değişikliğe gerek yok. "Sık Kullanılanlar"
// sekmesi, localStorage'da tutulan (bu tarayıcıya özel, sunucuyla ilgisi
// olmayan) bir son-kullanılanlar listesidir.
function setupEmojiPicker() {
    const emojiBtn = document.getElementById('hp-emoji-btn');
    const picker = document.getElementById('hp-emoji-picker');
    const msgInput = document.getElementById('hp-msg-input');
    const searchInput = document.getElementById('hp-emoji-search');
    const tabsContainer = document.getElementById('hp-emoji-tabs');
    const body = document.getElementById('hp-emoji-body');
    if (!emojiBtn || !picker || !msgInput || !searchInput || !tabsContainer || !body) return;

    let activeCategory = 'recent';

    function getRecents() {
        try { return JSON.parse(localStorage.getItem(EMOJI_RECENTS_KEY)) || []; } catch (e) { return []; }
    }
    function addRecent(emoji) {
        try {
            const recents = [emoji, ...getRecents().filter(e => e !== emoji)].slice(0, EMOJI_RECENTS_MAX);
            localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(recents));
        } catch (e) { /* yoksay */ }
    }

    function insertEmoji(emoji) {
        const start = msgInput.selectionStart ?? msgInput.value.length;
        const end = msgInput.selectionEnd ?? msgInput.value.length;
        msgInput.value = msgInput.value.slice(0, start) + emoji + msgInput.value.slice(end);
        const cursor = start + emoji.length;
        msgInput.focus();
        msgInput.setSelectionRange(cursor, cursor);
        addRecent(emoji);
    }

    function renderGrid(emojiList, sectionTitle, emptyText) {
        body.innerHTML = '';
        if (sectionTitle) {
            const heading = document.createElement('div');
            heading.className = 'hp-emoji-section-title';
            heading.textContent = sectionTitle;
            body.appendChild(heading);
        }
        if (!emojiList.length && emptyText) {
            const empty = document.createElement('div');
            empty.className = 'hp-emoji-empty';
            empty.textContent = emptyText;
            body.appendChild(empty);
            return;
        }
        const grid = document.createElement('div');
        grid.className = 'hp-emoji-grid';
        emojiList.forEach(emoji => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'hp-emoji-option';
            btn.textContent = emoji;
            btn.addEventListener('click', () => insertEmoji(emoji));
            grid.appendChild(btn);
        });
        body.appendChild(grid);
    }

    function renderCategory(category) {
        activeCategory = category;
        Array.from(tabsContainer.children).forEach(tab => {
            tab.classList.toggle('active', tab.dataset.category === category);
        });
        if (category === 'recent') {
            renderGrid(getRecents(), "Sık Kullanılanlar", "Henüz emoji kullanmadınız.");
        } else {
            const list = EMOJI_DATA.filter(item => item[1] === category).map(item => item[0]);
            renderGrid(list, EMOJI_CATEGORY_LABELS[category]);
        }
    }

    function renderSearch(query) {
        const q = query.trim().toLowerCase();
        const results = EMOJI_DATA.filter(item => item[2].includes(q)).map(item => item[0]);
        renderGrid(results, null, "Sonuç bulunamadı.");
    }

    emojiBtn.addEventListener('click', () => {
        picker.hidden = !picker.hidden;
        if (!picker.hidden) {
            searchInput.value = '';
            renderCategory(activeCategory === 'recent' ? 'recent' : activeCategory);
        }
    });

    tabsContainer.querySelectorAll('.hp-emoji-tab').forEach(tab => {
        tab.addEventListener('click', () => renderCategory(tab.dataset.category));
    });

    searchInput.addEventListener('input', () => {
        const q = searchInput.value;
        if (q.trim() === '') {
            renderCategory(activeCategory);
        } else {
            renderSearch(q);
        }
    });

    // Emoji seçici dışına tıklanınca kapansın.
    document.addEventListener('mousedown', (e) => {
        if (picker.hidden || picker.contains(e.target) || e.target === emojiBtn) return;
        picker.hidden = true;
    });

    renderCategory('recent');
}

// KİŞİ LİSTESİ POPOVER'I: hp-user-count'a ("👥 N") tıklanınca odadaki
// kullanıcıların adlarını (roomUsers, ReceiveUserList ile doluyor) küçük bir
// kart içinde gösterir. Liste her ReceiveUserList geldiğinde güncellenir; bu
// yüzden popover açıkken biri katılır/ayrılırsa da liste anlık tazelenir.
function renderUserList() {
    const list = document.getElementById('hp-user-list');
    if (!list) return;
    list.innerHTML = '';
    // roomUsers: [{ userId, displayName }, ...] — "bu ben miyim" karşılaştırması
    roomUsers.forEach(({ userId, displayName }) => {
        const li = document.createElement('li');
        const isSelf = userId === currentUserId;
        li.textContent = isSelf ? `${displayName} (sen)` : displayName;
        if (isSelf) li.classList.add('hp-user-list-self');
        list.appendChild(li);
    });
}

function setupUserListPopover() {
    const userCountBtn = document.getElementById('hp-user-count');
    const popover = document.getElementById('hp-user-list-popover');
    if (!userCountBtn || !popover) return;

    userCountBtn.addEventListener('click', () => {
        popover.hidden = !popover.hidden;
        if (!popover.hidden) renderUserList();
    });

    // Popover dışına tıklanınca kapansın (bkz. emoji seçicideki aynı desen).
    document.addEventListener('mousedown', (e) => {
        if (popover.hidden || popover.contains(e.target) || e.target === userCountBtn) return;
        popover.hidden = true;
    });
}

// AYARLAR PANELİ: sadece bu panelin içindeki ayarlari yönetir. Ayarlar paneli açılıp kapanırken sohbet/login
// alanının GERÇEK bağlantı durumuna göre geri gösterilmesi için mevcut
// showConnectedUI() fonksiyonu yeniden kullanılıyor — kopyalanmıyor.
function openSettingsPanel() {
    const loginArea = document.getElementById('hp-login-area');
    const chatArea = document.getElementById('hp-chat-area');
    const settingsPanel = document.getElementById('hp-settings-panel');
    if (!settingsPanel) return;
    if (loginArea) loginArea.style.display = 'none';
    if (chatArea) chatArea.style.display = 'none';
    settingsPanel.hidden = false;
}

async function closeSettingsPanel() {
    const settingsPanel = document.getElementById('hp-settings-panel');
    if (settingsPanel) settingsPanel.hidden = true;

    if (connection?.state === signalR.HubConnectionState.Connected) {
        showConnectedUI();
        return;
    }

    // Bağlı değilsek login/oda ekranından hangisinin gösterileceği artık
    // GERÇEK auth durumuna bağlı (bkz. showAuthArea/showRoomArea) — ör. Çıkış
    // Yap az önce token'ı temizlediyse burada login formuna düşülmeli.
    const auth = await hbGetStoredAuth();
    if (hbIsAuthValid(auth)) {
        showRoomArea(auth.username);
    } else {
        showAuthArea();
    }
}

// "KeyV" -> "V", "Space" -> "Boşluk", "Digit1" -> "1" gibi okunabilir bir
// etiket üretir; tanımadığı kodları (ör. ControlLeft) olduğu gibi gösterir.
function describeKeyCode(code) {
    if (!code) return "?";
    if (code === "Space") return "Boşluk";
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
}

function setupSettingsUI() {
    const settingsBtn = document.getElementById('hp-settings-btn');
    const closeBtn = document.getElementById('hp-settings-close-btn');
    const modeButtons = Array.from(document.querySelectorAll('#hp-voice-mode-group .hp-segmented-option'));
    const keyCaptureBtn = document.getElementById('hp-ptt-key-capture-btn');
    const keyLabel = document.getElementById('hp-ptt-key-label');
    const sizeButtons = Array.from(document.querySelectorAll('#hp-panel-size-group .hp-segmented-option'));
    const soundToggleBtn = document.getElementById('hp-sound-toggle-btn');
    const themeButtons = Array.from(document.querySelectorAll('#hp-theme-group .hp-segmented-option'));
    const fontSizeButtons = Array.from(document.querySelectorAll('#hp-msg-font-size-group .hp-segmented-option'));
    const logoutBtn = document.getElementById('hp-logout-btn');
    const displayNameInput = document.getElementById('hp-display-name-input');
    const displayNameSaveBtn = document.getElementById('hp-display-name-save-btn');
    if (!settingsBtn || !closeBtn || !keyCaptureBtn || !keyLabel || !soundToggleBtn) return;

    settingsBtn.addEventListener('click', () => {
        openSettingsPanel();
        updateSettingsAccountSection();
    });
    closeBtn.addEventListener('click', closeSettingsPanel);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (displayNameSaveBtn) displayNameSaveBtn.addEventListener('click', handleSaveDisplayName);
    if (displayNameInput) {
        displayNameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSaveDisplayName(); });
    }

    function applyModeSelectionUI() {
        modeButtons.forEach(btn => btn.classList.toggle('selected', btn.dataset.mode === voiceMode));
        applyPttButtonVisibility();
    }

    function applyPanelSize() {
        const panel = document.getElementById('hb-party-panel');
        if (panel) {
            panel.classList.remove('hp-size-small', 'hp-size-large');
            if (panelSize === 'small' || panelSize === 'large') panel.classList.add(`hp-size-${panelSize}`);
        }
        sizeButtons.forEach(btn => btn.classList.toggle('selected', btn.dataset.size === panelSize));

        // YouTube'un player'ı kendi genişliğini panel DOM'a eklendiğinde/
        // pencere resize olduğunda hesaplıyor — panel boyutu burada salt CSS
        // sınıfıyla değiştiği için player bunu fark etmiyor ve video eski
        // genişlikte kalıp panelin altına/üstüne taşıyordu (tam ekrana girip
        // çıkınca YouTube'un kendi resize mantığı tetiklendiği için "kendiliğinden
        // düzeliyormuş" gibi görünüyordu). nudgePlayerResize aynı tetiklemeyi
        // programatik yapıyor.
        nudgePlayerResize();
    }

    function applyTheme() {
        const panel = document.getElementById('hb-party-panel');
        if (panel) panel.classList.toggle('hp-theme-light', theme === 'light');
        themeButtons.forEach(btn => btn.classList.toggle('selected', btn.dataset.theme === theme));
    }

    function applySoundToggleUI() {
        soundToggleBtn.querySelector('.hp-toggle-switch').classList.toggle('on', notificationSoundEnabled);
        soundToggleBtn.setAttribute('aria-pressed', String(notificationSoundEnabled));
    }

    function applyMessageFontSize() {
        const panel = document.getElementById('hb-party-panel');
        if (panel) panel.style.setProperty('--hp-msg-font-size', `${messageFontSize}px`);
        fontSizeButtons.forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.fontSize) === messageFontSize));
    }

    sizeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.size === panelSize) return;
            panelSize = btn.dataset.size;
            try { chrome.storage.local.set({ panelSize }); } catch (e) { /* yoksay */ }
            applyPanelSize();
        });
    });

    themeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.theme === theme) return;
            theme = btn.dataset.theme;
            try { chrome.storage.local.set({ theme }); } catch (e) { /* yoksay */ }
            applyTheme();
        });
    });

    fontSizeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const size = Number(btn.dataset.fontSize);
            if (size === messageFontSize) return;
            messageFontSize = size;
            try { chrome.storage.local.set({ messageFontSize }); } catch (e) { /* yoksay */ }
            applyMessageFontSize();
        });
    });

    soundToggleBtn.addEventListener('click', () => {
        notificationSoundEnabled = !notificationSoundEnabled;
        try { chrome.storage.local.set({ notificationSoundEnabled }); } catch (e) { /* yoksay */ }
        applySoundToggleUI();
    });

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mode === voiceMode) return;
            voiceMode = btn.dataset.mode;
            try { chrome.storage.local.set({ voiceMode }); } catch (e) { /* yoksay */ }
            applyModeSelectionUI();

            // Zaten aktif bir sesli sohbet varsa yeni moda göre mikrofonu ANINDA
            // ayarla. Mevcut VOICE_PTT_START/STOP mesajları dışında hiçbir şey
            // kullanılmıyor — voice-offscreen.js'teki mikrofon/gürültü kapısı
            // mekanizması aynen çalışmaya devam ediyor.
            const voiceToggleBtn = document.getElementById('hp-voice-toggle-btn');
            if (voiceToggleBtn?.dataset.inVoice === "true") {
                chrome.runtime.sendMessage({ target: "background", action: voiceMode === 'normal' ? "VOICE_PTT_START" : "VOICE_PTT_STOP" });
            }
        });
    });

    let capturingKey = false;
    keyCaptureBtn.addEventListener('click', () => {
        if (capturingKey) return;
        capturingKey = true;
        keyCaptureBtn.classList.add('listening');
        keyLabel.textContent = "Bir tuşa basın...";
    });

    document.addEventListener('keydown', (e) => {
        if (!capturingKey) return;
        e.preventDefault();
        pttKeyCode = e.code;
        try { chrome.storage.local.set({ pttKeyCode }); } catch (err) { /* yoksay */ }
        keyLabel.textContent = describeKeyCode(pttKeyCode);
        keyCaptureBtn.classList.remove('listening');
        capturingKey = false;
    });

    // Kullanıcı bir tuşa basmadan başka bir yere tıklarsa yakalamayı iptal et
    document.addEventListener('mousedown', (e) => {
        if (!capturingKey || keyCaptureBtn.contains(e.target)) return;
        capturingKey = false;
        keyCaptureBtn.classList.remove('listening');
        keyLabel.textContent = describeKeyCode(pttKeyCode);
    });

    // Kayıtlı ayarları yükle; hiç kayıt yoksa mevcut varsayılanlar (ptt/"V"/orta
    // boy panel/ses açık/koyu tema) zaten yukarıda tanımlı olduğu için mevcut
    // (eski) davranış değişmez.
    try {
        chrome.storage.local.get(['voiceMode', 'pttKeyCode', 'panelSize', 'notificationSoundEnabled', 'theme', 'messageFontSize'], (result) => {
            if (result?.voiceMode === 'normal' || result?.voiceMode === 'ptt') voiceMode = result.voiceMode;
            if (result?.pttKeyCode) pttKeyCode = result.pttKeyCode;
            if (result?.panelSize === 'small' || result?.panelSize === 'medium' || result?.panelSize === 'large') panelSize = result.panelSize;
            if (typeof result?.notificationSoundEnabled === 'boolean') notificationSoundEnabled = result.notificationSoundEnabled;
            if (result?.theme === 'light' || result?.theme === 'dark') theme = result.theme;
            if ([9, 11, 13, 15, 17].includes(result?.messageFontSize)) messageFontSize = result.messageFontSize;

            applyModeSelectionUI();
            keyLabel.textContent = describeKeyCode(pttKeyCode);
            applyPanelSize();
            applyTheme();
            applySoundToggleUI();
            applyMessageFontSize();
        });
    } catch (e) {
        applyModeSelectionUI();
        keyLabel.textContent = describeKeyCode(pttKeyCode);
        applyPanelSize();
        applyTheme();
        applySoundToggleUI();
        applyMessageFontSize();
    }
}

// SESLİ SOHBET UI: gerçek mikrofon/WebRTC işi background.js + voice-offscreen.js
// içinde yaşıyor (bkz. VOICE ORKESTRASYONU, background.js). Burada sadece ince
// kontrol mesajları gönderiliyor.
function setupVoiceUI() {
    const voiceToggleBtn = document.getElementById('hp-voice-toggle-btn');
    const pttBtn = document.getElementById('hp-ptt-btn');
    if (!voiceToggleBtn || !pttBtn) return;

    voiceToggleBtn.addEventListener('click', async () => {
        voiceToggleBtn.disabled = true;
        if (voiceToggleBtn.dataset.inVoice === "true") {
            await chrome.runtime.sendMessage({ target: "background", action: "VOICE_LEAVE" });
            setVoiceUIState(false);
        } else {
            voiceToggleBtn.textContent = "⏳";
            voiceToggleBtn.title = "Bağlanıyor...";
            const result = await chrome.runtime.sendMessage({ target: "background", action: "VOICE_JOIN", room: currentRoom, userId: currentUserId });
            if (!result?.success) console.error("HB WatchParty (voice): VOICE_JOIN başarısız", result);
            if (result?.success) {
                setVoiceUIState(true);
                // Normal Mod'da bas-konuş tuşuna gerek yok: mikrofon katılır
                // katılmaz sürekli "armed" kalsın (voice-offscreen.js'teki mevcut
                // gürültü kapısı zaten sadece gerçekten konuşulunca sesi geçiriyor).
                if (voiceMode === 'normal') {
                    chrome.runtime.sendMessage({ target: "background", action: "VOICE_PTT_START" });
                }
            } else if (result?.authRequired) {
                await hbClearAuth();
                showAuthArea(result?.error || "Oturumun sona erdi, tekrar giriş yap.");
                setVoiceUIState(false);
            } else {
                alert(result?.error || "Sesli sohbete katılınamadı.");
                setVoiceUIState(false);
            }
        }
        voiceToggleBtn.disabled = false;
    });

    // Bas-konuş: butona VEYA ayarlarda seçilen tuşa basılı tutulduğu sürece
    // mikrofon açık. İkisi bağımsız takip edilir (pttMouseActive/pttKeyActive)
    // ki biri bırakılınca diğeri hâlâ basılıysa mikrofon erken kapanmasın.
    // Bu blok sadece Bas-Konuş Modu'ndayken devreye girer: Normal Mod'da
    // pttBtn zaten gizli olduğu için aşağıdaki "sesli sohbette değilsek/
    // Bas-Konuş Modu'nda değilsek yoksay" kontrolü (pttBtn.style.display)
    // otomatik olarak iki durumu da kapsıyor, ekstra bir mod kontrolüne gerek yok.
    let pttMouseActive = false;
    let pttKeyActive = false;

    function updatePttState() {
        const active = pttMouseActive || pttKeyActive;
        pttBtn.classList.toggle('active', active);
        chrome.runtime.sendMessage({ target: "background", action: active ? "VOICE_PTT_START" : "VOICE_PTT_STOP" });
    }

    pttBtn.addEventListener('mousedown', () => { pttMouseActive = true; updatePttState(); });
    pttBtn.addEventListener('mouseup', () => { pttMouseActive = false; updatePttState(); });
    pttBtn.addEventListener('mouseleave', () => {
        if (pttMouseActive) { pttMouseActive = false; updatePttState(); }
    });

    // Sohbet/kullanıcı adı/oda kodu kutularına yazarken "V" harfi normal
    // şekilde yazılabilsin diye input/textarea'da focus varken kısayol yoksayılır.
    function isTypingInField(el) {
        if (!el) return false;
        return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    }

    // SADECE "yeni tuş belirle" butonuna basılıp gerçekten yeni bir tuş
    // bekleniyorken (bkz. setupSettingsUI'daki keyCaptureBtn 'listening' class'ı)
    // eski PTT tuşunun burada da tetiklenmesini engelliyoruz. 
    function isCapturingPttKey() {
        return document.getElementById('hp-ptt-key-capture-btn')?.classList.contains('listening') ?? false;
    }

    document.addEventListener('keydown', (e) => {
        if (e.code !== pttKeyCode || e.repeat || pttKeyActive) return;
        if (isTypingInField(e.target) || isCapturingPttKey()) return;
        if (pttBtn.style.display === 'none') return; // sesli sohbette değilsek/Bas-Konuş Modu'nda değilsek yoksay
        pttKeyActive = true;
        updatePttState();
    });

    document.addEventListener('keyup', (e) => {
        if (e.code !== pttKeyCode || !pttKeyActive) return;
        pttKeyActive = false;
        updatePttState();
    });

    // Sekme/tarayıcı odağını kaybedince (ör. alt-tab) tuş bırakma event'i hiç
    // gelmeyebilir; mikrofonun sonsuza dek açık takılı kalmaması için güvenlik.
    window.addEventListener('blur', () => {
        if (pttKeyActive) { pttKeyActive = false; updatePttState(); }
    });
}

function setVoiceUIState(inVoice) {
    const voiceToggleBtn = document.getElementById('hp-voice-toggle-btn');
    const pttBtn = document.getElementById('hp-ptt-btn');
    if (!voiceToggleBtn || !pttBtn) return;
    voiceToggleBtn.dataset.inVoice = inVoice ? "true" : "false";
    voiceToggleBtn.textContent = inVoice ? "🔇" : "🎤";
    voiceToggleBtn.title = inVoice ? "Sesli Sohbetten Ayrıl" : "Sesli Sohbete Katıl";
    voiceToggleBtn.setAttribute('aria-label', voiceToggleBtn.title);
    applyPttButtonVisibility();
}


// setupVoiceUI'daki mevcut "pttBtn.style.display === 'none' ise
// yoksay" kontrolü sayesinde bu tek fonksiyon hem "sesli sohbette değil" hem
// "Normal Mod'dayız" durumlarını aynı şekilde kapsıyor.
function applyPttButtonVisibility() {
    const voiceToggleBtn = document.getElementById('hp-voice-toggle-btn');
    const pttBtn = document.getElementById('hp-ptt-btn');
    if (!voiceToggleBtn || !pttBtn) return;
    const inVoice = voiceToggleBtn.dataset.inVoice === "true";
    pttBtn.style.display = (inVoice && voiceMode === 'ptt') ? 'block' : 'none';
}

function refreshVoiceUIFromBackground() {
    chrome.runtime.sendMessage({ target: "background", action: "VOICE_GET_STATUS" }, (result) => {
        setVoiceUIState(!!result?.inVoice);
    });
}

function appendMessage(text, type, senderName = "") {
    const msgDiv = document.getElementById('hp-messages');
    if (!msgDiv) return;
    const div = document.createElement('div');
    div.classList.add('hp-msg', type);

    if (type === 'system') {
        div.textContent = text;
    } else {
        div.innerHTML = `<div class="hp-sender">${senderName}</div><div>${text}</div>`;
    }

    // "X yazıyor..." baloncuğu (varsa) her zaman en altta kalmalı — yeni mesajı
    // onun ÖNÜNE ekliyoruz ki gösterge listenin en sonunda görünmeye devam etsin.
    const typingBubble = document.getElementById('hp-typing-indicator');
    if (typingBubble) {
        msgDiv.insertBefore(div, typingBubble);
    } else {
        msgDiv.appendChild(div);
    }
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

// "X yazıyor..." göstergesini ayrı bir alanda değil, mesaj listesinin İÇİNDE
// (en altta) bir baloncuk olarak gösterir — normal bir "other" mesaj
// baloncuğu gibi ama içinde zıplayan üç nokta animasyonuyla. Element her
// güncellemede en sona taşınıyor (appendChild zaten DOM'daki mevcut bir
// elementi taşır), kimse yazmıyorsa tamamen kaldırılıyor.
function renderTypingIndicator() {
    const msgDiv = document.getElementById('hp-messages');
    if (!msgDiv) return;
    // typingUsers artık userId -> { timeoutId, displayName } — göstergede
    // yazılan isimler value'lardaki displayName'den geliyor, key'den (userId) değil.
    const names = Array.from(typingUsers.values()).map(v => v.displayName);

    if (names.length === 0) {
        document.getElementById('hp-typing-indicator')?.remove();
        return;
    }

    let text;
    if (names.length === 1) text = `${names[0]} yazıyor`;
    else if (names.length === 2) text = `${names[0]} ve ${names[1]} yazıyor`;
    else text = `${names[0]}, ${names[1]} ve ${names.length - 2} kişi daha yazıyor`;

    let bubble = document.getElementById('hp-typing-indicator');
    if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = 'hp-typing-indicator';
        bubble.className = 'hp-msg other hp-typing-bubble';
    }
    bubble.innerHTML = `<span>${text}</span><span class="hp-typing-dots"><span></span><span></span><span></span></span>`;
    msgDiv.appendChild(bubble);
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

function registerTyping(userId, displayName) {
    const existing = typingUsers.get(userId);
    if (existing) clearTimeout(existing.timeoutId);
    const timeoutId = setTimeout(() => {
        typingUsers.delete(userId);
        renderTypingIndicator();
    }, TYPING_EXPIRE_MS);
    typingUsers.set(userId, { timeoutId, displayName });
    renderTypingIndicator();
}

// Mesajı gerçekten gönderdiğinde "yazıyor" göstergesinin doğal süresi (3sn)
// dolana kadar asılı kalmaması için hemen temizliyoruz.
function clearTyping(userId) {
    const existing = typingUsers.get(userId);
    if (!existing) return;
    clearTimeout(existing.timeoutId);
    typingUsers.delete(userId);
    renderTypingIndicator();
}

// Ayarlardan açılıp kapanabilen bildirim sesi (bkz. hp-sound-toggle-btn).
// Harici bir ses dosyasına gerek kalmasın diye Web Audio API ile kısa,
// iki notalı bir "ding" üretiliyor. AudioContext tek sefer oluşturulup
// yeniden kullanılıyor (her mesajda yenisini açmak yerine).
let notificationAudioContext = null;
function playNotificationSound() {
    if (!notificationSoundEnabled) return;
    try {
        if (!notificationAudioContext) notificationAudioContext = new AudioContext();
        if (notificationAudioContext.state === 'suspended') notificationAudioContext.resume();

        const ctx = notificationAudioContext;
        const now = ctx.currentTime;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        gain.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1175, now + 0.09);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.26);
    } catch (e) { /* yoksay — bildirim sesi kritik değil */ }
}

// 5. VİDEO EVENTLERİ
function setupVideoListeners() {
    const newVideoElement = document.querySelector('video');
    if (!newVideoElement) return;

    videoElement = newVideoElement;

    if (videoElement.dataset.partyListenerAttached === "true") return;
    videoElement.dataset.partyListenerAttached = "true";

    videoElement.addEventListener('play', () => {
        if (consumeSuppressedVideoEvent('play')) return;
        if (connection?.state === signalR.HubConnectionState.Connected) {
            connection.invoke("SendPlay", currentRoom, videoElement.currentTime);
        }
    });

    videoElement.addEventListener('pause', () => {
        if (consumeSuppressedVideoEvent('pause')) return;
        if (connection?.state === signalR.HubConnectionState.Connected) {
            connection.invoke("SendPause", currentRoom, videoElement.currentTime);
        }
    });

    videoElement.addEventListener('seeked', () => {
        if (consumeSuppressedVideoEvent('seeked')) return;
        if (connection?.state === signalR.HubConnectionState.Connected) {
            connection.invoke("SendSeek", currentRoom, videoElement.currentTime);
        }
    });
}

let lastVideoId = new URL(window.location.href).searchParams.get("v");

// YouTube'un kendi içindeki sayfa/video geçişlerini yakalama (kullanıcının
// bizzat başka bir videoya tıklamasıyla oluşan GERÇEK SPA navigasyonları).
// Bizim kendi tetiklediğimiz uzak video değişimi (changeVideoInPlace)
// YouTube'un router'ını hiç kullanmadığı (sadece page-bridge.js üzerinden
// #movie_player.loadVideoById çağırdığı) için bu event'i tetiklemez —
// dolayısıyla aşağıdaki blok sadece kullanıcının kendi elleriyle yaptığı
// navigasyonlarda çalışır. changeVideoInPlace yine de lastVideoId'yi güncel
// tutar ki kullanıcı GERÇEKTEN başka bir videoya geçtiğinde karşılaştırma
// doğru çalışsın.
document.addEventListener('yt-navigate-finish', () => {
    // Video id değişsin değişmesin HER navigasyonda çalışır: YouTube bu sırada
    // player'ın etrafındaki DOM'u yeniden çizip panelimizi silmiş olabilir.
    ensurePanelExists();

    const currentUrl = new URL(window.location.href);
    const currentVideoId = currentUrl.searchParams.get("v");

    if (currentVideoId && currentVideoId !== lastVideoId) {
        lastVideoId = currentVideoId;

        // Video elementi YouTube tarafından yeniden oluşturulmuş olabilir;
        // dinleyicileri yeni elemente bağla (dataset flag'i olmadığı için
        // otomatik olarak yeniden attach edilir).
        setupVideoListeners();

        // Kullanıcı bizzat (elle) video değiştirdiyse sunucuya bildir
        if (connection?.state === signalR.HubConnectionState.Connected && currentRoom) {
            connection.invoke("ChangeVideo", currentRoom, currentVideoId);
        }
    }
});
