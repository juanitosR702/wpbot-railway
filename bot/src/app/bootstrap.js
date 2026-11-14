import { Connection } from "../infrastructure/bot/connection.js";
import http from "http";
import crypto from "crypto";
import qrcode from "qrcode";
import { env } from "../shared/config/env.js";
import { Router } from "../interfaces/bot/router.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { existsSync, readFileSync } from "fs";
import { cleanJid } from "../shared/utils/jid.js";
import { scanAllGroups, handleGroupUpdate } from "../shared/utils/autoPromote.js";
import { closeDb, databaseHealth, getDb } from "../infrastructure/database/connection.js";
import { createOwnerRepository, initOwnerStorage } from "../infrastructure/users/ownerStorage.js";
import { createOwnerPolicy } from "../domain/users/ownerPolicy.js";
import { createCloudApiClient } from "../infrastructure/cloudapi/graphClient.js";
import { createCloudWebhookHandler, extractMediaId } from "../interfaces/webhook/cloudWebhook.js";
import { renderQrViewer } from "../interfaces/web/qrPage.js";
import { join } from "path";

import { antiNsfwPlugin } from "../interfaces/commands/antiNsfw/index.js";
import { AntiNsfwStore } from "../infrastructure/storage/antiNsfwStore.js";
import { aiPlugin } from "../interfaces/commands/ai/index.js";
import { casinoPlugin } from "../interfaces/commands/casino/index.js";
import { economyPlugin } from "../interfaces/commands/economy/index.js";
import { groupAdminPlugin, handleGroupParticipantsUpdate } from "../interfaces/commands/groupAdmin/index.js";
import { fichaPlugin } from "../interfaces/commands/ficha/index.js";
import { helpPlugin } from "../interfaces/commands/help/index.js";
import { levelsPlugin } from "../interfaces/commands/levels/index.js";
import { moderationPlugin } from "../interfaces/commands/moderation/index.js";
import { ownerPlugin } from "../interfaces/commands/owner/index.js";
import { pollsPlugin } from "../interfaces/commands/polls/index.js";
import { stickersPlugin } from "../interfaces/commands/stickers/index.js";
import { tiktokStickerPlugin } from "../interfaces/commands/tiktoksticker/index.js";
import { toImagePlugin } from "../interfaces/commands/toimage/index.js";
import { songPlugin } from "../interfaces/commands/song/index.js";
import { minecraftPlugin } from "../interfaces/commands/minecraft/index.js";
import { benchPlugin } from "../interfaces/commands/bench/index.js";
import { getGroupSettingsStore } from "../infrastructure/storage/groupSettingsStore.js";
import { GROUP_CONFIG_COMMANDS } from "../shared/config/modules.js";

// From the bot working directory this resolves to the repository's bridge/auth.
// Containers override it with AUTH_DIR=/app/bridge/auth.
const AUTH_PATH = env("AUTH_DIR", "../bridge/auth");

function readPrefix() {
  if (process.env.PREFIX) return process.env.PREFIX;
  const envPath = existsSync(".env") ? ".env" : existsSync("../.env") ? "../.env" : null;
  if (!envPath) return "!";
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith("PREFIX="));
  return line?.split("=").slice(1).join("=").trim() || "!";
}

const PREFIX = readPrefix();


const connection = new Connection(AUTH_PATH);
const router = new Router({ prefix: PREFIX });

const ownerRepository = createOwnerRepository();
const ownerPolicy = createOwnerPolicy({
  creatorJids: () => ownerRepository.creatorJids(),
  botNumberJids: () => ownerRepository.botNumberJids(),
  botLidJids: () => ownerRepository.botLidJids(),
  extraProtectedJids: () => ownerRepository.extraProtectedJids(),
});
console.log("[owner] BOT_LIDS configurado:", ownerRepository.botLids().length > 0);

// Filtro por grupo: apagado total (!bot off) y módulos desactivados
// (!modulo off economia). Los comandos de configuración siempre pasan para
// poder volver a encenderlo.
const groupSettings = getGroupSettingsStore();
router.setGroupGate(async (ctx) => {
  if (!ctx.isGroup) return null;
  await groupSettings.ready();
  const config = groupSettings.group(cleanJid(ctx.phone) || ctx.phone);
  const isConfigCommand = ctx.isCommand && GROUP_CONFIG_COMMANDS.includes(ctx.command);
  const disabled = config.botEnabled === false && !isConfigCommand;
  const blocked = new Set(config.disabledModules || []);

  return {
    disabled,
    allows: (plugin) => {
      if (!plugin) return !disabled;
      if (isConfigCommand) return plugin === "group_admin";
      return !blocked.has(plugin);
    },
  };
});

