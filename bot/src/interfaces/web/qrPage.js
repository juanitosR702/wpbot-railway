/**
 * Visor HTML del QR de vinculación de WhatsApp.
 *
 * El QR no se genera aquí: llega como string desde Baileys
 * (`connection.update` → campo `qr`), `Connection` lo reemite como evento "qr"
 * y `bootstrap.js` lo guarda en memoria. Esta página solo lo muestra, lo
 * refresca cuando cambia y consulta `/qr/status` para reflejar el estado real.
 */
export function renderQrViewer({ token }) {
  const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="color-scheme" content="dark" />
<title>Vincular WhatsApp · Visor QR</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #07090c;
    --card: #0d1218;
    --card-2: #121a23;
    --line: rgba(255, 255, 255, 0.08);
    --text: #e9eef3;
    --muted: #8a99aa;
    --green: #25d366;
    --amber: #f3b544;
    --red: #f2685f;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 28px 18px;
    background:
      radial-gradient(900px 520px at 50% -12%, rgba(37, 211, 102, 0.10), transparent 62%),
      radial-gradient(720px 520px at 112% 112%, rgba(74, 132, 255, 0.07), transparent 62%),
      var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(100%, 440px);
    padding: 22px 22px 18px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 38%),
      var(--card);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .brand-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 4px rgba(37, 211, 102, 0.12);
    animation: breathe 2.8s ease-in-out infinite;
  }
  .brand .sep { opacity: 0.4; }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 11px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    letter-spacing: 0.03em;
    white-space: nowrap;
    transition: color 0.25s ease, border-color 0.25s ease, background 0.25s ease;
  }
  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .pill[data-state="waiting"] {
    color: var(--amber);
    border-color: rgba(243, 181, 68, 0.28);
    background: rgba(243, 181, 68, 0.08);
  }
  .pill[data-state="waiting"] .pill-dot { animation: breathe 1.6s ease-in-out infinite; }
  .pill[data-state="connected"] {
    color: var(--green);
    border-color: rgba(37, 211, 102, 0.3);
    background: rgba(37, 211, 102, 0.08);
  }
  .pill[data-state="offline"] {
    color: var(--red);
    border-color: rgba(242, 104, 95, 0.3);
    background: rgba(242, 104, 95, 0.08);
  }
  .eyebrow {
    margin: 22px 0 7px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 {
    margin: 0;
    font-size: clamp(23px, 6vw, 27px);
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .lede {
    margin: 10px 0 0;
    min-height: 42px;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--muted);
  }
  .qr-wrap {
    display: grid;
    place-items: center;
    margin: 14px 0 10px;
  }
  .qr-frame {
    position: relative;
    width: min(286px, 74vw);
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    padding: 11px;
    border-radius: 20px;
    background: #ffffff;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.45);
  }
  .qr-frame::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: 21px;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(243, 181, 68, 0.45), 0 0 34px rgba(243, 181, 68, 0.16);
    opacity: 0;
    transition: opacity 0.35s ease;
  }
  .qr-wrap[data-state="waiting"] .qr-frame::after { opacity: 1; }
  .qr-wrap[data-state="idle"] .qr-frame {
    border: 1px dashed rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.02);
    box-shadow: none;
  }
  .qr-wrap[data-state="idle"] .placeholder { color: #6c7a88; }
  .qr-wrap[data-state="connected"] .qr-frame {
    border: 1px solid rgba(37, 211, 102, 0.22);
    background: rgba(37, 211, 102, 0.05);
    box-shadow: none;
  }
  .qr-wrap[data-state="connected"] .qr-frame::after {
    opacity: 1;
    inset: 0;
    box-shadow: 0 0 0 1px rgba(37, 211, 102, 0.35), 0 0 34px rgba(37, 211, 102, 0.12);
  }
  .qr-wrap[data-state="connected"] .placeholder {
    color: #86e3ab;
    font-size: 12px;
  }
  .qr-wrap[data-state="connected"] .placeholder::before {
    content: "✓";
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border: 1px solid rgba(37, 211, 102, 0.35);
    border-radius: 50%;
    background: rgba(37, 211, 102, 0.10);
    color: var(--green);
    font-size: 20px;
  }
  .qr-frame img {
    width: 100%;
    height: 100%;
    border-radius: 9px;
    object-fit: contain;
    image-rendering: pixelated;
  }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: #5d6a78;
  }
  .placeholder[data-spinning="false"] .spinner { display: none; }
  .spinner {
    width: 22px;
    height: 22px;
    border: 2px solid rgba(11, 15, 20, 0.14);
    border-top-color: #0b0f14;
    border-radius: 50%;
    animation: spin 0.85s linear infinite;
  }
  .meta {
    margin: 0;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    color: #65737f;
  }
  .steps {
    display: grid;
    gap: 8px;
    margin: 16px 0 0;
    padding: 14px 0 0;
    border-top: 1px solid var(--line);
    list-style: none;
  }
  .steps li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12.5px;
    line-height: 1.45;
    color: #b3c0cd;
  }
  .steps strong {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--card-2);
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 500;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px 14px;
    margin-top: 18px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 9.5px;
    letter-spacing: 0.03em;
    color: #5b6875;
  }
  footer code { color: #7c8b99; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<main class="card">
  <header class="top">
    <span class="brand"><span class="brand-dot" aria-hidden="true"></span>wpbot <span class="sep">/</span> railway</span>
    <span class="pill" id="pill" data-state="loading" role="status" aria-live="polite">
      <span class="pill-dot" aria-hidden="true"></span>
      <span id="pillText">Conectando…</span>
    </span>
  </header>

  <p class="eyebrow" id="eyebrow">Código QR</p>
  <h1 id="title">Vincula este dispositivo</h1>
  <p class="lede" id="lede">Esperando a que el bot emita un código…</p>

  <div class="qr-wrap" id="qrWrap" data-state="loading">
    <div class="qr-frame">
      <img id="qrImg" alt="Código QR de WhatsApp" width="288" height="288" decoding="async" hidden />
      <div class="placeholder" id="placeholder" data-spinning="true">
        <div class="spinner" aria-hidden="true"></div>
        <span id="placeholderText">Buscando QR…</span>
      </div>
    </div>
  </div>

  <p class="meta" id="meta">Actualización automática cada 3 s</p>

  <ol class="steps" id="steps">
    <li><strong>1</strong><span>Abre WhatsApp en tu teléfono.</span></li>
    <li><strong>2</strong><span>Entra en Ajustes → Dispositivos vinculados.</span></li>
    <li><strong>3</strong><span>Toca «Vincular un dispositivo» y escanea el código.</span></li>
  </ol>

  <footer>
    <span>QR emitido por Baileys · <code>connection.update</code></span>
    <span>Acceso con token</span>
  </footer>
</main>

<noscript>
  <p style="text-align:center;color:#f2685f;font-family:monospace">Activa JavaScript para ver el QR actualizado.</p>
</noscript>

<script>
  (function () {
    var TOKEN = ${tokenJson};
    var query = "token=" + encodeURIComponent(TOKEN);

    var pill = document.getElementById("pill");
    var pillText = document.getElementById("pillText");
    var eyebrow = document.getElementById("eyebrow");
    var title = document.getElementById("title");
    var lede = document.getElementById("lede");
    var meta = document.getElementById("meta");
    var wrap = document.getElementById("qrWrap");
    var img = document.getElementById("qrImg");
    var placeholder = document.getElementById("placeholder");
    var placeholderText = document.getElementById("placeholderText");
    var steps = document.getElementById("steps");

    var shownStamp = -1;

    function setPill(state, label) {
      pill.dataset.state = state;
      pillText.textContent = label;
    }

    function showPlaceholder(text, spinning) {
      img.hidden = true;
      placeholder.hidden = false;
      placeholder.dataset.spinning = spinning ? "true" : "false";
      placeholderText.textContent = text;
    }

    function formatAge(seconds) {
      if (seconds == null) return "unos segundos";
      if (seconds < 60) return seconds + " s";
      return Math.floor(seconds / 60) + " min";
    }

    function render(data) {
      if (data.connected) {
        wrap.dataset.state = "connected";
        setPill("connected", "Conectado");
        eyebrow.textContent = "Sesión activa";
        title.textContent = "Dispositivo vinculado";
        lede.textContent = "Este dispositivo ya está vinculado. La sesión está activa.";
        meta.textContent = "No hace falta escanear nada";
        steps.hidden = true;
        shownStamp = -1;
        showPlaceholder("WhatsApp conectado", false);
        return;
      }

      if (data.active) {
        wrap.dataset.state = "waiting";
        setPill("waiting", "Esperando escaneo");
        eyebrow.textContent = "Código QR";
        title.textContent = "Vincula este dispositivo";
        lede.textContent = "Escanea el código desde WhatsApp. Cuando caduca, se renueva solo.";
        meta.textContent = "Recibido hace " + formatAge(data.qrAgeSeconds) + " · se renueva solo";
        steps.hidden = false;

        if (data.qrUpdatedAt !== shownStamp) {
          shownStamp = data.qrUpdatedAt;
          img.onload = function () {
            img.hidden = false;
            placeholder.hidden = true;
          };
          img.src = "/qr.png?" + query + "&v=" + encodeURIComponent(data.qrUpdatedAt);
        } else if (img.hidden) {
          img.hidden = false;
          placeholder.hidden = true;
        }
        return;
      }

      wrap.dataset.state = "idle";
      setPill("idle", "Sin QR activo");
      eyebrow.textContent = "Código QR";
      title.textContent = "Vincula este dispositivo";
      lede.textContent = "Todavía no hay un código disponible. Aparecerá aquí cuando el bot pida vincularse.";
      meta.textContent = "Comprobando cada 3 s";
      steps.hidden = false;
      shownStamp = -1;
      showPlaceholder("Esperando código…", false);
    }

    function poll() {
      fetch("/qr/status?" + query, { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(render)
        .catch(function () {
          setPill("offline", "Sin conexión");
          meta.textContent = "Reintentando…";
        });
    }

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) poll();
    });

    poll();
    setInterval(poll, 3000);
  })();
</script>
</body>
</html>`;
}
