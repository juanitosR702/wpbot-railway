import { test } from "node:test";
import assert from "node:assert";

import { Router, HALT } from "../src/interfaces/bot/router.js";
import { createCommandCatalog, LEVEL } from "../src/interfaces/commands/ai/commandCatalog.js";
import { createCommandRunner } from "../src/interfaces/commands/ai/commandRunner.js";
import { aiPlugin } from "../src/interfaces/commands/ai/index.js";

const BOT_JID = "573000000000@s.whatsapp.net";
const BOT_LID = "999999@lid";

function metadataWith(admins = [], creators = []) {
  return {
    participants: [
      ...admins.map((id) => ({ id, admin: "admin" })),
      ...creators.map((id) => ({ id, admin: "superadmin" })),
    ],
  };
}

function fakeStore() {
  const messages = [];
  return {
    recorded: messages,
    async ready() {},
    chat() {
      return { history: [], messages };
    },
    messages() {
      return [];
    },
    recordMessage(jid, message) {
      messages.push({ at: new Date().toISOString(), ...message });
    },
    recentMessages() {
      return messages;
    },
    append() {},
    log() {},
    reset() {},
  };
}

function fakeRouter(commands, route) {
  return {
    prefix: "!",
    handlers: [],
    routes: [],
    register(handler, meta) {
      this.handlers.push({ handler, meta });
    },
    getCommands() {
      return commands.map((command, index) => ({
        command,
        category: index % 2 ? "ADMINISTRACION" : "UTILIDADES",
        plugin: "test",
      }));
    },
    async route(message, services) {
      this.routes.push({ message, services });
      return route ? route(message, services) : "ok";
    },
  };
}

function scriptedClient(responses) {
  return {
    supportsTools: true,
    calls: [],
    async chatWithTools(input) {
      this.calls.push(input);
      const index = Math.min(this.calls.length - 1, responses.length - 1);
      return responses[index];
    },
    async chat() {
      return { ok: true, content: "respuesta plana" };
    },
  };
}

function makeCtx({ phone, text, sender, mentions = [], command = null, args = [], group = true, admins = [] }) {
  const services = { sent: [] };
  const ctx = {
    phone,
    sender,
    text,
    name: "Tester",
    prefix: "!",
    isGroup: group,
    isCommand: Boolean(command),
    command,
    args,
    botJid: BOT_JID,
    botLid: BOT_LID,
    services,
    raw: {
      key: {
        remoteJid: group ? phone : `${sender}@s.whatsapp.net`,
        participant: `${sender}@s.whatsapp.net`,
        fromMe: false,
      },
      pushName: "Tester",
      message: {
        extendedTextMessage: {
          text,
          contextInfo: mentions.length ? { mentionedJid: mentions } : undefined,
        },
      },
    },
    async sendMessage(content) {
      services.sent.push(content);
    },
    async getGroupMetadata() {
      return metadataWith(admins);
    },
    async deleteMessage() {},
  };
  return ctx;
}

const ownerRepository = { botNumberJids: () => ["573111111111@s.whatsapp.net"] };
const creatorOnlyPolicy = { isCreatorJid: (sender) => sender === "999" };

test("catalogo: construye desde el router y busca por lenguaje natural", () => {
  const router = new Router();
  router.register(() => null, { category: "ADMIN", commands: ["kirk", "promote"] });
  router.register(() => null, { category: "ECONOMIA", commands: ["darcoins", "balance"] });
  router.register(() => null, { category: "NSFW", commands: ["antinsfw on"] });
  router.register(() => null, { category: "X", commands: ["bench"] });

  const catalog = createCommandCatalog(router);

  // "antinsfw on" se normaliza a "antinsfw"; bench se ignora.
  assert.deepStrictEqual(catalog.names().sort(), ["antinsfw", "balance", "darcoins", "kirk", "promote"]);
  assert.strictEqual(catalog.get("kirk").level, LEVEL.ADMIN);
  assert.strictEqual(catalog.get("darcoins").level, LEVEL.CREATOR);
  assert.strictEqual(catalog.search("expulsa a alguien")[0].name, "kirk");
  assert.strictEqual(catalog.search("regala monedas")[0].name, "darcoins");

  const index = catalog.compactIndex();
  assert.ok(index.includes("kirk"));
  assert.ok(!index.includes("bench"));
});

test("runner: rechaza comandos de admin a un usuario normal", async () => {
  const catalog = createCommandCatalog(fakeRouter(["kirk"]));
  const router = fakeRouter(["kirk"]);
  const runner = createCommandRunner({ router, catalog, ownerPolicy: creatorOnlyPolicy });

  const ctx = makeCtx({ phone: "grupo1@g.us", text: "expulsa", sender: "222" });
  const result = await runner.run("kirk", ["777@s.whatsapp.net"], ctx);

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /administradores/);
  assert.strictEqual(router.routes.length, 0);
});

test("runner: permite comandos de admin a un admin y preserva menciones sin el bot", async () => {
  const catalog = createCommandCatalog(fakeRouter(["kirk"]));
  const router = fakeRouter(["kirk"], () => "expulsado");
  const runner = createCommandRunner({ router, catalog, ownerPolicy: creatorOnlyPolicy });

  const ctx = makeCtx({
    phone: "grupo2@g.us",
    text: "expulsa",
    sender: "111",
    mentions: [BOT_JID, "777@s.whatsapp.net"],
    admins: ["111@s.whatsapp.net"],
  });

  const result = await runner.run("kirk", [], ctx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reply, "expulsado");
  const sent = router.routes[0].message;
  assert.deepStrictEqual(sent.message.extendedTextMessage.contextInfo.mentionedJid, ["777@s.whatsapp.net"]);
  assert.strictEqual(sent.__aiSynthetic, true);
});

