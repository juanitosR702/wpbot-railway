import test from "node:test";
import assert from "node:assert/strict";

import {
  createLobbyFlow,
  groupJid,
  inviteUrl,
  isExemptParticipant,
} from "../src/shared/utils/lobbyFlow.js";
import { DEFAULT_FICHA, validateFichaValues } from "../src/shared/utils/fichaForm.js";
import { lobbyPlugin } from "../src/interfaces/commands/lobby/index.js";

const LOBBY = "111111111111@g.us";
const GENERAL = "222222222222@g.us";
const USER = "777777777777@s.whatsapp.net";

function fakeStore(overrides = {}) {
  const state = {
    enabled: true,
    lobbyJid: LOBBY,
    generalJid: GENERAL,
    welcomeDelayMs: 0,
    generalCode: "CODE1",
    generalCodeAt: 0,
    greeted: {},
    submitted: {},
    ...overrides,
  };

  return {
    state,
    config() {
      return { ...state, greeted: { ...state.greeted }, submitted: { ...state.submitted } };
    },
    markGreeted(jid) {
      state.greeted[jid] = 1;
    },
    wasGreeted(jid) {
      return Boolean(state.greeted[jid]);
    },
    markSubmitted(jid) {
      state.submitted[jid] = 1;
    },
    wasSubmitted(jid) {
      return Boolean(state.submitted[jid]);
    },
    setGeneralCode(code, at = 1) {
      state.generalCode = code;
      state.generalCodeAt = at;
    },
    async save() {},
  };
}

function metadataFor(jid, participants = []) {
  return { id: jid, subject: jid === LOBBY ? "Lobby" : "General", participants };
}

function createFlow(options = {}) {
  const calls = { approve: [], reject: [], remove: [], messages: [], ficha: [], revoke: 0 };
  const store = options.store || fakeStore();
  const metadata = options.metadata || {
    [LOBBY]: metadataFor(LOBBY, [{ id: USER, admin: null }]),
    [GENERAL]: metadataFor(GENERAL, [{ id: USER, admin: null }]),
  };

  const flow = createLobbyFlow({
    store,
    ownerPolicy: options.ownerPolicy || { isProtectedJid: () => false },
    sendMessage: async (jid, content) => {
      calls.messages.push({ jid, content });
    },
    getGroupMetadata: async (jid) => metadata[jid] || null,
    approve: async (jid, participants) => {
      calls.approve.push({ jid, participants });
    },
    reject: async (jid, participants) => {
      calls.reject.push({ jid, participants });
    },
    listRequests: async (jid) => options.pending?.[jid] || [],
    removeParticipants: async (jid, participants) => {
      calls.remove.push({ jid, participants });
    },
    inviteCode: async () => "CODE1",
    revokeInvite: async () => {
      calls.revoke += 1;
      return "CODE2";
    },
    startFicha: async (jid, participant) => {
      calls.ficha.push({ jid, participant });
    },
    delay: async () => {},
    now: () => options.now ?? 1_000_000,
    logger: { log() {}, warn() {}, error() {} },
    botJid: () => "999999999999@s.whatsapp.net",
  });

  return { flow, calls, store };
}

test("lobby: helpers de link y JID de grupo", () => {
  assert.equal(inviteUrl("ABC123"), "https://chat.whatsapp.com/ABC123");
  assert.equal(inviteUrl("https://chat.whatsapp.com/XYZ"), "https://chat.whatsapp.com/XYZ");
  assert.equal(inviteUrl(""), "");
  assert.equal(groupJid("123456789012"), "123456789012@g.us");
  assert.equal(groupJid("123456789012@g.us"), "123456789012@g.us");
});

test("lobby: aprueba la solicitud de entrada al lobby", async () => {
  const { flow, calls } = createFlow();
  const result = await flow.handleJoinRequest({ id: LOBBY, participant: USER, action: "created" });

  assert.equal(result.approved, true);
  assert.deepEqual(calls.approve, [{ jid: LOBBY, participants: [USER] }]);
  assert.equal(calls.reject.length, 0);
});

