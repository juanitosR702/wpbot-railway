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

test("ficha: la sesión sobrevive si WhatsApp cambia el JID del remitente", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx, sent } = makeCtxWithSender(8);

  await handler({ ...ctx, isCommand: true, command: "ficha" });
  await handler({ ...ctx, text: "Ana" });

  // El siguiente mensaje llega con otro JID (LID) y el teléfono en participantPn.
  const switched = {
    ...ctx,
    sender: "99887766554433",
    raw: {
      key: {
        participant: "99887766554433@lid",
        participantPn: "57300000008@s.whatsapp.net",
      },
    },
  };
  await handler({ ...switched, selection: "f:o:1:0" });

  assert.match(sent.at(-1).content.text, /Revisa tu ficha/);
  assert.match(sent.at(-1).content.text, /País: Colombia/);
});

test("ficha: una lista vieja en un campo de texto repite la pregunta", async () => {
  const handler = await setup(fakeStore({ form: () => TWO_FIELDS }));
  const { ctx, sent } = makeCtxWithSender(9);

  await handler({ ...ctx, isCommand: true, command: "ficha" });
  await handler({ ...ctx, selection: "f:o:1:0" }); // selección de un paso que no toca

  assert.match(sent.at(-1).content.text, /Nombre/);
});

test("ficha: !fichadestino guarda el JID completo del grupo", async () => {
  const saved = [];
  const handler = await setup(fakeStore({
    destination: () => "",
    setDestination: (jid) => saved.push(jid),
  }));
  // `ctx.phone` llega sin `@g.us` porque el router usa cleanJid().
  const { ctx, sent } = makeCtxWithSender(6, {
    phone: "120363000000000321",
    isCommand: true,
    command: "fichadestino",
  });

  const reply = await handler(ctx);

  assert.deepStrictEqual(saved, ["120363000000000321@g.us"]);
  assert.strictEqual(sent.at(-1).jid, "120363000000000321@g.us");
  assert.match(reply, /Listo/);
});

test("ficha: !fichadestino acepta un JID explícito", async () => {
  const saved = [];
  const handler = await setup(fakeStore({
    destination: () => "",
    setDestination: (jid) => saved.push(jid),
  }));
  const { ctx } = makeCtxWithSender(7, {
    phone: "120363000000000321",
    isCommand: true,
    command: "fichadestino",
    commandBody: "120363000000000555@g.us",
  });

  await handler(ctx);

  assert.deepStrictEqual(saved, ["120363000000000555@g.us"]);
});

// ---- Reparto a varios grupos (!rutas) ----

const EDAD_FIELDS = {
  header: "FICHA EDAD",
  footer: "",
  fields: [
    { label: "Nombre", options: [] },
    { label: "Edad", options: [] },
  ],
};

async function fillFicha(handler, ctx, nombre, edad) {
  await handler({ ...ctx, isCommand: true, command: "ficha" });
  await handler({ ...ctx, text: nombre });
  await handler({ ...ctx, text: edad });
  return handler({ ...ctx, selection: "f:s" });
}

test("ficha: se envía a todos los grupos cuyas condiciones se cumplen", async () => {
  const routes = [
    { name: "teens", jid: "120363000000000111@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "ana", jid: "120363000000000222@g.us", conditions: [{ field: "Nombre", type: "values", values: ["Ana"] }] },
    { name: "adultos", jid: "120363000000000333@g.us", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
  ];
  const handler = await setup(fakeStore({ form: () => EDAD_FIELDS, routes: () => routes }));
  const { ctx, sent } = makeCtxWithSender(31);

  const done = await fillFicha(handler, ctx, "Ana", "17");
  assert.match(done, /2 grupos/);

  const jids = sent.filter((item) => item.jid !== ORIGIN).map((item) => item.jid).sort();
  assert.deepStrictEqual(jids, ["120363000000000111@g.us", "120363000000000222@g.us"]);
});

test("ficha: cae al comodín cuando ninguna condición se cumple", async () => {
  const routes = [
    { name: "adultos", jid: "120363000000000333@g.us", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
    { name: "otros", jid: "120363000000000444@g.us", conditions: [] },
  ];
  const handler = await setup(fakeStore({ form: () => EDAD_FIELDS, routes: () => routes }));
  const { ctx, sent } = makeCtxWithSender(32);

  const done = await fillFicha(handler, ctx, "Ana", "17");
  assert.match(done, /\*otros\*/);

  const jids = sent.filter((item) => item.jid !== ORIGIN).map((item) => item.jid);
  assert.deepStrictEqual(jids, ["120363000000000444@g.us"]);
});
