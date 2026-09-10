// Bu script bir chrome.offscreen document içinde çalışır (bkz. background.js
// ensureOffscreenDocument). HERHANGİ bir YouTube sekmesine bağlı DEĞİLDİR —
// video değişimi yüzünden content.js'in yaşadığı sekme reload'ları bu
// dokümanı hiç etkilemez; mikrofon akışı ve WebRTC bağlantıları kesintisiz
// devam eder. background.js bu dokümana sadece kontrol mesajları
// (VOICE_JOIN/VOICE_LEAVE/VOICE_PTT_START/VOICE_PTT_STOP) iletir.

// BACKEND_BASE_URL, auth.js'ten geliyor (bu dosyadan önce voice-offscreen.html
// içinde yükleniyor) — hem watch-party hem voice hub aynı backend'i kullanıyor.
const voiceHubUrl = `${BACKEND_BASE_URL}/voicehub`;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// NOISE GATE AYARLARI: "V" basılıyken bile konuşma araları/oda gürültüsü
// karşı tarafa gitmesin diye ham mikrofon sinyali bir Web Audio zincirinden
// geçirilip GainNode ile kapatılıp açılıyor (bkz. buildAudioGraph). Bu sabitler
// mikrofona/ortama göre ince ayar gerektirebilir: eşik çok düşükse gürültü
// sızmaya devam eder, çok yüksekse konuşmanın kısık kısımları kesilebilir.
const NOISE_GATE_THRESHOLD = 0.02; // RMS eşiği (0-1)
const GATE_ATTACK_MS = 20;         // konuşma başlayınca ne kadar hızlı açılsın
const GATE_RELEASE_MS = 250;       // konuşma bitince kelime sonu kesilmesin diye gecikmeli kapansın
const GATE_CHECK_INTERVAL_MS = 30;

// WebRTC bağlantısı "disconnected"/"failed" olduğunda (ör. NAT eşlemesi
// düşmesi, kısa ağ kopması) hemen pes etmeyip ICE restart ile toparlanmayı
// dener. Her denemeden sonra hâlâ bozuksa ICE_RESTART_DELAY_MS bekleyip
// tekrar dener; ICE_RESTART_MAX_ATTEMPTS'e ulaşınca karşı tarafın gerçekten
// gitmiş olduğunu varsayıp peer'ı kapatır (gerçek ayrılışlarda zaten
// VoicePeerLeft ile temizleniyor, bu sadece "gerçekten kurtarılamayan" P2P
// bağlantılar için son çare).
const ICE_RESTART_DELAY_MS = 3000;
const ICE_RESTART_MAX_ATTEMPTS = 10;

let connection = null;
let currentRoom = null;
let currentUserId = null; // giriş yapılan hesabın userId'si — bkz. requestAuthFromBackground
// userId -> displayName — bu doküman hiçbir katılımcı listesi göstermiyor,
// sadece teşhis/log amaçlı tutuluyor (bkz. VoicePeerJoined). ReceiveVoiceSignal
// artık displayName taşımıyor (WebRTC sinyalleşmesi zaten userId ile çalışıyor).
const voicePeerDisplayNames = new Map();
let rawMicStream = null;   // getUserMedia'nın ham çıktısı (sadece leaveVoice'ta durdurmak için tutulur)
let localStream = null;    // WebRTC'ye eklenen, noise-gate'ten geçmiş İŞLENMİŞ stream

let audioContext = null;
let gateGainNode = null;
let analyserNode = null;
let gateMonitorTimer = null;
let pttArmed = false;   // "V" basılı mı
let gateOpen = false;   // kapı şu an açık mı (konuşma algılandı mı)

// PEER YÖNETİMİ ARTIK userId İLE ANAHTARLANIYOR, görünen ad (displayName) İLE
// DEĞİL — görünen ad benzersiz olmak zorunda değil (bkz. görev tanımı), aynı
// adlı iki kişi aynı odadaysa displayName ile anahtarlamak ses sinyalinin
// yanlış kişiye gitmesine yol açardı (tam olarak düzelttiğimiz hata).

