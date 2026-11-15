import { test } from "node:test";
import assert from "node:assert";

import { ingresoPlugin } from "../src/interfaces/commands/ingreso/index.js";

const LOBBY = "120363000000000001";
const GENERAL = "120363000000000002";

function fakeStore(initial = {}) {
  const state = {
    lobby: "",
    general: "",
    delayMs: 15000,
    enabled: false,
    minAge: 0,
    countries: [],
    initials: [],
    excuse: "",
    ...initial,
  };
  return {
    state,
    ready: async () => {},
    save: async () => {},
    config: () => ({
      ...state,
      countries: [...state.countries],
      initials: [...state.initials],
    }),
    setLobby: (value) => { state.lobby = value; },
    setGeneral: (value) => { state.general = value; },
    setDelay: (value) => { state.delayMs = value; },
    setEnabled: (value) => { state.enabled = value; },
    setMinAge: (value) => { state.minAge = value; },
    setCountries: (value) => { state.countries = value; },
    setInitials: (value) => { state.initials = value.map((item) => String(item).toUpperCase()); },
    setExcuse: (value) => { state.excuse = value; },
    reset: () => Object.assign(state, {
      lobby: "",
      general: "",
      delayMs: 15000,
      enabled: false,
      minAge: 0,
      countries: [],
      initials: [],
      excuse: "",
    }),
  };
}

async function setup(store, { inviteLink } = {}) {
  let handler = null;
  const api = { register: (fn) => { handler = fn; }, getCommands: () => [], prefix: "!" };
  ingresoPlugin.register(api, {
    store,
    ownerPolicy: { isCreatorJid: () => false, isBotAdmin: async () => true },
    inviteLink: inviteLink || (async (jid) => `https://chat.whatsapp.com/${jid.split("@")[0]}`),
  });
  assert.ok(handler, "el plugin debe registrar un handler");
  return handler;
}

function makeCtx({ phone = LOBBY, args = [], admin = true } = {}) {
  return {
    isGroup: true,
    isCommand: true,
    command: "ingreso",
    args,
    commandBody: args.join(" "),
    phone,
    sender: "573001112233",
    name: "Admin",
    text: "",
    selection: null,
    raw: { key: { participant: "573001112233@s.whatsapp.net" } },
    getGroupMetadata: async () => ({
      subject: "Grupo",
      participants: [{ id: "573001112233@s.whatsapp.net", admin: admin ? "admin" : null }],
    }),
  };
}

test("ingreso: !ingreso ver muestra el estado y la espera", async () => {
  const handler = await setup(fakeStore({ lobby: LOBBY, general: GENERAL, delayMs: 15000, enabled: true }));

  const reply = await handler(makeCtx());

  assert.match(reply, /Ingreso automático/);
  assert.match(reply, /activo/);
  assert.match(reply, /15 s/);
  assert.match(reply, new RegExp(LOBBY));
  assert.match(reply, new RegExp(GENERAL));
});

test("ingreso: !ingreso lobby guarda el grupo actual", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["lobby"] }));

  assert.strictEqual(store.state.lobby, LOBBY);
  assert.match(reply, /Lobby/);
});

test("ingreso: !ingreso general guarda el grupo actual", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  await handler(makeCtx({ phone: GENERAL, args: ["general"] }));

  assert.strictEqual(store.state.general, GENERAL);
});

test("ingreso: !ingreso delay acepta segundos y rechaza basura", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const ok = await handler(makeCtx({ args: ["delay", "30"] }));
  assert.strictEqual(store.state.delayMs, 30000);
  assert.match(ok, /30 s/);

  const bad = await handler(makeCtx({ args: ["delay", "abc"] }));
  assert.strictEqual(store.state.delayMs, 30000);
  assert.match(bad, /segundos/);
});

test("ingreso: no se activa sin Lobby y General configurados", async () => {
  const store = fakeStore({ lobby: LOBBY });
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["on"] }));

  assert.strictEqual(store.state.enabled, false);
  assert.match(reply, /!ingreso general/);
});

test("ingreso: !ingreso on activa el flujo cuando está todo configurado", async () => {
  const store = fakeStore({ lobby: LOBBY, general: GENERAL });
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["on"] }));

  assert.strictEqual(store.state.enabled, true);
  assert.match(reply, /activado/i);
  assert.match(reply, /15 s/);
});