test("lobby: rechaza general si la persona no envió ficha y avisa por privado", async () => {
  const { flow, calls } = createFlow();
  const result = await flow.handleJoinRequest({ id: GENERAL, participant: USER, action: "created" });

  assert.equal(result.approved, false);
  assert.equal(result.reason, "sin-ficha");
  assert.deepEqual(calls.reject, [{ jid: GENERAL, participants: [USER] }]);
  assert.equal(calls.approve.length, 0);
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0].content.text, /todavía no puedo aceptarte/i);
  assert.equal(calls.messages[0].jid, USER);
});

test("lobby: aprueba general cuando la ficha ya fue enviada", async () => {
  const store = fakeStore({ submitted: { "777777777777": 1 } });
  const { flow, calls } = createFlow({ store });
  const result = await flow.handleJoinRequest({ id: GENERAL, participant: USER, action: "created" });

  assert.equal(result.approved, true);
  assert.deepEqual(calls.approve, [{ jid: GENERAL, participants: [USER] }]);
  assert.equal(calls.reject.length, 0);
});

test("lobby: los admins no pasan por el filtro de ficha", async () => {
  const { flow, calls } = createFlow({
    metadata: {
      [LOBBY]: metadataFor(LOBBY, [{ id: USER, admin: "admin" }]),
      [GENERAL]: metadataFor(GENERAL, [{ id: USER, admin: "admin" }]),
    },
  });

  const result = await flow.handleJoinRequest({ id: GENERAL, participant: USER, action: "created" });

  assert.equal(result.approved, true);
  assert.equal(calls.reject.length, 0);
});

test("lobby: saluda con demora y arranca la ficha; no repite si el evento se duplica", async () => {
  const { flow, calls, store } = createFlow();

  await flow.handleParticipantsUpdate({ id: LOBBY, action: "add", participants: [USER] });
  await flow.handleParticipantsUpdate({ id: LOBBY, action: "add", participants: [USER] });

  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].jid, LOBBY);
  assert.match(calls.messages[0].content.text, /Bienvenido/);
  assert.deepEqual(calls.messages[0].content.mentions, [USER]);
  assert.deepEqual(calls.ficha, [{ jid: LOBBY, participant: USER }]);
  assert.equal(store.wasGreeted("777777777777"), true);
});

test("lobby: no saluda a un admin del grupo", async () => {
  const { flow, calls } = createFlow({
    metadata: {
      [LOBBY]: metadataFor(LOBBY, [{ id: USER, admin: "superadmin" }]),
      [GENERAL]: metadataFor(GENERAL, [{ id: USER, admin: null }]),
    },
  });

  await flow.handleParticipantsUpdate({ id: LOBBY, action: "add", participants: [USER] });

  assert.equal(calls.messages.length, 0);
  assert.equal(calls.ficha.length, 0);
});

test("lobby: al entrar a general expulsa del lobby y restablece el link", async () => {
  const { flow, calls, store } = createFlow();

  await flow.handleParticipantsUpdate({ id: GENERAL, action: "add", participants: [USER] });

  assert.deepEqual(calls.remove, [{ jid: LOBBY, participants: [USER] }]);
  assert.equal(calls.revoke, 1);
  assert.equal(store.state.generalCode, "CODE2");
});

test("lobby: nunca expulsa a un admin del lobby", async () => {
  const { flow, calls } = createFlow({
    metadata: {
      [LOBBY]: metadataFor(LOBBY, [{ id: USER, admin: "admin" }]),
      [GENERAL]: metadataFor(GENERAL, [{ id: USER, admin: null }]),
    },
  });

  await flow.handleParticipantsUpdate({ id: GENERAL, action: "add", participants: [USER] });

  assert.equal(calls.remove.length, 0);
});

