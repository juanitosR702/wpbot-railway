import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import qrImg from "qrcode";
import { EventEmitter } from "events";
import { rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { inspect } from "util";

function clearSessionFolder(authPath) {
  if (!existsSync(authPath)) return;
  try {
    const files = readdirSync(authPath);
    for (const file of files) {
      try {
        rmSync(join(authPath, file), { recursive: true, force: true });
      } catch (e) {
        console.error(`[connection] No se pudo eliminar ${file}:`, e.message);
      }
    }
  } catch (err) {
    console.error(`[connection] Error al vaciar carpeta de credenciales:`, err.message);
  }
}

const PRESENCE_INTERVAL = 300000;

const SESSION_NOISE = [
  "Bad MAC", "No matching sessions", "Failed to decrypt", "Session error:",
  "Closing session", "Closing open session", "SessionEntry", "_chains", "registrationId",
  "currentRatchet", "pendingPreKey", "indexInfo",
  "ephemeralKeyPair", "remoteIdentityKey", "preKeyId",
  "privKey:", "pubKey:", "rootKey:", "signedKeyId:",
  "chainKey", "chainType", "messageKeys",
  "baseKey:", "baseKeyType", "lastRemoteEphemeralKey", "previousCounter",
  "SessionBuilder", "SessionCipher", "session_cipher",
  "closed:",
];

export function isSessionNoise(...args) {  return args.some((a) => {
    if (typeof a === "string") return SESSION_NOISE.some((p) => a.includes(p));
    if (a instanceof Error) return SESSION_NOISE.some((p) => p.includes("Session error:") || a.message?.includes(p));
    if (a && typeof a === "object") {
      try { return SESSION_NOISE.some((p) => inspect(a, { depth: 10 }).includes(p)); }
      catch { return false; }
    }
    return false;
  });
}

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
const _origDir = console.dir;
console.log = (...args) => { if (!isSessionNoise(...args)) _origLog(...args); };
console.error = (...args) => { if (!isSessionNoise(...args)) _origError(...args); };
console.warn = (...args) => { if (!isSessionNoise(...args)) _origWarn(...args); };
console.dir = (...args) => { if (!isSessionNoise(...args)) _origDir(...args); };

const silentLogger = {
  level: "silent",
  trace() {}, debug() {}, info() {}, warn() {},
  error(...args) { if (!isSessionNoise(...args)) _origError("[baileys]", ...args); },
  fatal(...args) { _origError("[baileys]", ...args); },
  child() { return this; },
};

export class Connection extends EventEmitter {
  constructor(authPath) {
    super();
    this.authPath = authPath;
    this.sock = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this._presenceTimer = null;
  }

  async connect() {
    this.reconnectAttempts++;
    console.log(`[connection] Intento #${this.reconnectAttempts} - Cargando sesión desde:`, this.authPath);

    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[connection] Usando versión WA: ${version.join(".")} (latest: ${isLatest})`);

    this.sock = makeWASocket({
      version,
      logger: silentLogger,
      browser: Browsers.ubuntu("Chrome"),
      auth: state,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 120000,
      keepAliveIntervalMs: 25000,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n[connection] 📱 ESCANEA EL QR CON WHATSAPP:");
        this.emit("qr", qr);
      }

      if (connection === "open") {
        console.log("[connection] ✅ Conectado a WhatsApp");
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startPresenceLoop();
        this.emit("ready", this.sock.user);
      }

      if (connection === "close") {
        this.connected = false;
        this._stopPresenceLoop();
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || statusCode || "Desconocido";
        console.log(`[connection] ❌ Desconectado. Razón: ${reason} (código: ${statusCode})`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
          console.log(`[connection] ${statusCode === DisconnectReason.forbidden ? "Número bloqueado" : "Sesión cerrada"}. Limpiando credenciales para mostrar QR nuevo...`);
          this.sock = null;
          clearSessionFolder(this.authPath);
          setTimeout(() => this.connect(), statusCode === DisconnectReason.forbidden ? 60000 : 1500);
        } else if (statusCode === DisconnectReason.restartRequired) {
          console.log(`[connection] Baileys requiere reinicio (515). Reconnectando en 10s...`);
          this.reconnectAttempts = 0;
          setTimeout(() => this.connect(), 10000);
        } else if (statusCode === 408) {
          const delay = Math.min(5000 * Math.min(this.reconnectAttempts, 3), 15000);
          console.log(`[connection] Timeout en init queries (408). Reconnectando en ${delay / 1000}s...`);
          setTimeout(() => this.connect(), delay);
        } else {
          const delay = Math.min(5000 * (this.reconnectAttempts > 5 ? 2 : 1), 30000);
          console.log(`[connection] Reconnectando en ${delay / 1000}s...`);
          setTimeout(() => this.connect(), delay);
        }
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        this.emit("message", msg);
      }
    });

    return this.sock;
  }

  _startPresenceLoop() {
    this._stopPresenceLoop();
    this._presenceTimer = setInterval(() => {
      if (this.sock?.sendPresenceUpdate) {
        this.sock.sendPresenceUpdate("available").catch(() => {});
      }
    }, PRESENCE_INTERVAL);
  }

  _stopPresenceLoop() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  async sendMessage(jid, content) {
    const msg = typeof content === "string" ? { text: content } : content;
    return this.sock.sendMessage(jid, msg);
  }

  async disconnect() {
    this._stopPresenceLoop();
    this.connected = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  isConnected() {
    return this.connected;
  }
}
