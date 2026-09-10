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
let currentUser = null;
let rawMicStream = null;   // getUserMedia'nın ham çıktısı (sadece leaveVoice'ta durdurmak için tutulur)
let localStream = null;    // WebRTC'ye eklenen, noise-gate'ten geçmiş İŞLENMİŞ stream

let audioContext = null;
let gateGainNode = null;
let analyserNode = null;
let gateMonitorTimer = null;
let pttArmed = false;   // "V" basılı mı
let gateOpen = false;   // kapı şu an açık mı (konuşma algılandı mı)

// username -> RTCPeerConnection
const peers = new Map();
// username -> HTMLAudioElement (karşı tarafın sesini çalan gizli <audio>)
const audioElements = new Map();
// username -> RTCIceCandidate[] (remote description henüz set edilmeden önce gelen adaylar)
const pendingIceCandidates = new Map();
// username -> kaç kez ICE restart denendiği
const iceRestartAttempts = new Map();
// hangi username'ler için şu an bir ICE restart döngüsü çalışıyor (aynı anda birden fazla döngü başlamasın diye)
const iceRestartInProgress = new Set();

function sendSignal(targetUsername, payload) {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    connection.invoke("SendVoiceSignal", currentRoom, targetUsername, JSON.stringify(payload))
        .catch(err => console.error("HB WatchParty (voice): sinyal gönderilemedi", err));
}

function getOrCreateAudioElement(username) {
    let audio = audioElements.get(username);
    if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        document.body.appendChild(audio);
        audioElements.set(username, audio);
    }
    return audio;
}

function closePeer(username) {
    const pc = peers.get(username);
    if (pc) {
        pc.close();
        peers.delete(username);
    }
    const audio = audioElements.get(username);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioElements.delete(username);
    }
    pendingIceCandidates.delete(username);
    iceRestartAttempts.delete(username);
    iceRestartInProgress.delete(username);
}

// pc "disconnected"/"failed" durumuna düştüğünde çağrılır. Birkaç saniye
// bekleyip (çoğu zaman kendi kendine toparlanır) hâlâ bozuksa iceRestart:true
// ile yeni bir offer gönderir. Karşı taraftaki handleIncomingSignal offer
// handler'ı zaten pc varsa yeniden kullandığı için ekstra bir şey gerekmiyor.
function scheduleIceRestart(username) {
    const attempts = iceRestartAttempts.get(username) || 0;
    if (attempts >= ICE_RESTART_MAX_ATTEMPTS) {
        console.error(`HB WatchParty (voice): ${username} ile bağlantı ${ICE_RESTART_MAX_ATTEMPTS} denemede kurulamadı, vazgeçiliyor`);
        closePeer(username);
        return;
    }
    iceRestartAttempts.set(username, attempts + 1);

    setTimeout(async () => {
        const pc = peers.get(username);
        if (!pc) { iceRestartInProgress.delete(username); return; }
        if (pc.connectionState === "connected" || pc.connectionState === "closed") {
            iceRestartInProgress.delete(username);
            return;
        }
        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            sendSignal(username, { type: "offer", data: offer });
        } catch (e) {
            console.error("HB WatchParty (voice): ICE restart teklifi oluşturulamadı", e);
        }
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            scheduleIceRestart(username);
        } else {
            iceRestartInProgress.delete(username);
        }
    }, ICE_RESTART_DELAY_MS);
}

function createPeerConnection(username) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(username, { type: "ice-candidate", data: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        const audio = getOrCreateAudioElement(username);
        audio.srcObject = event.streams[0];
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
            iceRestartAttempts.delete(username);
            iceRestartInProgress.delete(username);
        } else if (pc.connectionState === "closed") {
            closePeer(username);
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            // Hemen kapatmak yerine önce ICE restart ile toparlanmayı dene —
            // ör. NAT eşlemesi düşmesi veya kısa bir ağ kopması genelde bununla
            // düzelir, karşı tarafın gerçekten ayrılıp ayrılmadığını beklemeye
            // gerek kalmaz.
            if (!iceRestartInProgress.has(username)) {
                iceRestartInProgress.add(username);
                scheduleIceRestart(username);
            }
        }
    };

    peers.set(username, pc);
    return pc;
}

async function flushPendingIceCandidates(username) {
    const pc = peers.get(username);
    const queued = pendingIceCandidates.get(username);
    if (!pc || !queued) return;
    for (const candidate of queued) {
        try { await pc.addIceCandidate(candidate); } catch (e) { /* yoksay */ }
    }
    pendingIceCandidates.delete(username);
}