test("lobby: al enviar la ficha marca submitted y manda el link por privado", async () => {
  const { flow, calls, store } = createFlow();

  const extra = await flow.onFichaSubmitted({ phone: "111111111111", sender: USER, name: "Ana" });

  assert.equal(store.wasSubmitted("777777777777"), true);
  assert.match(extra, /link del grupo general por privado/);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].jid, USER);
  assert.match(calls.messages[0].content.text, /https:\/\/chat\.whatsapp\.com\/CODE1/);
});

test("lobby: la ficha enviada en otro grupo no dispara el flujo", async () => {
  const { flow, calls, store } = createFlow();
  const extra = await flow.onFichaSubmitted({ phone: "333333333333", sender: USER });

  assert.equal(extra, "");
  assert.equal(calls.messages.length, 0);
  assert.equal(store.wasSubmitted("777777777777"), false);
});

test("lobby: si la ficha no cumple los filtros recibe una excusa, no el link", async () => {
  const fichaGroup = "444444444444@g.us";
  const { flow, calls, store } = createFlow({
    store: fakeStore({ minAge: 18, countries: ["Colombia"] }),
  });

  const extra = await flow.onFichaSubmitted(
    { phone: "111111111111", sender: USER },
    {
      store: { destination: () => fichaGroup },
      session: { form: DEFAULT_FICHA, values: { 1: "Ana", 2: "17", 4: "Perú" } },
    },
  );

  // No se marca como fichada: si pide entrar al general, se rechaza.
  assert.equal(store.wasSubmitted("777777777777"), false);

  // Recibe una excusa creíble y nunca el link del grupo general.
  assert.doesNotMatch(extra, /chat\.whatsapp\.com/);
  assert.doesNotMatch(extra, /edad|país|inicial/i);
  assert.match(extra, /revisión|espera|Ficha recibida/);

  // Solo hay un mensaje: el aviso para los admins en el grupo de fichas.
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].jid, fichaGroup);
  assert.match(calls.messages[0].content.text, /No cumple los filtros: edad, país/);
});

test("lobby: si la ficha cumple los filtros sí recibe el link", async () => {
  const { flow, calls, store } = createFlow({
    store: fakeStore({ minAge: 18, countries: ["Colombia"], initials: ["A"] }),
  });

  const extra = await flow.onFichaSubmitted(
    { phone: "111111111111", sender: USER },
    { session: { form: DEFAULT_FICHA, values: { 1: "Ana María", 2: "tengo 22 años", 4: "colombia" } } },
  );

  assert.equal(store.wasSubmitted("777777777777"), true);
  assert.match(extra, /link del grupo general por privado/);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].jid, USER);
  assert.match(calls.messages[0].content.text, /CODE1/);
});

test("lobby: la excusa propia se usa cuando la ficha no cumple", async () => {
  const { flow } = createFlow({
    store: fakeStore({ minAge: 18, excuse: "Estamos llenos, vuelve en enero." }),
  });

  const extra = await flow.onFichaSubmitted(
    { phone: "111111111111", sender: USER },
    { session: { form: DEFAULT_FICHA, values: { 1: "Ana", 2: "15", 4: "Colombia" } } },
  );

  assert.equal(extra, "Estamos llenos, vuelve en enero.");
});

test("lobby: con filtros activos el rechazo al general usa la misma excusa", async () => {
  const { flow, calls } = createFlow({
    store: fakeStore({ minAge: 18, excuse: "Estamos llenos, vuelve en enero." }),
  });

  await flow.handleJoinRequest({ id: GENERAL, participant: USER, action: "created" });

  // La solicitud se rechaza y el privado no delata que la ficha existió.
  assert.equal(calls.reject.length, 1);
  const dm = calls.messages.find((message) => message.jid === USER);
  assert.equal(dm.content.text, "Estamos llenos, vuelve en enero.");
  assert.doesNotMatch(dm.content.text, /ficha/i);
});