// userId -> RTCPeerConnection
const peers = new Map();
// userId -> HTMLAudioElement (karşı tarafın sesini çalan gizli <audio>)
const audioElements = new Map();
// userId -> RTCIceCandidate[] (remote description henüz set edilmeden önce gelen adaylar)
const pendingIceCandidates = new Map();
// userId -> kaç kez ICE restart denendiği
const iceRestartAttempts = new Map();
// hangi userId'ler için şu an bir ICE restart döngüsü çalışıyor (aynı anda birden fazla döngü başlamasın diye)
const iceRestartInProgress = new Set();

function sendSignal(targetUserId, payload) {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    connection.invoke("SendVoiceSignal", currentRoom, targetUserId, JSON.stringify(payload))
        .catch(err => console.error("HB WatchParty (voice): sinyal gönderilemedi", err));
}

function getOrCreateAudioElement(userId) {
    let audio = audioElements.get(userId);
    if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        document.body.appendChild(audio);
        audioElements.set(userId, audio);
    }
    return audio;
}

function closePeer(userId) {
    const pc = peers.get(userId);
    if (pc) {
        pc.close();
        peers.delete(userId);
    }
    const audio = audioElements.get(userId);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioElements.delete(userId);
    }
    pendingIceCandidates.delete(userId);
    iceRestartAttempts.delete(userId);
    iceRestartInProgress.delete(userId);
}

// pc "disconnected"/"failed" durumuna düştüğünde çağrılır. Birkaç saniye
// bekleyip (çoğu zaman kendi kendine toparlanır) hâlâ bozuksa iceRestart:true
// ile yeni bir offer gönderir. Karşı taraftaki handleIncomingSignal offer
// handler'ı zaten pc varsa yeniden kullandığı için ekstra bir şey gerekmiyor.
function scheduleIceRestart(userId) {
    const attempts = iceRestartAttempts.get(userId) || 0;
    if (attempts >= ICE_RESTART_MAX_ATTEMPTS) {
        console.error(`HB WatchParty (voice): ${userId} ile bağlantı ${ICE_RESTART_MAX_ATTEMPTS} denemede kurulamadı, vazgeçiliyor`);
        closePeer(userId);
        return;
    }
    iceRestartAttempts.set(userId, attempts + 1);

    setTimeout(async () => {
        const pc = peers.get(userId);
        if (!pc) { iceRestartInProgress.delete(userId); return; }
        if (pc.connectionState === "connected" || pc.connectionState === "closed") {
            iceRestartInProgress.delete(userId);
            return;
        }
        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            sendSignal(userId, { type: "offer", data: offer });
        } catch (e) {
            console.error("HB WatchParty (voice): ICE restart teklifi oluşturulamadı", e);
        }
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            scheduleIceRestart(userId);
        } else {
            iceRestartInProgress.delete(userId);
        }
    }, ICE_RESTART_DELAY_MS);
}

function createPeerConnection(userId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(userId, { type: "ice-candidate", data: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        const audio = getOrCreateAudioElement(userId);
        audio.srcObject = event.streams[0];
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
            iceRestartAttempts.delete(userId);
            iceRestartInProgress.delete(userId);
        } else if (pc.connectionState === "closed") {
            closePeer(userId);
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            // Hemen kapatmak yerine önce ICE restart ile toparlanmayı dene —
            // ör. NAT eşlemesi düşmesi veya kısa bir ağ kopması genelde bununla
            // düzelir, karşı tarafın gerçekten ayrılıp ayrılmadığını beklemeye
            // gerek kalmaz.
            if (!iceRestartInProgress.has(userId)) {
                iceRestartInProgress.add(userId);
                scheduleIceRestart(userId);
            }
        }
    };

    peers.set(userId, pc);
    return pc;
}