async function initiateOfferTo(username) {
    const pc = createPeerConnection(username);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(username, { type: "offer", data: offer });
}

async function handleIncomingSignal(fromUsername, payload) {
    let pc = peers.get(fromUsername);

    if (payload.type === "offer") {
        if (!pc) pc = createPeerConnection(fromUsername);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        await flushPendingIceCandidates(fromUsername);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromUsername, { type: "answer", data: answer });
    } else if (payload.type === "answer") {
        if (!pc) return; // biz offer göndermemişsek beklenmeyen bir answer, yoksay
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
        await flushPendingIceCandidates(fromUsername);
    } else if (payload.type === "ice-candidate") {
        const candidate = new RTCIceCandidate(payload.data);
        if (pc && pc.remoteDescription) {
            try { await pc.addIceCandidate(candidate); } catch (e) { /* yoksay */ }
        } else {
            // Remote description henüz gelmediyse (offer/answer'dan önce ICE
            // adayı gelmiş olabilir) sıraya al, flushPendingIceCandidates ile
            // sonradan uygulanır.
            if (!pendingIceCandidates.has(fromUsername)) pendingIceCandidates.set(fromUsername, []);
            pendingIceCandidates.get(fromUsername).push(candidate);
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
function requestTokenFromBackground() {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ target: "background", action: "AUTH_GET_TOKEN" }, (response) => {
                resolve(response?.token || null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

async function joinVoice(room, user) {
    if (currentRoom === room && currentUser === user && connection?.state === signalR.HubConnectionState.Connected) {
        return { success: true }; // zaten bu odada bağlıyız
    }

    // /voicehub artık [Authorize] — geçerli bir token yoksa mikrofon izni
    // istemeye bile gerek yok, negotiate zaten 401 ile reddedecek.
    const token = await requestTokenFromBackground();
    if (!token) {
        console.error("HB WatchParty (voice): VOICE_JOIN reddedildi — background.js'ten geçerli bir token alınamadı.");
        return { success: false, authRequired: true, error: "Oturumun sona ermiş. Sesli sohbete katılmak için tekrar giriş yap." };
    }

    if (connection) {
        await leaveVoice();
    }

    currentRoom = room;
    currentUser = user;

    try {
        rawMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        localStream = buildAudioGraph(rawMicStream);
    } catch (err) {
        console.error("HB WatchParty (voice): mikrofon erişimi reddedildi", err);
        currentRoom = null;
        currentUser = null;

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
        for (const username of Array.from(peers.keys())) {
            closePeer(username);
        }
        try {
            await thisConnection.invoke("JoinVoiceRoom", currentRoom, currentUser);
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
        currentUser = null;
    });

    connection.on("ReceiveVoiceRoster", (existingUsernames) => {
        // Protokol: çakışan çift-offer olmasın diye odaya YENİ katılan taraf
        // her zaman mevcut peer'lara offer gönderir; mevcut peer'lar bekler.
        existingUsernames.forEach(username => {
            if (username !== currentUser) initiateOfferTo(username).catch(console.error);
        });
    });

    connection.on("VoicePeerLeft", (username) => {
        closePeer(username);
    });

    connection.on("ReceiveVoiceSignal", (fromUsername, payloadJson) => {
        try {
            const payload = JSON.parse(payloadJson);
            handleIncomingSignal(fromUsername, payload).catch(console.error);
        } catch (e) {
            console.error("HB WatchParty (voice): geçersiz sinyal payload'ı", e);
        }
    });

    try {
        await connection.start();
        await connection.invoke("JoinVoiceRoom", currentRoom, currentUser);
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
            if (connection.state === signalR.HubConnectionState.Connected && currentRoom && currentUser) {
                await connection.invoke("LeaveVoiceRoom", currentRoom, currentUser);
            }
        } catch (e) { /* yoksay */ }
        try { await connection.stop(); } catch (e) { /* yoksay */ }
        connection = null;
    }

    for (const username of Array.from(peers.keys())) {
        closePeer(username);
    }

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
    currentUser = null;
}

// background.js'ten gelen kontrol mesajları. "target" alanı ile sadece bize
// yönelik mesajları işliyoruz (chrome.runtime.sendMessage extension içindeki
// TÜM sayfalara yayınlanır, bu doküman da dahil).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "voiceOffscreen") return false;

    if (message.action === "VOICE_JOIN") {
        joinVoice(message.room, message.user).then(sendResponse);
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
