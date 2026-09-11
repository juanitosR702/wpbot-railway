// Webhook de la API oficial de Meta (WhatsApp Business Cloud API).
// GET  /webhook → verificación (hub.mode / hub.verify_token / hub.challenge)
// POST /webhook → mensajes entrantes, convertidos al formato que entiende el Router
//                  y enrutados con servicios Cloud API.

import { createHash, timingSafeEqual } from "crypto";
import { cleanJid } from "../../shared/utils/jid.js";

export function verifySignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return true;
  const expected = createHash("sha256").update(appSecret).update(rawBody).digest("hex");
  const received = signature.replace(/^sha256=/, "");
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mediaNode(message, type, source) {
  const m = message[source] || {};
  return {
    id: m.id,
    mimetype: m.mime_type,
    caption: m.caption,
    url: m.url,
    ...(source === "document" ? { fileName: m.filename } : {}),
    ...(source === "sticker" ? { isAnimated: m.animated } : {}),
    ...(source === "audio" ? { ptt: m.voice } : {}),
  };
}

// Convierte un mensaje del webhook de la Cloud API al formato Baileys que usa el Router.
export function toBaileysMessage(message, contacts = []) {
  const contact = contacts?.[0];
  const from = String(message.from || "");
  const isGroup = from.endsWith("@g.us") || Boolean(message.group_id);
  const groupId = message.group_id || (isGroup ? from : null);
  const remoteJid = isGroup
    ? (groupId.includes("@") ? groupId : `${groupId}@g.us`)
    : `${from}@s.whatsapp.net`;
  const senderPhone = isGroup ? cleanJid(message.context?.from || from) : cleanJid(from);
  const participant = isGroup ? `${senderPhone}@s.whatsapp.net` : undefined;

  let content = {};
  switch (message.type) {
    case "text":
      content = { conversation: message.text?.body || "" };
      break;
    case "image":
      content = { imageMessage: mediaNode(message, "image", "image") };
      break;
    case "video":
      content = { videoMessage: mediaNode(message, "video", "video") };
      break;
    case "audio":
      content = { audioMessage: mediaNode(message, "audio", "audio") };
      break;
    case "document":
      content = { documentMessage: mediaNode(message, "document", "document") };
      break;
    case "sticker":
      content = { stickerMessage: mediaNode(message, "sticker", "sticker") };
      break;
    case "location":
      content = {
        locationMessage: {
          degreesLatitude: message.location?.latitude,
          degreesLongitude: message.location?.longitude,
        },
      };
      break;
    default:
      content = { conversation: "" };
  }

  return {
    key: { remoteJid, participant, fromMe: false, id: message.id },
    pushName: contact?.profile?.name,
    message: content,
    messageTimestamp: Number(message.timestamp || 0),
  };
}

export function extractMediaId(msg) {
  const content = msg?.message || {};
  for (const type of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    if (content[type]?.id) return content[type].id;
  }
  return null;
}

export function createCloudWebhookHandler({ router, services, client, verifyToken, appSecret }) {
  const sendReply = async (remoteJid, reply) => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await services.sendMessage(remoteJid, reply);
        return;
      } catch (err) {
        const rateLimited = /rate limit|429|too many/i.test(err?.message || "");
        if (!rateLimited || attempt === maxAttempts) {
          console.warn("[cloud] Error al enviar respuesta:", err?.message || err);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 15000));
      }
    }
  };

  const handlePost = async (body) => {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;
    const contacts = value.contacts || [];
    for (const message of value.messages) {
      try {
        client?.markAsRead(message.id).catch(() => {});
      } catch {}
      const msg = toBaileysMessage(message, contacts);
      const reply = await router.route(msg, services);
      if (reply) await sendReply(msg.key.remoteJid, reply);
    }
  };

  return async (request, response, url) => {
    if (url.pathname !== "/webhook") {
      response.writeHead(404);
      response.end();
      return;
    }

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === verifyToken && challenge) {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(challenge);
      } else {
        response.writeHead(403);
        response.end();
      }
      return;
    }

    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      if (!verifySignature(rawBody, request.headers["x-hub-signature-256"], appSecret)) {
        response.writeHead(403);
        response.end();
        return;
      }
      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        response.writeHead(400);
        response.end("invalid json");
        return;
      }
      response.writeHead(200);
      response.end();
      handlePost(body).catch((err) => console.error("[cloud_webhook] Error procesando evento:", err));
      return;
    }

    response.writeHead(405);
    response.end();
  };
}
