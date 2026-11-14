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
    async ready() {},
    async save() {},
  };
}

function lobbyCtx({ args = [], admin = true } = {}) {
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
