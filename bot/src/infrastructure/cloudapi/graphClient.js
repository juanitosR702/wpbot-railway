// Cliente de la API oficial de Meta (WhatsApp Business Cloud API).
// Usa fetch/FormData/Blob nativos (Node >= 18).

export function normalizePhone(jid) {
  const raw = String(jid || "");
  if (raw.endsWith("@g.us")) return raw;
  return raw.split("@")[0].split(":")[0];
}

function withMentions(text, mentions) {
  let body = String(text ?? "");
  for (const mention of mentions || []) {
    const num = normalizePhone(mention);
    if (num && !body.includes(`@${num}`)) body += `\n@${num}`;
  }
  return body;
}

// Construye el payload de POST /{phone-number-id}/messages.
// `upload` solo se invoca cuando el contenido es un Buffer (media).
export async function buildSendPayload(to, content, upload) {
  const recipient = normalizePhone(to);
  const isGroup = recipient.endsWith("@g.us");
  const base = {
    messaging_product: "whatsapp",
    recipient_type: isGroup ? "group" : "individual",
    to: recipient,
  };

  if (typeof content === "string") {
    return { ...base, type: "text", text: { body: content } };
  }
  if (!content || typeof content !== "object") return null;

  if (content.text !== undefined) {
    const body = withMentions(content.text, content.mentions);
    return { ...base, type: "text", text: { body } };
  }

  const mediaType = ["image", "video", "audio", "document", "sticker"].find((t) => content[t] !== undefined);
  if (!mediaType) return null;

  const media = content[mediaType];
  const node = {};
  if (Buffer.isBuffer(media)) {
    const mime = mediaType === "sticker" ? "image/webp" : (content.mimetype || "application/octet-stream");
    node.id = await upload(media, mime);
  } else if (media && typeof media === "object" && media.id) {
    node.id = media.id;
  } else {
    const link = typeof media === "string" ? media : media?.url;
    if (link && /^https?:\/\//i.test(link)) node.link = link;
    else return null;
  }
  if (content.caption) node.caption = String(content.caption);
  if (mediaType === "document" && content.filename) node.filename = String(content.filename);

  return { ...base, type: mediaType, [mediaType]: node };
}

export function createCloudApiClient({ accessToken, phoneNumberId, graphVersion = "v25.0" }) {
  const base = `https://graph.facebook.com/${graphVersion}`;

  async function request(path, init = {}) {
    const headers = { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) };
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`[cloud_api] ${body?.error?.message || `${res.status} ${res.statusText}`}`);
    }
    return body;
  }

  async function uploadMedia(buffer, mimeType) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([buffer], { type: mimeType }), "file");
    const result = await request(`/${phoneNumberId}/media`, { method: "POST", body: form });
    return result?.id;
  }

  async function sendMessage(to, content) {
    const payload = await buildSendPayload(to, content, uploadMedia);
    if (!payload) return null;
    return request(`/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function downloadMedia(mediaId) {
    const info = await request(`/${mediaId}`);
    if (!info?.url) throw new Error("[cloud_api] La media no tiene URL descargable");
    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`[cloud_api] Descarga de media falló: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function markAsRead(messageId) {
    return request(`/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  }

  return { request, uploadMedia, sendMessage, downloadMedia, markAsRead };
}
