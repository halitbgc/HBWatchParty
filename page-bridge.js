// Bu script YouTube sayfasının KENDİ JS ortamında ("MAIN world") çalışır
// (bkz. manifest.json "world": "MAIN"). content.js ise Chrome extension'ların
// standart "isolated world"ünde çalışıyor — DOM'u sayfayla paylaşır ama
// YouTube'un kendi script'lerinin #movie_player'a eklediği GERÇEK Player API
// metodları (loadVideoById vb.) sadece bu MAIN world'den görünür/çağrılabilir.
// content.js bir CustomEvent dispatch ediyor, biz burada gerçek player'a
// erişip video değişikliğini ve sayfa/sekme başlığını uyguluyoruz.
const TITLE_POLL_INTERVAL_MS = 300;
const TITLE_POLL_MAX_ATTEMPTS = 15; // ~4.5 saniye

window.addEventListener('hb-watchparty-change-video', (event) => {
    const videoId = event.detail?.videoId;
    if (!videoId) return;

    const player = document.getElementById('movie_player');
    if (player && typeof player.loadVideoById === 'function') {
        player.loadVideoById(videoId);
    } else if (player && typeof player.cueVideoById === 'function') {
        player.cueVideoById(videoId);
        player.playVideo?.();
    } else {
        console.error('HB WatchParty: #movie_player / loadVideoById bulunamadı, video değiştirilemedi.');
        return;
    }

    patchTitleWhenReady(videoId, player, TITLE_POLL_MAX_ATTEMPTS);
});

// loadVideoById çağrıldığı anda player'ın metadata'sı (başlık) henüz yeni
// videoya güncellenmiş olmuyor — YouTube bunu asenkron yüklüyor. Hazır olana
// kadar kısa aralıklarla tekrar deniyoruz.
function patchTitleWhenReady(videoId, player, attemptsLeft) {
    let title = null;
    try { title = player.getVideoData?.()?.title || null; } catch (e) { /* yoksay */ }

    if (!title) {
        if (attemptsLeft > 0) setTimeout(() => patchTitleWhenReady(videoId, player, attemptsLeft - 1), TITLE_POLL_INTERVAL_MS);
        return;
    }

    // URL'i yeni videoya senkronluyoruz (adres çubuğu doğru kalsın, sayfa
    // yenilenirse doğru videoya dönülsün) — bu sadece history.pushState,
    // gerçek bir navigasyon/reload DEĞİL.
    try { history.pushState({}, '', `/watch?v=${videoId}`); } catch (e) { /* yoksay */ }

    document.title = `${title} - YouTube`;
    const titleEl = document.querySelector('#title h1 yt-formatted-string, ytd-watch-metadata #title yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string');
    if (titleEl) titleEl.textContent = title;
}