function viewOnceMedia(message) {
  let current = message;
  let isViewOnce = false;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      isViewOnce = true;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      isViewOnce = true;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      isViewOnce = true;
      continue;
    }
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    break;
  }
  const media = current?.imageMessage || current?.videoMessage;
  return isViewOnce && media ? { content: current, media } : null;
}
let currentQr = null;
let currentQrAt = 0;
let qrServer = null;
let shuttingDown = false;
const startedAt = Date.now();

function formatUptime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function matchesToken(received, expected) {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function qrStatus() {
  return {
    active: Boolean(currentQr),
    connected: connection.isConnected(),
    qrUpdatedAt: currentQrAt,
    qrAgeSeconds: currentQr ? Math.max(0, Math.floor((Date.now() - currentQrAt) / 1000)) : null,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    now: Date.now(),
  };
}

function startHttpServer(webhookHandler) {
  const token = env("QR_ACCESS_TOKEN").trim();
  const port = Number(env("PORT", "3000"));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const mongo = await databaseHealth();
      const whatsappConnected = connection.isConnected();
      const body = JSON.stringify({
        status: mongo.ok ? "ok" : "degraded",
        process: "ok",
        mongodb: mongo.ok ? "connected" : "unavailable",
        whatsapp: whatsappConnected ? "connected" : "disconnected",
        ready: mongo.ok && whatsappConnected,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      });
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (webhookHandler && url.pathname === "/webhook") {
      await webhookHandler(request, response, url);
      return;
    }

    const isViewer = url.pathname === "/" || url.pathname === "/qr" || url.pathname === "/qr/";
    const isPng = url.pathname === "/qr.png";
    const isStatus = url.pathname === "/qr/status";
    if (
      request.method !== "GET" ||
      (!isViewer && !isPng && !isStatus) ||
      !token ||
      !matchesToken(url.searchParams.get("token"), token)
    ) {
      response.writeHead(token ? 404 : 503, { "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if (isStatus) {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(qrStatus()));
      return;
    }

    if (isPng) {
      if (!currentQr) {
        response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
        response.end("Aún no hay un QR activo. Reinicia la sesión del bot y recarga esta página.");
        return;
      }
      try {
        const image = await qrcode.toBuffer(currentQr, { type: "png", width: 420, margin: 2 });
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
          "Pragma": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(image);
      } catch {
        response.writeHead(500, { "Cache-Control": "no-store" });
        response.end();
      }
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(renderQrViewer({ token }));
  });
  server.listen(port, "0.0.0.0", () => console.log(`[http] Servidor escuchando en el puerto ${port}.`));
  return server;
}

const coreCommandsPlugin = {
  name: "core-commands",
  version: "1.0.0",
  register(pluginRouter) {
    pluginRouter.register(async (ctx) => {
      if (!ctx.isCommand) return null;
      const { name, phone } = ctx;
      if (ctx.command === "ping") {
        const ms = Date.now() - (ctx.raw.messageTimestamp || 0) * 1000;
        return `¡Pong! 🏓 (${ms}ms)`;
      }
      if (ctx.command === "status") {
        const mongo = await databaseHealth();
        const whatsappConnected = connection.isConnected();
        const healthy = mongo.ok && whatsappConnected;
        return [
          `*Estado del bot* ${healthy ? "✅" : "⚠️"}`,
          `📱 WhatsApp: ${whatsappConnected ? "conectado" : "desconectado"}`,
          `🗄️ MongoDB: ${mongo.ok ? "conectado" : "no disponible"}`,
          `⏱️ Activo: ${formatUptime(Date.now() - startedAt)}`,
          `📦 Estado general: ${healthy ? "operativo" : "requiere revisión"}`,
        ].join("\n");
      }
      if (ctx.command === "hola") {
        if (ctx.isGroup) {
          const meta = await ctx.getGroupMetadata();
          const todos = meta.participants.map(p => p.id);
          return { text: "qiubo mi perro cual es la faricea mi ñerito? cuneteme cual es la vuelta", mentions: todos };
        }
        return "qiubo mi perro cual es la faricea mi ñerito? cuneteme cual es la vuelta";
      }
      if (ctx.command === "echo") return ctx.args.join(" ");
      if (ctx.command === "info") {
        return [
          "*BandalandBot* 🤖",
          "",
          `📱 Teléfono: ${phone}`,
          `👤 Nombre: ${name}`,
          `💬 Grupo: ${ctx.isGroup ? "Sí" : "No"}`,
        ].join("\n");
      }
      return null;
    }, { category: "BASE", commands: ["ping", "status", "hola", "echo", "info"] });
  },
};

router.registerPlugin(coreCommandsPlugin);
router.registerPlugin(groupAdminPlugin, { ownerPolicy });
router.registerPlugin(fichaPlugin, { ownerPolicy });
router.registerPlugin(ownerPlugin, { ownerPolicy, ownerRepository });
router.registerPlugin(aiPlugin, { ownerRepository, ownerPolicy, router });
router.registerPlugin(antiNsfwPlugin, { ownerPolicy });
router.registerPlugin(moderationPlugin, { ownerPolicy });
router.registerPlugin(stickersPlugin);
router.registerPlugin(tiktokStickerPlugin);
router.registerPlugin(levelsPlugin);
router.registerPlugin(economyPlugin, { ownerPolicy });
router.registerPlugin(casinoPlugin);
router.registerPlugin(pollsPlugin);
router.registerPlugin(helpPlugin);
router.registerPlugin(toImagePlugin);
router.registerPlugin(songPlugin);
router.registerPlugin(minecraftPlugin);
router.registerPlugin(benchPlugin, { router });

router.register(async () => null, {
  category: "CREADOR",
  commands: ["darcoins", "givemoney", "addmoney", "antinsfw ow"],
});

const MODE = env("WHATSAPP_API", "baileys");

let webhookHandler = null;
if (MODE === "cloud" || MODE === "both") {
  const hasCreds = Boolean(
    env("WHATSAPP_ACCESS_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID") && env("WHATSAPP_VERIFY_TOKEN"),
  );
  if (!hasCreds) {
    console.warn("[cloud] WHATSAPP_API activo pero faltan WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_VERIFY_TOKEN. Webhook desactivado.");
  } else {
    const client = createCloudApiClient({
      accessToken: env("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
      graphVersion: env("GRAPH_API_VERSION", "v25.0"),
    });
    const botPhone = env("WHATSAPP_BOT_PHONE", "").replace(/\D/g, "");
    const services = {
      sendMessage: (jid, content) => client.sendMessage(jid, content),
      downloadMedia: (message) => {
        const id = extractMediaId(message);
        return id ? client.downloadMedia(id) : Promise.resolve(null);
      },
      deleteMessage: async () => null,
      getGroupMetadata: async () => null,
      updateGroupSetting: async () => null,
      updateParticipants: async () => null,
      inviteCode: async () => null,
      revokeInvite: async () => null,
      leaveGroup: async () => null,
      shutdown: async () => {
        console.log("[cloud] Apagando...");
        process.exit(0);
      },
      restart: async () => {
        console.log("[cloud] Reinicio: vaciando estado volátil de anti-nsfw");
        AntiNsfwStore.resetAllVolatile();
      },
      botJid: botPhone ? `${botPhone}@s.whatsapp.net` : undefined,
      botLid: undefined,
    };
    webhookHandler = createCloudWebhookHandler({
      router,
      services,
      client,
      verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
      appSecret: env("WHATSAPP_APP_SECRET"),
    });
    console.log("[cloud] Webhook Cloud API activo. Expón /webhook con ngrok y configura la URL en Meta.");
  }
}

qrServer = startHttpServer(webhookHandler);


connection.on("ready", async (user) => {
  currentQr = null;
  currentQrAt = 0;
  console.log(`[bot] Conectado como: ${cleanJid(user.id)}`);
  await initOwnerStorage();
  connection.sendMessage(user.id, "Bot iniciado correctamente");

  connection.sock?.ev?.on("group-participants.update", (update) => {
    handleGroupParticipantsUpdate(update, {
      sendMessage: (jid, content) => connection.sendMessage(jid, content),
      getGroupMetadata: (jid) => connection.sock?.groupMetadata(jid),
    }).catch((err) => console.error("[group_admin] Error en welcome/bye:", err));
  });

  connection.sock?.ev?.on("group-participants.update", (update) => {
    handleGroupUpdate(update, {
      getGroupMetadata: (jid) => connection.sock?.groupMetadata(jid),
      updateParticipants: (jid, participants, action) =>
        connection.sock?.groupParticipantsUpdate(jid, participants, action),
      botJid: connection.sock?.user?.id,
      botLid: connection.sock?.user?.lid,
    }, console, {
      creatorNumbers: () => ownerRepository.creatorNumbers(),
      isBotAdmin: (getGroupMetadata, botJid, botLid) => ownerPolicy.isBotAdmin(getGroupMetadata, botJid, botLid),
    }).catch((err) => console.error("[autoPromote] Error en evento de grupo:", err));
  });

  scanAllGroups({
    getGroupMetadataAll: () => connection.sock?.groupFetchAllParticipating(),
    getGroupMetadata: (jid) => connection.sock?.groupMetadata(jid),
    updateParticipants: (jid, participants, action) =>
      connection.sock?.groupParticipantsUpdate(jid, participants, action),
    botJid: connection.sock?.user?.id,
    botLid: connection.sock?.user?.lid,
  }, console, {
    creatorNumbers: () => ownerRepository.creatorNumbers(),
    isBotAdmin: (getGroupMetadata, botJid, botLid) => ownerPolicy.isBotAdmin(getGroupMetadata, botJid, botLid),
  }).catch((err) => console.error("[autoPromote] Error en escaneo inicial:", err));
});

connection.on("message", async (msg) => {
  if (!msg.key?.fromMe && msg.message) {
    const viewOnce = viewOnceMedia(msg.message);
    if (viewOnce) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
          logger: console,
          reuploadRequest: (message) => connection.sock?.updateMediaMessage(message),
        });
        await connection.sendMessage(msg.key.remoteJid, {
          [viewOnce.content.videoMessage ? "video" : "image"]: buffer,
          mimetype: viewOnce.media.mimetype,
          caption: viewOnce.media.caption || "",
        });
        console.log(`[view-once] Reenviado: ${msg.key.id}`);
      } catch (error) {
        console.warn("[view-once] No se pudo reenviar el archivo:", error?.message || error);
      }
    }
  }

  const reply = await router.route(msg, {
    sendMessage: (jid, content) => connection.sendMessage(jid, content),
    sendList: (jid, payload) => connection.sendList(jid, payload),
    deleteMessage: (jid, key) => connection.sock?.sendMessage(jid, { delete: key }),
    getGroupMetadata: (jid) => connection.sock?.groupMetadata(jid),
    updateGroupSetting: (jid, setting) => connection.sock?.groupSettingUpdate(jid, setting),
    updateParticipants: (jid, participants, action) =>
      connection.sock?.groupParticipantsUpdate(jid, participants, action),
    inviteCode: (jid) => connection.sock?.groupInviteCode(jid),
    revokeInvite: (jid) => connection.sock?.groupRevokeInvite(jid),
    leaveGroup: (jid) => connection.sock?.groupLeave(jid),
    shutdown: async () => {
      await connection.disconnect();
      process.exit(0);
    },
    restart: async () => {
      console.log("[bot] Esperando 60s antes de reconectar...");
      await new Promise(r => setTimeout(r, 60000));
      AntiNsfwStore.resetAllVolatile();
      await connection.disconnect();
    },
    botJid: connection.sock?.user?.id,
    botLid: connection.sock?.user?.lid,
    downloadMedia: (message) =>
      downloadMediaMessage(message, "buffer", {}, {
        logger: console,
        reuploadRequest: (message) => connection.sock?.updateMediaMessage(message),
      }),
  });

  if (reply) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await connection.sendMessage(msg.key.remoteJid, reply);
        break;
      } catch (err) {
        const rateLimited = /rate-overlimit|rate limit|429/i.test(err?.message || "");
        if (!rateLimited || attempt === maxAttempts) {
          console.warn("[bot] Error al enviar respuesta:", err?.message || err);
          break;
        }
        const waitMs = attempt * 15_000;
        console.warn(`[bot] Rate-limit al enviar respuesta, reintentando en ${waitMs / 1000}s (intento ${attempt}/${maxAttempts})...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
});

connection.on("qr", (qr) => {
  currentQr = qr;
  currentQrAt = Date.now();
  console.log("[bot] QR recibido. Disponible en el visor privado.");
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[bot] Recibida señal ${signal}; cerrando conexión...`);
  await connection.disconnect().catch((error) => console.error("[bot] Error cerrando WhatsApp:", error));
  await closeDb().catch((error) => console.error("[bot] Error cerrando MongoDB:", error));
  await new Promise((resolve) => qrServer?.close(resolve) || resolve());
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

export { connection, router, MODE as mode };
