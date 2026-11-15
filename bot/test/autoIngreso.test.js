import { test } from "node:test";
import assert from "node:assert";

import {
  DEFAULT_DELAY_MS,
  defaultWelcomeText,
  isGeneral,
  isLobby,
  normalizeConfig,
  onJoinRequest,
  onParticipantsUpdate,
} from "../src/shared/utils/autoIngreso.js";

const LOBBY = "120363000000000001";
const GENERAL = "120363000000000002";
const CONFIG = { lobby: LOBBY, general: GENERAL, delayMs: 15000, enabled: true };
const quiet = { log() {}, warn() {}, error() {} };

test("ingreso: compara los JID de grupo con y sin sufijo", () => {
  assert.ok(isLobby(CONFIG, `${LOBBY}@g.us`));
  assert.ok(isLobby(CONFIG, LOBBY));
  assert.ok(isGeneral(CONFIG, `${GENERAL}@g.us`));
  assert.ok(!isLobby(CONFIG, `${GENERAL}@g.us`));
  assert.ok(!isLobby({ ...CONFIG, enabled: false }, `${LOBBY}@g.us`));
});

test("ingreso: la espera por defecto es de 15 segundos", () => {
  assert.strictEqual(DEFAULT_DELAY_MS, 15000);
  assert.strictEqual(normalizeConfig({}).delayMs, 15000);
});

test("ingreso: aprueba solo el Lobby y el General configurados", async () => {
  const approved = [];
  const removed = [];
  const deps = {
    config: CONFIG,
    approve: async (...args) => approved.push(args),
    removeFromLobby: async (participant) => removed.push(participant),
    logger: quiet,
  };

  await onJoinRequest({ id: `${LOBBY}@g.us`, participant: "a@s.whatsapp.net", action: "created" }, deps);
  await onJoinRequest({ id: `${GENERAL}@g.us`, participant: "b@s.whatsapp.net", action: "created" }, deps);
  await onJoinRequest({ id: "120363000000000999@g.us", participant: "c@s.whatsapp.net", action: "created" }, deps);

  assert.deepStrictEqual(approved.map((call) => call[0]), [`${LOBBY}@g.us`, `${GENERAL}@g.us`]);
  // Al aprobar en General se saca del Lobby.
  assert.deepStrictEqual(removed, ["b@s.whatsapp.net"]);
});

test("ingreso: solicitudes revocadas o rechazadas no se aprueban", async () => {
  let calls = 0;
  const deps = { config: CONFIG, approve: async () => { calls += 1; }, logger: quiet };

  await onJoinRequest({ id: `${LOBBY}@g.us`, participant: "a", action: "revoked" }, deps);
  await onJoinRequest({ id: `${LOBBY}@g.us`, participant: "a", action: "rejected" }, deps);

  assert.strictEqual(calls, 0);
});

test("ingreso: apagado no aprueba ni saluda", async () => {
  const events = [];
  const deps = {
    config: { ...CONFIG, enabled: false },
    approve: async () => events.push("approve"),
    removeFromLobby: async () => events.push("remove"),
    welcome: async () => events.push("welcome"),
    startFicha: async () => events.push("ficha"),
    logger: quiet,
  };

  await onJoinRequest({ id: `${LOBBY}@g.us`, participant: "a", action: "created" }, deps);
  await onParticipantsUpdate({ id: `${LOBBY}@g.us`, action: "add", participants: ["a"] }, deps);

  assert.deepStrictEqual(events, []);
});

test("ingreso: al entrar al Lobby espera, saluda y arranca la ficha", async () => {
  const events = [];
  const deps = {
    config: CONFIG,
    sleepFn: async (ms) => events.push(`sleep:${ms}`),
    welcome: async (jid, participant) => events.push(`welcome:${jid}:${participant}`),
    startFicha: async (jid, participant) => events.push(`ficha:${jid}:${participant}`),
    logger: quiet,
  };

  await onParticipantsUpdate(
    { id: `${LOBBY}@g.us`, action: "add", participants: ["p1@s.whatsapp.net"] },
    deps,
  );

  assert.deepStrictEqual(events, [
    "sleep:15000",
    `welcome:${LOBBY}@g.us:p1@s.whatsapp.net`,
    `ficha:${LOBBY}@g.us:p1@s.whatsapp.net`,
  ]);
});

test("ingreso: un fallo saludando no impide arrancar la ficha", async () => {
  const events = [];
  await onParticipantsUpdate(
    { id: `${LOBBY}@g.us`, action: "add", participants: ["p1"] },
    {
      config: CONFIG,
      sleepFn: async () => {},
      welcome: async () => { throw new Error("sin metadata"); },
      startFicha: async () => events.push("ficha"),
      logger: quiet,
    },
  );

  assert.deepStrictEqual(events, ["ficha"]);
});

test("ingreso: entrar al General (sin solicitud) saca del Lobby", async () => {
  const removed = [];
  await onParticipantsUpdate(
    { id: `${GENERAL}@g.us`, action: "add", participants: ["p1", "p2"] },
    { config: CONFIG, removeFromLobby: async (p) => removed.push(p), logger: quiet },
  );

  assert.deepStrictEqual(removed, ["p1", "p2"]);
});

test("ingreso: promote/demote no disparan nada", async () => {
  const events = [];
  await onParticipantsUpdate(
    { id: `${LOBBY}@g.us`, action: "promote", participants: ["p1"] },
    {
      config: CONFIG,
      sleepFn: async () => events.push("sleep"),
      welcome: async () => events.push("welcome"),
      logger: quiet,
    },
  );

  assert.deepStrictEqual(events, []);
});

test("ingreso: el saludo por defecto menciona a la persona y al grupo", () => {
  const text = defaultWelcomeText({ participant: "573001112233@s.whatsapp.net", groupName: "Lobby" });

  assert.match(text, /@573001112233/);
  assert.match(text, /Lobby/);
  assert.match(text, /ficha/i);
});