async function flushPendingIceCandidates(userId) {
    const pc = peers.get(userId);
    const queued = pendingIceCandidates.get(userId);
    if (!pc || !queued) return;
    for (const candidate of queued) {
        try { await pc.addIceCandidate(candidate); } catch (e) { /* yoksay */ }
    }
    pendingIceCandidates.delete(userId);
}

async function initiateOfferTo(userId) {
    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(userId, { type: "offer", data: offer });
}

async function handleIncomingSignal(fromUserId, payload) {
    let pc = peers.get(fromUserId);

    if (payload.type === "offer") {
        if (!pc) pc = createPeerConnection(fromUserId);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        await flushPendingIceCandidates(fromUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromUserId, { type: "answer", data: answer });
    } else if (payload.type === "answer") {
        if (!pc) return; // biz offer göndermemişsek beklenmeyen bir answer, yoksay
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        await flushPendingIceCandidates(fromUserId);
    } else if (payload.type === "ice-candidate") {
        const candidate = new RTCIceCandidate(payload.data);
        if (pc && pc.remoteDescription) {
            try { await pc.addIceCandidate(candidate); } catch (e) { /* yoksay */ }
        } else {
            // Remote description henüz gelmediyse (offer/answer'dan önce ICE
            // adayı gelmiş olabilir) sıraya al, flushPendingIceCandidates ile
            // sonradan uygulanır.
            if (!pendingIceCandidates.has(fromUserId)) pendingIceCandidates.set(fromUserId, []);
            pendingIceCandidates.get(fromUserId).push(candidate);
        }
    }
}

// Ham mikrofon stream'ini işleyip WebRTC'ye eklenecek noise-gate'li stream'i
// üretir: mic -> highpass filtre (düşük frekans uğultusunu keser) -> analiz
// (seviye ölçümü) -> gain node ("kapı") -> çıktı stream'i.
function buildAudioGraph(micStream) {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(micStream);

    const highpassFilter = audioContext.createBiquadFilter();
    highpassFilter.type = "highpass";
    highpassFilter.frequency.value = 90;

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 512;

    gateGainNode = audioContext.createGain();
    gateGainNode.gain.value = 0; // başlangıçta kapalı

    const destination = audioContext.createMediaStreamDestination();

    source.connect(highpassFilter);
    highpassFilter.connect(analyserNode);
    analyserNode.connect(gateGainNode);
    gateGainNode.connect(destination);

    startGateMonitor();

    return destination.stream;
}

function applyGateGain(open) {
    gateOpen = open;
    const now = audioContext.currentTime;
    const rampSeconds = (open ? GATE_ATTACK_MS : GATE_RELEASE_MS) / 1000;
    gateGainNode.gain.cancelScheduledValues(now);
    gateGainNode.gain.setValueAtTime(gateGainNode.gain.value, now);
    gateGainNode.gain.linearRampToValueAtTime(open ? 1 : 0, now + rampSeconds);
}

function startGateMonitor() {
    const dataArray = new Uint8Array(analyserNode.fftSize);
    if (gateMonitorTimer) clearInterval(gateMonitorTimer);
    gateMonitorTimer = setInterval(() => {
        if (!pttArmed) {
            if (gateOpen) applyGateGain(false);
            return;
        }
        analyserNode.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const normalized = (dataArray[i] - 128) / 128;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const shouldBeOpen = rms > NOISE_GATE_THRESHOLD;
        if (shouldBeOpen !== gateOpen) applyGateGain(shouldBeOpen);
    }, GATE_CHECK_INTERVAL_MS);
}

function stopGateMonitor() {
    if (gateMonitorTimer) {
        clearInterval(gateMonitorTimer);
        gateMonitorTimer = null;
    }
}

// "V" basılı/bırakılı bilgisini işler. Ham mikrofon track'i HER ZAMAN etkin
// bırakılır (ses grafiğini beslemeye devam eder) — asıl açma/kapama
// startGateMonitor'daki RMS ölçümüyle GainNode üzerinden yapılır. Bu sayede
// hem V bırakılınca anında (ve tıklamasız/yumuşak bir geçişle) susturuluyor
// hem de V basılıyken konuşma araları/oda gürültüsü otomatik olarak kesiliyor.
function setMicEnabled(enabled) {
    pttArmed = enabled;
    if (!enabled && gateGainNode) {
        applyGateGain(false);
    }
}

