import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "crypto";
import { buildSendPayload } from "../src/infrastructure/cloudapi/graphClient.js";
import {
  toBaileysMessage,
  verifySignature,
  extractMediaId,
  createCloudWebhookHandler,
} from "../src/interfaces/webhook/cloudWebhook.js";

test("buildSendPayload: texto simple individual", async () => {
  const payload = await buildSendPayload("573123456789@s.whatsapp.net", "hola");
  assert.deepStrictEqual(payload, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "573123456789",
    type: "text",
    text: { body: "hola" },
  });
});

test("buildSendPayload: grupo -> recipient_type group", async () => {
  const payload = await buildSendPayload("120363123456789@g.us", "hola");
  assert.strictEqual(payload.recipient_type, "group");
  assert.strictEqual(payload.to, "120363123456789@g.us");
});

test("buildSendPayload: texto con menciones", async () => {
  const yaMencionado = await buildSendPayload("573123456789", {
    text: "@573111111111 hola",
    mentions: ["573111111111@s.whatsapp.net"],
  });
  assert.strictEqual(yaMencionado.text.body, "@573111111111 hola");

  const sinMencion = await buildSendPayload("573123456789", {
    text: "hola",
    mentions: ["573111111111@s.whatsapp.net"],
  });
  assert.ok(sinMencion.text.body.includes("@573111111111"));
});

test("buildSendPayload: media por buffer usa upload()", async () => {
  let uploadMime = null;
  const payload = await buildSendPayload(
    "573123456789",
    { image: Buffer.from("x"), mimetype: "image/png", caption: "foto" },
    async (_buffer, mime) => {
      uploadMime = mime;
      return "MEDIA-1";
    },
  );
  assert.deepStrictEqual(payload.image, { id: "MEDIA-1", caption: "foto" });
  assert.strictEqual(uploadMime, "image/png");
});

test("buildSendPayload: sticker por buffer sube como image/webp", async () => {
  const payload = await buildSendPayload(
    "573123456789",
    { sticker: Buffer.from("x"), mimetype: "image/webp" },
    async () => "STICKER-1",
  );
  assert.strictEqual(payload.type, "sticker");
  assert.deepStrictEqual(payload.sticker, { id: "STICKER-1" });
});

test("buildSendPayload: media por url", async () => {
  const payload = await buildSendPayload("573123456789", {
    video: { url: "https://cdn.example.com/v.mp4" },
    caption: "clip",
  });
  assert.deepStrictEqual(payload.video, { link: "https://cdn.example.com/v.mp4", caption: "clip" });
});

test("buildSendPayload: contenido no soportado -> null", async () => {
  assert.strictEqual(await buildSendPayload("573123456789", { button: {} }), null);
  assert.strictEqual(await buildSendPayload("573123456789", 123), null);
});

test("toBaileysMessage: texto 1:1", () => {
  const msg = toBaileysMessage(
    { from: "573123456789", id: "wamid.1", timestamp: "1749416383", type: "text", text: { body: "!ping" } },
    [{ profile: { name: "Ana" }, wa_id: "573123456789" }],
  );
  assert.strictEqual(msg.key.remoteJid, "573123456789@s.whatsapp.net");
  assert.strictEqual(msg.key.fromMe, false);
  assert.strictEqual(msg.message.conversation, "!ping");
  assert.strictEqual(msg.pushName, "Ana");
  assert.strictEqual(msg.messageTimestamp, 1749416383);
});

test("toBaileysMessage: imagen mapea media id", () => {
  const msg = toBaileysMessage({
    from: "573123456789",
    id: "wamid.2",
    type: "image",
    image: { id: "MEDIA-9", mime_type: "image/jpeg", caption: "hola" },
  });
  assert.strictEqual(msg.message.imageMessage.id, "MEDIA-9");
  assert.strictEqual(msg.message.imageMessage.caption, "hola");
  assert.strictEqual(extractMediaId(msg), "MEDIA-9");
});

test("toBaileysMessage: grupo con group_id y emisor", () => {
  const msg = toBaileysMessage({
    from: "573123456789",
    group_id: "120363123456789@g.us",
    id: "wamid.3",
    type: "text",
    text: { body: "hola grupo" },
  });
  assert.strictEqual(msg.key.remoteJid, "120363123456789@g.us");
  assert.strictEqual(msg.key.participant, "573123456789@s.whatsapp.net");
});

test("verifySignature: firma válida/inválida/sin firma", () => {
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  const expected = createHash("sha256").update("SECRET").update(raw).digest("hex");
  assert.ok(verifySignature(raw, `sha256=${expected}`, "SECRET"));
  assert.ok(!verifySignature(raw, "sha256=incorrecta", "SECRET"));
  assert.ok(verifySignature(raw, undefined, "SECRET"));
  assert.ok(verifySignature(raw, `sha256=${expected}`, undefined));
});

test("webhook GET: verificación responde challenge y falla con token inválido", async () => {
  const handler = createCloudWebhookHandler({
    router: { route: async () => null },
    services: { sendMessage: async () => {} },
    client: null,
    verifyToken: "TOK",
    appSecret: "",
  });

  const okUrl = new URL("https://x/webhook?hub.mode=subscribe&hub.verify_token=TOK&hub.challenge=CH123");
  let status = 0;
  let body = "";
  await handler({ method: "GET" }, { writeHead: (s) => (status = s), end: (b) => (body = b) }, okUrl);
  assert.strictEqual(status, 200);
  assert.strictEqual(body, "CH123");

  const badUrl = new URL("https://x/webhook?hub.mode=subscribe&hub.verify_token=NOPE&hub.challenge=CH123");
  status = 0;
  await handler({ method: "GET" }, { writeHead: (s) => (status = s), end: () => {} }, badUrl);
  assert.strictEqual(status, 403);
});

test("webhook POST: enruta el mensaje al Router y envía la respuesta", async () => {
  const replies = [];
  const router = {
    route: async (msg) => {
      assert.strictEqual(msg.message.conversation, "hola");
      return "adios";
    },
  };
  const services = {
    sendMessage: async (jid, content) => replies.push({ jid, content }),
  };
  const handler = createCloudWebhookHandler({ router, services, client: null, verifyToken: "T", appSecret: "" });

  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573026525974", phone_number_id: "12345" },
              contacts: [{ profile: { name: "Ana" }, wa_id: "573123456789" }],
              messages: [
                { from: "573123456789", id: "wamid.9", timestamp: "1749416383", type: "text", text: { body: "hola" } },
              ],
            },
          },
        ],
      },
    ],
  });

  let status = 0;
  const req = {
    method: "POST",
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(payload);
    },
  };
  await handler(req, { writeHead: (s) => (status = s), end: () => {} }, new URL("https://x/webhook"));
  assert.strictEqual(status, 200);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].jid, "573123456789@s.whatsapp.net");
  assert.strictEqual(replies[0].content, "adios");
});

test("webhook POST: firma inválida rechaza con 403", async () => {
  const handler = createCloudWebhookHandler({
    router: { route: async () => null },
    services: { sendMessage: async () => {} },
    client: null,
    verifyToken: "T",
    appSecret: "SECRET",
  });
  let status = 0;
  const req = {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=fake" },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from("{}");
    },
  };
  await handler(req, { writeHead: (s) => (status = s), end: () => {} }, new URL("https://x/webhook"));
  assert.strictEqual(status, 403);
});
