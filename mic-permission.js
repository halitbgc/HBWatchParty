const statusEl = document.getElementById('status');
const btn = document.getElementById('grant-btn');

async function requestPermission() {
    statusEl.textContent = "İzin isteniyor...";
    btn.disabled = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Akışa ihtiyacımız yok, sadece izni tetiklemek/kalıcı hale getirmek içindi.
        stream.getTracks().forEach(t => t.stop());

        statusEl.textContent = "İzin verildi! Bu pencere kapanıyor, 'Sesli Sohbete Katıl'a tekrar tıklayabilirsiniz.";
        btn.style.display = 'none';

        setTimeout(() => window.close(), 1500);
    } catch (err) {
        statusEl.textContent = `İzin verilmedi: ${err.message}. Tarayıcı adres çubuğundaki kilit/simge menüsünden manuel olarak izin verip tekrar deneyin.`;
        btn.disabled = false;
    }
}

btn.addEventListener('click', requestPermission);
requestPermission(); // sayfa açılır açılmaz otomatik dene
