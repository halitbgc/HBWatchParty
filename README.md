# HB Watch Party

YouTube videolarını arkadaşlarınla senkronize izlemeni sağlayan bir Chrome eklentisi (Manifest V3). Yazılı sohbet ve bas-konuş sesli sohbet içerir.

## Özellikler

- **Oda sistemi:** Oda oluştur ya da kodla mevcut bir odaya katıl
- **Senkron oynatma:** Oynat, duraklat, ileri/geri sarma ve video değiştirme tüm katılımcılara iletilir
- **Senkron kontrolü:** Oynatma süreleri karşılaştırılır, kayma olursa uyarı verilir
- **Sohbet:** Anlık mesajlaşma, "yazıyor..." göstergesi, katılımcı listesi
- **Sesli sohbet:** WebRTC tabanlı bas-konuş (varsayılan tuş `V`), gürültü kapısı (noise gate)
- **Hesap:** Kayıt ol / giriş yap (JWT). Sayfa yenilenince odaya otomatik tekrar bağlanır

## Kurulum

1. Depoyu klonla veya indir.
2. Chrome'da `chrome://extensions` adresini aç ve **Geliştirici modu**nu etkinleştir.
3. **Paketlenmemiş öğe yükle** butonuna tıklayıp proje klasörünü seç.
4. Bir YouTube videosu aç (`youtube.com/watch?...`) ve eklenti simgesine tıklayarak paneli aç.

> Paneli açtığında bir şey görünmüyorsa sayfayı yenile (F5).

## Kullanım

1. Panelden kayıt ol veya giriş yap.
2. **Oda Oluştur** ile yeni bir oda aç ya da arkadaşının verdiği kodla **Odaya Katıl**.
3. Videoyu oynat; diğer katılımcılar otomatik olarak senkronize olur.
4. Sesli sohbet için **Sesli Sohbete Katıl**'a tıkla, konuşurken `V` tuşuna basılı tut. İlk seferde mikrofon izni için ayrı bir pencere açılır.

## Proje Yapısı

| Dosya | Açıklama |
|---|---|
| `manifest.json` | Eklenti tanımı ve izinler |
| `content.js` / `content.css` | YouTube sayfasına eklenen panel, oda/sohbet mantığı, video senkronizasyonu |
| `page-bridge.js` | Sayfanın kendi ortamında (MAIN world) çalışır, YouTube Player API'sine erişir |
| `auth.js` | Ortak kimlik doğrulama yardımcıları (token saklama/doğrulama) |
| `background.js` | Service worker; panel açma ve sesli sohbet orkestrasyonu |
| `voice-offscreen.html/js` | Sekmeden bağımsız offscreen doküman; mikrofon ve WebRTC bağlantıları |
| `mic-permission.html/js` | Mikrofon izni isteme sayfası |
| `signalr.min.js` | SignalR istemci kütüphanesi |

## Backend

Eklenti `https://hbwatch.arztakvim.com.tr` adresindeki SignalR sunucusuyla çalışır:

- `/api/auth/login`, `/api/auth/register` — kimlik doğrulama
- `/api/rooms` — oda oluşturma / kontrol
- `/watchpartyhub` — oynatma senkronu ve sohbet
- `/voicehub` — sesli sohbet sinyalleşmesi

Farklı bir sunucu kullanmak için [auth.js](auth.js) içindeki `BACKEND_BASE_URL` değerini ve [manifest.json](manifest.json) içindeki `host_permissions` alanını güncelle.