test("plugin: comando destructivo pide confirmacion y solo ejecuta con 'si'", async () => {
  const commands = ["kirk"];
  const router = fakeRouter(commands, () => "🚨 @777 expulsado");
  const ledger = fakeStore();
  const client = scriptedClient([
    { ok: true, text: "", functionCall: { name: "ejecutar_comando", args: { nombre: "kirk", argumentos: "777@s.whatsapp.net" } } },
  ]);

  const entering = aiPlugin;
  entering.register(router, {
    client,
    store: ledger,
    ownerRepository,
    ownerPolicy: creatorOnlyPolicy,
    router,
  });
  const handler = router.handlers[0].handler;

  const ctx = makeCtx({
    phone: "grupo3@g.us",
    text: "@bot elimina a 777",
    sender: "111",
    mentions: [BOT_JID],
    admins: ["111@s.whatsapp.net"],
  });
  const reply = await handler(ctx);

  assert.match(reply, /Confirmación requerida/);
  assert.strictEqual(router.routes.length, 0);

  const confirmed = await handler(
    makeCtx({ phone: "grupo3@g.us", text: "sí", sender: "111" }),
  );

  assert.strictEqual(confirmed, "🚨 @777 expulsado");
  assert.strictEqual(router.routes.length, 1);
  assert.strictEqual(router.routes[0].message.__aiSynthetic, true);
});

test("plugin: un tercero no puede confirmar una accion ajena", async () => {
  const router = fakeRouter(["kirk"], () => "expulsado");
  const ledger = fakeStore();
  const client = scriptedClient([
    { ok: true, text: "", functionCall: { name: "ejecutar_comando", args: { nombre: "kirk", argumentos: "777@s.whatsapp.net" } } },
  ]);

  aiPlugin.register(router, {
    client,
    store: ledger,
    ownerRepository,
    ownerPolicy: creatorOnlyPolicy,
    router,
  });
  const handler = router.handlers[0].handler;

  await handler(makeCtx({ phone: "grupo4@g.us", text: "@bot elimina a 777", sender: "111", mentions: [BOT_JID], admins: ["111@s.whatsapp.net"] }));
  // 222 no es admin ni el solicitante.
  const reply = await handler(makeCtx({ phone: "grupo4@g.us", text: "sí", sender: "222" }));

  assert.strictEqual(reply, null);
  assert.strictEqual(router.routes.length, 0);
});

test("plugin: comando de usuario se ejecuta y envia su respuesta", async () => {
  const router = fakeRouter(["ping"], () => "pong");
  const ledger = fakeStore();
  const client = scriptedClient([
    { ok: true, text: "", functionCall: { name: "ejecutar_comando", args: { nombre: "ping" } } },
    { ok: true, text: "NADA" },
  ]);

  aiPlugin.register(router, {
    client,
    store: ledger,
    ownerRepository,
    ownerPolicy: creatorOnlyPolicy,
    router,
  });
  const handler = router.handlers[0].handler;

  const ctx = makeCtx({ phone: "grupo5@g.us", text: "@bot haz ping", sender: "222", mentions: [BOT_JID] });
  const reply = await handler(ctx);

  assert.strictEqual(reply, HALT);
  assert.strictEqual(router.routes.length, 1);
  assert.deepStrictEqual(ctx.services.sent, ["pong"]);
});

test("plugin: comando inexistente vuelve al modelo como error", async () => {
  const router = fakeRouter(["ping"], () => "pong");
  const ledger = fakeStore();
  const client = scriptedClient([
    { ok: true, text: "", functionCall: { name: "ejecutar_comando", args: { nombre: "volar" } } },
    { ok: true, text: "Ese comando no existe." },
  ]);

  aiPlugin.register(router, {
    client,
    store: ledger,
    ownerRepository,
    ownerPolicy: creatorOnlyPolicy,
    router,
  });
  const handler = router.handlers[0].handler;

  const reply = await handler(makeCtx({ phone: "grupo6@g.us", text: "@bot vuela", sender: "222", mentions: [BOT_JID] }));

  assert.strictEqual(reply, "Ese comando no existe.");
  assert.strictEqual(router.routes.length, 0);
  const secondCall = JSON.stringify(client.calls[1].turns);
  assert.ok(secondCall.includes("no existe"));
});

test("plugin: no ejecuta nada si el mensaje sintetico vuelve al router", async () => {
  const router = fakeRouter(["ping"], () => "pong");
  const ledger = fakeStore();
  const client = scriptedClient([{ ok: true, text: "no deberia usarse" }]);

  aiPlugin.register(router, {
    client,
    store: ledger,
    ownerRepository,
    ownerPolicy: creatorOnlyPolicy,
    router,
  });
  const handler = router.handlers[0].handler;

  const ctx = makeCtx({ phone: "grupo7@g.us", text: "@bot ping", sender: "222", mentions: [BOT_JID] });
  ctx.raw.__aiSynthetic = true;

  const reply = await handler(ctx);

  assert.strictEqual(reply, null);
  assert.strictEqual(client.calls.length, 0);
});

test("router: commandBody conserva espacios y saltos de linea", async () => {
  const router = new Router();
  let captured = null;
  router.register(
    async (ctx) => {
      captured = ctx;
      return "ok";
    },
    { commands: ["setwelcome"] },
  );

  await router.route(
    {
      key: { remoteJid: "120363000000@g.us", participant: "111@s.whatsapp.net", fromMe: false },
      message: { extendedTextMessage: { text: "!setwelcome Hola   {user}\n\nsegunda linea" } },
    },
    {},
  );

  assert.strictEqual(captured.commandBody, "Hola   {user}\n\nsegunda linea");
  assert.deepStrictEqual(captured.args, ["Hola", "{user}", "segunda", "linea"]);
});
