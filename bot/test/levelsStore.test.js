import { test } from "node:test";
import assert from "node:assert";
import { LevelsStore } from "../src/infrastructure/storage/levelsStore.js";

function makeStore() {
  const store = new LevelsStore();
  store.state = { groups: {}, events: [] };
  return store;
}

test("levelsStore: user() normaliza la jid con cleanJid (misma clave para @, crudo y :device)", () => {
  const store = makeStore();

  const conServer = store.user("G1", "573123456789@s.whatsapp.net");
  const crudo = store.user("G1", "573123456789");
  const conDevice = store.user("G1", "573123456789:8");

  assert.strictEqual(conServer, crudo);
  assert.strictEqual(crudo, conDevice);

  conServer.aura = 5;
  assert.strictEqual(store.user("G1", "573123456789").aura, 5);
  assert.strictEqual(Object.keys(store.state.groups.G1.users).length, 1);
});

test("levelsStore: user() no mezcla grupos distintos", () => {
  const store = makeStore();
  const g1 = store.user("G1", "573123456789@s.whatsapp.net");
  const g2 = store.user("G2", "573123456789@s.whatsapp.net");
  assert.notStrictEqual(g1, g2);
});

test("levelsStore: rankedUsers expone la jid limpia como clave", () => {
  const store = makeStore();
  store.user("G1", "573123456789@s.whatsapp.net").level = 5;
  store.user("G1", "573987654321:s.whatsapp.net:4").level = 2;
  assert.deepStrictEqual(
    store.rankedUsers("G1").map((u) => u.jid),
    ["573123456789", "573987654321"],
  );
});