test("lobby: el creador/protegido queda exento aunque no sea admin del grupo", () => {
  const exempt = isExemptParticipant(USER, {
    ownerPolicy: { isProtectedJid: (jid) => jid === USER },
    metadataList: [metadataFor(LOBBY, [{ id: USER, admin: null }])],
  });

  assert.equal(exempt, true);
});

test("ficha: valida edad, campos vacíos y el \"No\" en las reglas", () => {
  const values = {
    1: "Ana",
    2: "9",
    3: "ana",
    4: "Colombia",
    6: "Activo/a",
    7: "Quiero entrar",
    9: "No",
  };

  const result = validateFichaValues(DEFAULT_FICHA, values);

  assert.equal(result.ok, false);
  assert.equal(result.firstIndex, 2);
  assert.ok(result.errors.some((error) => /13 y 99/.test(error.message)));
  assert.ok(result.errors.some((error) => /responderse que sí/.test(error.message)));
});

test("ficha: una ficha completa y válida pasa la revisión", () => {
  const values = {
    1: "Ana",
    2: "22",
    3: "ana",
    4: "Colombia",
    6: "Activo/a",
    7: "Quiero entrar al clan",
    9: "Sí",
  };

  const result = validateFichaValues(DEFAULT_FICHA, values);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("ficha: un campo vacío se reporta con su índice", () => {
  const result = validateFichaValues(DEFAULT_FICHA, { 1: "Ana" });

  assert.equal(result.ok, false);
  assert.equal(result.firstIndex, 2);
  assert.match(result.errors[0].message, /Edad/);
});

// ---- Plugin `!lobby` ----

function fakeLobbyStore(overrides = {}) {
  const state = {
    enabled: true,
    lobbyJid: "",
    generalJid: "",
    welcomeDelayMs: 5000,
    generalCode: "",
    generalCodeAt: 0,
    minAge: 0,
    countries: [],
    initials: [],
    excuse: "",
    greeted: {},
    submitted: {},
    ...overrides,
  };

  return {
    state,
    config() {
      return { ...state };
    },
    setEnabled(value) {
      state.enabled = value;
    },
    setLobby(jid) {
      state.lobbyJid = jid;
    },
    setGeneral(jid) {
      state.generalJid = jid;
    },
    setWelcomeDelay(ms) {
      state.welcomeDelayMs = ms;
    },
    setGeneralCode(code) {
      state.generalCode = code;
    },
    setMinAge(years) {
      state.minAge = years;
    },
    setCountries(list) {
      state.countries = list;
    },
    setInitials(list) {
      state.initials = list.map((item) => String(item).toUpperCase());
    },
    setExcuse(text) {
      state.excuse = text;
    },
    async ready() {},
    async save() {},
  };
}

function lobbyCtx({ args = [], admin = true, commandBody = "" } = {}) {
  const metadata = {
    id: "111111111111@g.us",
    subject: "Lobby",
    participants: [
      { id: USER, admin: admin ? "admin" : null },
      { id: "999999999999@s.whatsapp.net", admin: "admin" },
    ],
  };

  return {
    isGroup: true,
    isCommand: true,
    command: "lobby",
    args,
    commandBody,
    phone: "111111111111",
    prefix: "!",
    sender: admin ? "999999999999" : USER,
    raw: {},
    botJid: "999999999999@s.whatsapp.net",
    getGroupMetadata: async () => metadata,
    services: { inviteCode: async () => "CODE1", getGroupMetadata: async () => metadata },
  };
}

async function runLobbyPlugin(ctx, store, policyOverrides = {}) {
  let handler = null;
  lobbyPlugin.register({ register: (fn) => { handler = fn; } }, {
    store,
    ownerPolicy: {
      isCreatorJid: () => false,
      isBotAdmin: async () => true,
      isProtectedJid: () => false,
      ...policyOverrides,
    },
  });
  return handler(ctx);
}

test("lobby: el comando rechaza a quien no es admin", async () => {
  const store = fakeLobbyStore();
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["aqui", "lobby"], admin: false }), store);

  assert.match(reply, /admin/i);
  assert.equal(store.state.lobbyJid, "");
});