// Bu offscreen document içinden chrome.storage.local'a DOĞRUDAN erişim
// güvenilmez çıktı (teşhis: typeof chrome.storage === "undefined" dönüyor —
// chrome.runtime mesajlaşması sorunsuz çalışırken chrome.storage bu ortamda
// bağlanmıyor, muhtemelen chrome.offscreen dokümanlarına özgü bir Chrome
// tuhaflığı). Bu yüzden token'ı HER ZAMAN background.js'ten (normal bir
// service worker — storage erişimi sorunsuz) istiyoruz; hem ilk katılımda
// hem SignalR'ın accessTokenFactory'yi her çağırışında (bkz. joinVoice altı).
function requestAuthFromBackground() {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ target: "background", action: "AUTH_GET_TOKEN" }, (response) => {
                resolve({ token: response?.token || null, userId: response?.userId || null });
            });
        } catch (e) {
            resolve({ token: null, userId: null });
        }
    });
}

function requestTokenFromBackground() {
    return requestAuthFromBackground().then(auth => auth.token);
}

async function joinVoice(room, userId) {
    if (currentRoom === room && currentUserId === userId && connection?.state === signalR.HubConnectionState.Connected) {
        return { success: true }; // zaten bu odada bağlıyız
    }

    // /voicehub artık [Authorize] — geçerli bir token yoksa mikrofon izni
    // istemeye bile gerek yok, negotiate zaten 401 ile reddedecek.
    const auth = await requestAuthFromBackground();
    if (!auth.token) {
        console.error("HB WatchParty (voice): VOICE_JOIN reddedildi — background.js'ten geçerli bir token alınamadı.");
        return { success: false, authRequired: true, error: "Oturumun sona ermiş. Sesli sohbete katılmak için tekrar giriş yap." };
    }

    if (connection) {
        await leaveVoice();
    }

    currentRoom = room;
    // İçeriye VOICE_JOIN mesajıyla gelen userId ile background.js'in kendi
    // storage'dan okuduğu userId TUTARLI olmalı (aynı hesap) — mesajdan geleni
    // değil, background.js'in az önce doğruladığı gerçek userId'yi kullanıyoruz.
    currentUserId = auth.userId || userId;

    try {
        rawMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        localStream = buildAudioGraph(rawMicStream);
    } catch (err) {
        console.error("HB WatchParty (voice): mikrofon erişimi reddedildi", err);
        currentRoom = null;
        currentUserId = null;

        // Offscreen document GÖRÜNMEZ olduğu için Chrome, mikrofon izin
        // balonunu bağlayacağı bir sekme/pencere bulamıyor ve getUserMedia
        // otomatik olarak NotAllowedError ile reddediliyor — izin daha önce
        // hiç verilmediyse bu HER ZAMAN olur. Çözüm: izni GÖRÜNÜR küçük bir
        // pencerede (mic-permission.html) bir kez istemek; izin verilince
        // aynı origin (chrome-extension://...) için kalıcı olarak hatırlanır
        // ve offscreen doküman içindeki sonraki getUserMedia çağrıları
        // sorunsuz çalışır. background.js bu bayrağı görünce izin penceresini
        // otomatik açıyor (bkz. background.js VOICE_JOIN handler'ı).
        const permissionNeeded = err.name === "NotAllowedError" || err.name === "SecurityError" || err.name === "PermissionDeniedError";
        return {
            success: false,
            permissionNeeded,
            error: permissionNeeded
                ? "Mikrofon izni gerekiyor. Açılan pencereden izin verip 'Sesli Sohbete Katıl'a tekrar tıklayın."
                : `Mikrofona erişilemedi: ${err.message}`
        };
    }

    // Bas-konuş (push-to-talk): odaya katılınca mikrofon varsayılan olarak
    // KAPALI, sadece VOICE_PTT_START geldiğinde açılıyor.
    setMicEnabled(false);

    // Önceden burada .build() öncesi hiçbir yeniden bağlanma ayarı yoktu: sinyal
    // kanalı (SignalR) koptuğunda (ör. sunucu/proxy idle timeout'u, kısa bir ağ
    // kopması) bağlantı sessizce ölüyor ve hiçbir şey onu toparlamaya
    // çalışmıyordu — kullanıcı sesli sohbetin "kendi kendine koptuğunu" bu
    // yüzden görüyordu. withAutomaticReconnect + onreconnected ile odaya
    // otomatik yeniden katılıyoruz.
    connection = new signalR.HubConnectionBuilder()
        .withUrl(voiceHubUrl, { accessTokenFactory: () => requestTokenFromBackground() })
        .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: (retryContext) => {
                if (retryContext.previousRetryCount === 0) return 0;
                if (retryContext.previousRetryCount === 1) return 2000;
                if (retryContext.previousRetryCount === 2) return 5000;
                return 10000; // sonrasında süresiz olarak 10sn'de bir denemeye devam et
            }
        })
        .build();

    // Bu callback'ler asenkron olarak çok sonra tetiklenebiliyor. Kullanıcı bu
    // sırada sesli sohbetten çıkıp başka bir odaya katılmışsa `connection`
    // değişkeni artık farklı (yeni) bir bağlantıyı gösteriyor olabilir — o
    // durumda burada geç gelen bir callback'in yeni oturumun durumunu ezmesini
    // önlemek için hep "hâlâ bu bağlantı mı aktif" kontrolü yapılıyor.
    const thisConnection = connection;

    connection.onreconnecting((err) => {
        console.warn("HB WatchParty (voice): sinyalleşme bağlantısı koptu, yeniden bağlanılıyor...", err);
    });

    connection.onreconnected(async () => {
        if (connection !== thisConnection) return;
        console.log("HB WatchParty (voice): sinyalleşme bağlantısı yeniden kuruldu, odaya tekrar katılınıyor");
        // Eski peer bağlantıları bu sırada bozulmuş/tutarsız olabilir; odaya
        // yeniden katılınca ReceiveVoiceRoster tekrar tetiklenip mevcut
        // kullanıcılarla temiz birer offer/answer akışıyla sıfırdan
        // bağlanacağız, o yüzden önce hepsini kapatıyoruz.
        for (const userId of Array.from(peers.keys())) {
            closePeer(userId);
        }
        try {
            await thisConnection.invoke("JoinVoiceRoom", currentRoom);
        } catch (e) {
            console.error("HB WatchParty (voice): yeniden katılma başarısız", e);
        }
    });

    connection.onclose((err) => {
        if (connection !== thisConnection) return;
        // withAutomaticReconnect politikamız asla "vazgeç" demediği için (bkz.
        // nextRetryDelayInMilliseconds) buraya normalde ancak connection.stop()
        // çağrıldığında (leaveVoice) düşülür. connection'ı temizleyip durumu
        // sıfırlıyoruz ki kullanıcı tekrar katılmayı denediğinde joinVoice
        // "zaten bağlıyız" sanmasın.
        console.error("HB WatchParty (voice): sinyalleşme bağlantısı kapandı", err);
        connection = null;
        currentRoom = null;
        currentUserId = null;
    });

    connection.on("ReceiveVoiceRoster", (roster) => {
        // Protokol: çakışan çift-offer olmasın diye odaya YENİ katılan taraf
        // her zaman mevcut peer'lara offer gönderir; mevcut peer'lar bekler.
        // roster: [{ userId, displayName }, ...] — displayName burada WebRTC
        // akışı için kullanılmıyor (bu doküman katılımcı listesi göstermiyor),
        // sadece log/teşhis amaçlı önbelleğe alınıyor.
        (Array.isArray(roster) ? roster : []).forEach(({ userId, displayName }) => {
            voicePeerDisplayNames.set(userId, displayName);
            if (userId !== currentUserId) initiateOfferTo(userId).catch(console.error);
        });
    });

    // Yeni bir katılımcı sesli sohbete katıldığında tetiklenir. Aktif bir
    // eylem gerekmiyor: protokol gereği offer'ı HER ZAMAN sonradan katılan
    // taraf gönderiyor (yukarıdaki ReceiveVoiceRoster), biz sadece gelen
    // offer'ı handleIncomingSignal'da fromUserId ile karşılıyoruz.
    connection.on("VoicePeerJoined", (userId, displayName) => {
        voicePeerDisplayNames.set(userId, displayName);
        console.log(`HB WatchParty (voice): ${displayName} sesli sohbete katıldı (userId=${userId})`);
    });

    // Biri sesli sohbetteyken görünen adını değiştirirse backend bunu canlı
    // yayınlıyor — WebRTC bağlantısını hiç etkilemiyor (zaten userId ile
    // çalışıyor), sadece log/teşhis önbelleğimizi güncel tutuyoruz.
    connection.on("VoicePeerDisplayNameChanged", (userId, newDisplayName) => {
        voicePeerDisplayNames.set(userId, newDisplayName);
    });

    connection.on("VoicePeerLeft", (userId) => {
        voicePeerDisplayNames.delete(userId);
        closePeer(userId);
    });

    connection.on("ReceiveVoiceSignal", (fromUserId, payloadJson) => {
        try {
            const payload = JSON.parse(payloadJson);
            handleIncomingSignal(fromUserId, payload).catch(console.error);
        } catch (e) {
            console.error("HB WatchParty (voice): geçersiz sinyal payload'ı", e);
        }
    });

    try {
        await connection.start();
        await connection.invoke("JoinVoiceRoom", currentRoom);
        return { success: true };
    } catch (err) {
        const detail = String(err?.message || err);
        console.error("HB WatchParty (voice): sinyalleşme bağlantısı kurulamadı", err);
        await leaveVoice();
        if (hbIsAuthError(err)) {
            return { success: false, authRequired: true, error: "Oturumun sona ermiş. Sesli sohbete katılmak için tekrar giriş yap.", detail };
        }
        return { success: false, error: "Sesli sohbet sunucusuna bağlanılamadı.", detail };
    }
}