test("ingreso: !ingreso off y reset", async () => {
  const store = fakeStore({ lobby: LOBBY, general: GENERAL, delayMs: 30000, enabled: true });
  const handler = await setup(store);

  assert.match(await handler(makeCtx({ args: ["off"] })), /desactivado/);
  assert.strictEqual(store.state.enabled, false);

  await handler(makeCtx({ args: ["reset"] }));
  assert.deepStrictEqual(
    { lobby: store.state.lobby, general: store.state.general, enabled: store.state.enabled },
    { lobby: "", general: "", enabled: false },
  );
});

test("ingreso: !ingreso link manda el enlace del grupo general", async () => {
  const handler = await setup(fakeStore({ lobby: LOBBY, general: GENERAL }));

  const reply = await handler(makeCtx({ args: ["link"] }));

  assert.match(reply, new RegExp(`https://chat\\.whatsapp\\.com/${GENERAL}`));
});

test("ingreso: !ingreso link avisa si no hay enlace", async () => {
  const handler = await setup(fakeStore({ lobby: LOBBY, general: GENERAL }), { inviteLink: async () => "" });

  const reply = await handler(makeCtx({ args: ["link"] }));

  assert.match(reply, /No pude generar el enlace/);
});

test("ingreso: !ingreso edad configura la edad mínima y se puede quitar", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["edad", "18"] }));
  assert.strictEqual(store.state.minAge, 18);
  assert.match(reply, /18 años o más/);

  store.state.minAge = 18;
  const off = await handler(makeCtx({ args: ["edad", "off"] }));
  assert.strictEqual(store.state.minAge, 0);
  assert.match(off, /desactivado/);
});

test("ingreso: !ingreso edad rechaza valores inválidos", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["edad", "abc"] }));

  assert.strictEqual(store.state.minAge, 0);
  assert.match(reply, /edad mínima/);
});

test("ingreso: !ingreso paises guarda la lista separada por comas", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["paises", "Colombia,", "México"] }));

  assert.deepStrictEqual(store.state.countries, ["Colombia", "México"]);
  assert.match(reply, /Colombia, México/);
});

test("ingreso: !ingreso iniciales acepta letras sueltas o pegadas", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  await handler(makeCtx({ args: ["iniciales", "A", "M"] }));
  assert.deepStrictEqual(store.state.initials, ["A", "M"]);

  await handler(makeCtx({ args: ["iniciales", "AM"] }));
  assert.deepStrictEqual(store.state.initials, ["A", "M"]);

  const off = await handler(makeCtx({ args: ["iniciales", "off"] }));
  assert.deepStrictEqual(store.state.initials, []);
  assert.match(off, /desactivado/);
});

test("ingreso: !ingreso excusa guarda, exige texto y se puede restablecer", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const empty = await handler(makeCtx({ args: ["excusa"] }));
  assert.match(empty, /Escribe la excusa/);
  assert.strictEqual(store.state.excuse, "");

  await handler(makeCtx({ args: ["excusa", "Estamos", "llenos."] }));
  assert.strictEqual(store.state.excuse, "Estamos llenos.");

  const reset = await handler(makeCtx({ args: ["excusa", "reset"] }));
  assert.strictEqual(store.state.excuse, "");
  assert.match(reset, /por defecto/);
});

test("ingreso: !ingreso filtros resume la configuración", async () => {
  const handler = await setup(fakeStore({
    lobby: LOBBY,
    general: GENERAL,
    minAge: 18,
    countries: ["Colombia"],
    initials: ["A"],
  }));

  const reply = await handler(makeCtx({ args: ["filtros"] }));

  assert.match(reply, /edad ≥ 18/);
  assert.match(reply, /Colombia/);
  assert.match(reply, /A/);
  assert.match(reply, /!ingreso edad/);
});

test("ingreso: un miembro normal no puede configurar", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ args: ["on"], admin: false }));

  assert.strictEqual(store.state.enabled, false);
  assert.ok(typeof reply === "string" && reply.length > 0);
});

test("ingreso: fuera de un grupo no responde", async () => {
  const handler = await setup(fakeStore());

  const reply = await handler({ ...makeCtx(), isGroup: false });

  assert.ok(typeof reply === "string" && reply.length > 0);
});