test("lobby: registra el grupo actual como lobby", async () => {
  const store = fakeLobbyStore();
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["aqui", "lobby"] }), store);

  assert.equal(store.state.lobbyJid, "111111111111@g.us");
  assert.match(reply, /lobby/);
});

test("lobby: registra el general y guarda su código de invitación", async () => {
  const store = fakeLobbyStore();
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["aqui", "general"] }), store);

  assert.equal(store.state.generalJid, "111111111111@g.us");
  assert.equal(store.state.generalCode, "CODE1");
  assert.match(reply, /chat\.whatsapp\.com\/CODE1/);
});

test("lobby: la demora se guarda en milisegundos", async () => {
  const store = fakeLobbyStore();
  await runLobbyPlugin(lobbyCtx({ args: ["demora", "8"] }), store);

  assert.equal(store.state.welcomeDelayMs, 8000);
});

test("lobby: !lobby ver muestra el estado del flujo", async () => {
  const store = fakeLobbyStore({ lobbyJid: LOBBY, generalJid: GENERAL });
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["ver"] }), store);

  assert.match(reply, /Lobby automático/);
  assert.match(reply, /Lobby: 111111111111@g\.us/);
  assert.match(reply, /General: 222222222222@g\.us/);
  assert.match(reply, /Soy admin: lobby ✅ · general ✅/);
});

test("lobby: !lobby edad configura la edad mínima y se puede quitar", async () => {
  const store = fakeLobbyStore();

  const reply = await runLobbyPlugin(lobbyCtx({ args: ["edad", "18"] }), store);
  assert.equal(store.state.minAge, 18);
  assert.match(reply, /18 años o más/);

  const off = await runLobbyPlugin(lobbyCtx({ args: ["edad", "off"] }), store);
  assert.equal(store.state.minAge, 0);
  assert.match(off, /desactivado/);
});

test("lobby: !lobby edad rechaza valores inválidos", async () => {
  const store = fakeLobbyStore();
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["edad", "abc"] }), store);

  assert.equal(store.state.minAge, 0);
  assert.match(reply, /edad mínima/);
});

test("lobby: !lobby paises guarda la lista separada por comas", async () => {
  const store = fakeLobbyStore();
  const reply = await runLobbyPlugin(lobbyCtx({ args: ["paises", "Colombia,", "México"] }), store);

  assert.deepEqual(store.state.countries, ["Colombia", "México"]);
  assert.match(reply, /Colombia, México/);
});

test("lobby: !lobby iniciales acepta letras sueltas o pegadas", async () => {
  const store = fakeLobbyStore();

  await runLobbyPlugin(lobbyCtx({ args: ["iniciales", "A", "M"] }), store);
  assert.deepEqual(store.state.initials, ["A", "M"]);

  await runLobbyPlugin(lobbyCtx({ args: ["iniciales", "AM"] }), store);
  assert.deepEqual(store.state.initials, ["A", "M"]);

  const off = await runLobbyPlugin(lobbyCtx({ args: ["iniciales", "off"] }), store);
  assert.deepEqual(store.state.initials, []);
  assert.match(off, /desactivado/);
});

test("lobby: !lobby excusa guarda, exige texto y se puede restablecer", async () => {
  const store = fakeLobbyStore();

  const empty = await runLobbyPlugin(lobbyCtx({ args: ["excusa"] }), store);
  assert.match(empty, /Escribe la excusa/);
  assert.equal(store.state.excuse, "");

  await runLobbyPlugin(lobbyCtx({ args: ["excusa"], commandBody: "excusa Estamos llenos." }), store);
  assert.equal(store.state.excuse, "Estamos llenos.");

  const reset = await runLobbyPlugin(
    lobbyCtx({ args: ["excusa", "reset"], commandBody: "excusa reset" }),
    store,
  );
  assert.equal(store.state.excuse, "");
  assert.match(reset, /por defecto/);
});