async function leaveVoice() {
    if (connection) {
        try {
            if (connection.state === signalR.HubConnectionState.Connected && currentRoom) {
                await connection.invoke("LeaveVoiceRoom", currentRoom);
            }
        } catch (e) { /* yoksay */ }
        try { await connection.stop(); } catch (e) { /* yoksay */ }
        connection = null;
    }

    for (const userId of Array.from(peers.keys())) {
        closePeer(userId);
    }
    voicePeerDisplayNames.clear();

    stopGateMonitor();

    if (rawMicStream) {
        rawMicStream.getTracks().forEach(track => track.stop());
        rawMicStream = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (audioContext) {
        try { await audioContext.close(); } catch (e) { /* yoksay */ }
        audioContext = null;
    }
    gateGainNode = null;
    analyserNode = null;
    pttArmed = false;
    gateOpen = false;

    currentRoom = null;
    currentUserId = null;
}

// background.js'ten gelen kontrol mesajları. "target" alanı ile sadece bize
// yönelik mesajları işliyoruz (chrome.runtime.sendMessage extension içindeki
// TÜM sayfalara yayınlanır, bu doküman da dahil).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "voiceOffscreen") return false;

    if (message.action === "VOICE_JOIN") {
        joinVoice(message.room, message.userId).then(sendResponse);
        return true;
    }
    if (message.action === "VOICE_LEAVE") {
        leaveVoice().then(() => sendResponse({ success: true }));
        return true;
    }
    if (message.action === "VOICE_PTT_START") {
        setMicEnabled(true);
        sendResponse({ success: true });
        return false;
    }
    if (message.action === "VOICE_PTT_STOP") {
        setMicEnabled(false);
        sendResponse({ success: true });
        return false;
    }
    return false;
});
