import { test } from "node:test";
import assert from "node:assert";

import { fichaPlugin } from "../src/interfaces/commands/ficha/index.js";
import { HALT } from "../src/interfaces/bot/router.js";

const ORIGIN = "120363000000000001@g.us";
const DESTINATION = "120363000000000999@g.us";

function fakeStore(overrides = {}) {
  return {
    ready: async () => {},
    save: async () => {},
    destination: () => DESTINATION,
    form: () => null,
    setForm() {},
    clearForm() {},
    setDestination() {},
    ...overrides,
  };
}

async function setup(store = fakeStore()) {
  let handler = null;
  const api = { register: (fn) => { handler = fn; }, getCommands: () => [], prefix: "!" };
  fichaPlugin.register(api, { store, ownerPolicy: { isCreatorJid: () => false } });
  assert.ok(handler, "el plugin debe registrar un handler");
  return handler;
}

function makeCtx(overrides = {}) {
  const sent = [];
  const ctx = {
    phone: ORIGIN,
    sender: "573001112233@s.whatsapp.net",
    name: "Ana",
    text: "",
    selection: null,
    isGroup: true,
    isCommand: false,
    command: null,
    args: [],
    commandBody: "",
    raw: { key: { participant: "573001112233@s.whatsapp.net" } },
    services: {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `m${sent.length}` } };
      },
    },
    getGroupMetadata: async () => ({
      subject: "Clan",
      participants: [{ id: ctx.sender, admin: "admin" }],
    }),
    ...overrides,
  };
  ctx.sendMessage = async (content) => {
    sent.push({ jid: ctx.phone, content });
    return { key: { id: `m${sent.length}` } };
  };
  // Lista desplegable: el router la expone como `ctx.sendList`.
  ctx.sendList = async (payload) => {
    sent.push({ jid: ctx.phone, content: payload });
    return { key: { id: `m${sent.length}` } };
  };
  return { ctx, sent };
}

function makeCtxWithSender(n, overrides = {}) {
  const sender = `5730000000${n}@s.whatsapp.net`;
  return makeCtx({ sender, raw: { key: { participant: sender } }, ...overrides });
}

const TWO_FIELDS = {
  header: "FICHA TEST",
  footer: "Pie de prueba",
  fields: [
    { section: "DATOS" },
    { label: "Nombre", options: [] },
    { label: "País", options: ["Colombia", "México"] },
  ],
};

test("ficha: flujo completo con desplegable y envío al grupo destino", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx, sent } = makeCtxWithSender(1);

  const started = await handler({ ...ctx, isCommand: true, command: "ficha" });
  assert.strictEqual(started, HALT);
  assert.match(sent[0].content.text, /Nombre/);
  assert.strictEqual(sent[0].jid, ORIGIN);

  // Nombre por texto.
  assert.strictEqual(await handler({ ...ctx, text: "Ana" }), HALT);
  const list = sent[1].content;
  assert.ok(list.rows, "el campo con opciones debe ser una lista interactiva");
  assert.strictEqual(list.rows[0].rowId, "f:o:1:0");
  assert.strictEqual(list.rows[1].title, "México");

  // Selección del desplegable (no escribe texto: llega en `selection`).
  assert.strictEqual(await handler({ ...ctx, selection: "f:o:1:0" }), HALT);
  const preview = sent[2].content;
  assert.match(preview.text, /Ana/);
  assert.match(preview.text, /País: Colombia/);
  assert.deepStrictEqual(
    preview.rows.map((row) => row.rowId),
    ["f:s", "f:e", "f:x"],
  );

  const done = await handler({ ...ctx, selection: "f:s" });
  assert.match(done, /Ficha enviada/);
  const delivery = sent.at(-1);
  assert.strictEqual(delivery.jid, DESTINATION);
  assert.match(delivery.content.text, /FICHA TEST/);
  assert.match(delivery.content.text, /• Nombre: Ana/);
  assert.match(delivery.content.text, /• País: Colombia/);
  assert.match(delivery.content.text, /@57300000001/);
  assert.deepStrictEqual(delivery.content.mentions, ["57300000001@s.whatsapp.net"]);
});

test("ficha: si la lista interactiva falla, cae a menú numerado", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx, sent } = makeCtxWithSender(2);
  ctx.sendList = async () => {
    throw new Error("lista no soportada");
  };

  await handler({ ...ctx, isCommand: true, command: "ficha" });
  await handler({ ...ctx, text: "Ana" });
  assert.match(sent.at(-1).content.text, /1\. Colombia/);

  await handler({ ...ctx, text: "1" });
  assert.match(sent.at(-1).content.text, /Revisa tu ficha/);
  assert.match(sent.at(-1).content.text, /País: Colombia/);
});

test("ficha: corrige un campo antes de enviar", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx, sent } = makeCtxWithSender(3);

  await handler({ ...ctx, isCommand: true, command: "ficha" });
  await handler({ ...ctx, text: "Ana" });
  await handler({ ...ctx, selection: "f:o:1:1" }); // México
  assert.match(sent.at(-1).content.text, /País: México/);

  // Corregir -> elegir campo 0 (Nombre) -> escribir otro nombre.
  await handler({ ...ctx, selection: "f:e" });
  assert.match(sent.at(-1).content.text, /Qué campo/);
  await handler({ ...ctx, selection: "f:p:0" });
  assert.match(sent.at(-1).content.text, /Nombre/);
  await handler({ ...ctx, text: "Ana María" });
  assert.match(sent.at(-1).content.text, /Ana María/);
  assert.match(sent.at(-1).content.text, /País: México/);

  await handler({ ...ctx, selection: "f:s" });
  assert.match(sent.at(-1).content.text, /Nombre: Ana María/);
});

test("ficha: cancelar descarta la sesión", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx } = makeCtxWithSender(4);

  await handler({ ...ctx, isCommand: true, command: "ficha" });
  assert.match(await handler({ ...ctx, text: "cancelar" }), /cancelada/);
  // Sin sesión, el mensaje ya no lo consume este plugin.
  assert.strictEqual(await handler({ ...ctx, text: "hola" }), null);
});

test("ficha: avisa cuando no hay grupo de almacenamiento", async () => {
  const handler = await setup(fakeStore({ destination: () => "" }));
  const { ctx, sent } = makeCtxWithSender(5);

  const reply = await handler({ ...ctx, isCommand: true, command: "ficha" });
  assert.match(reply, /!fichadestino/);
  assert.strictEqual(sent.length, 0);
});