test("lobby: !lobby filtros resume la configuración", async () => {
  const store = fakeLobbyStore({
    minAge: 18,
    countries: ["Colombia"],
    initials: ["A"],
  });

  const reply = await runLobbyPlugin(lobbyCtx({ args: ["filtros"] }), store);

  assert.match(reply, /edad ≥ 18/);
  assert.match(reply, /Colombia/);
  assert.match(reply, /A/);
  assert.match(reply, /lobby edad/);
});

test("lobby: !lobby filtros configura todo de una sola vez", async () => {
  const store = fakeLobbyStore();

  const reply = await runLobbyPlugin(
    lobbyCtx({
      args: ["filtros", "edad=18;", "paises=Colombia,", "México;", "iniciales=A", "M;", "excusa=Estamos", "llenos."],
      commandBody: "filtros edad=18; paises=Colombia, México; iniciales=A M; excusa=Estamos llenos.",
    }),
    store,
  );

  assert.equal(store.state.minAge, 18);
  assert.deepEqual(store.state.countries, ["Colombia", "México"]);
  assert.deepEqual(store.state.initials, ["A", "M"]);
  assert.equal(store.state.excuse, "Estamos llenos.");
  assert.match(reply, /Filtros actualizados/);
  assert.match(reply, /edad ≥ 18/);
});

test("lobby: !lobby filtros acepta saltos de línea y solo cambia lo que pide", async () => {
  const store = fakeLobbyStore({ minAge: 21, excuse: "Cupo lleno." });

  await runLobbyPlugin(
    lobbyCtx({
      args: ["filtros", "paises=Colombia"],
      commandBody: "filtros\npaises=Colombia\niniciales=M J",
    }),
    store,
  );

  assert.equal(store.state.minAge, 21);
  assert.deepEqual(store.state.countries, ["Colombia"]);
  assert.deepEqual(store.state.initials, ["M", "J"]);
  assert.equal(store.state.excuse, "Cupo lleno.");
});

test("lobby: !lobby filtros off quita los filtros y reset limpia la excusa", async () => {
  const store = fakeLobbyStore({
    minAge: 18,
    countries: ["Colombia"],
    initials: ["A"],
    excuse: "Estamos llenos.",
  });

  const off = await runLobbyPlugin(
    lobbyCtx({ args: ["filtros", "off"], commandBody: "filtros off" }),
    store,
  );

  assert.equal(store.state.minAge, 0);
  assert.deepEqual(store.state.countries, []);
  assert.deepEqual(store.state.initials, []);
  assert.equal(store.state.excuse, "Estamos llenos.");
  assert.match(off, /desactivad|desactivados/);

  await runLobbyPlugin(lobbyCtx({ args: ["filtros", "reset"], commandBody: "filtros reset" }), store);
  assert.equal(store.state.excuse, "");
});

test("lobby: !lobby filtros rechaza una edad inválida sin tocar nada", async () => {
  const store = fakeLobbyStore({ minAge: 18 });

  const reply = await runLobbyPlugin(
    lobbyCtx({ args: ["filtros", "edad=abc"], commandBody: "filtros edad=abc" }),
    store,
  );

  assert.equal(store.state.minAge, 18);
  assert.match(reply, /no es válida/);
});

test("lobby: !lobby filtros avisa cuando no reconoce nada", async () => {
  const store = fakeLobbyStore();

  const reply = await runLobbyPlugin(
    lobbyCtx({ args: ["filtros", "xyz"], commandBody: "filtros xyz" }),
    store,
  );

  assert.match(reply, /No entendí/);
});
