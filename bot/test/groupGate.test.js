import { test } from "node:test";
import assert from "node:assert";

import { Router } from "../src/interfaces/bot/router.js";
import { GROUP_MODULES, GROUP_CONFIG_COMMANDS, resolveModule } from "../src/shared/config/modules.js";

function message(text, jid = "120363000000@g.us") {
  return {
    key: { remoteJid: jid, participant: "111@s.whatsapp.net", fromMe: false },
    message: { extendedTextMessage: { text } },
  };
}

test("gate: con el bot apagado no responde nada", async () => {
  const router = new Router();
  const calls = [];
  router.registerPlugin(
    { name: "economy", register: (api) => api.register((ctx) => { calls.push(ctx.command); return "pong"; }) },
    {},
  );
  router.setGroupGate(async () => ({ disabled: true, allows: () => false }));

  const reply = await router.route(message("!daily"), {});
  assert.strictEqual(reply, null);
  assert.deepStrictEqual(calls, []);
});

test("gate: los comandos de configuracion siguen pasando con el bot apagado", async () => {
  const router = new Router();
  router.registerPlugin(
    { name: "group_admin", register: (api) => api.register(() => "encendido") },
    {},
  );
  router.setGroupGate(async (ctx) => {
    const isConfigCommand = ctx.isCommand && GROUP_CONFIG_COMMANDS.includes(ctx.command);
    const disabled = !isConfigCommand;
    return {
      disabled,
      allows: (plugin) => (isConfigCommand ? plugin === "group_admin" : !disabled),
    };
  });

  assert.strictEqual(await router.route(message("!bot on"), {}), "encendido");
  assert.strictEqual(await router.route(message("!daily"), {}), null);
});

test("gate: un modulo desactivado no contesta, los demas si", async () => {
  const router = new Router();
  router.registerPlugin(
    { name: "economy", register: (api) => api.register((ctx) => (ctx.command === "daily" ? "coins" : null)) },
    {},
  );
  router.registerPlugin(
    { name: "levels", register: (api) => api.register((ctx) => (ctx.command === "level" ? "nivel" : null)) },
    {},
  );
  const blocked = new Set(["economy"]);
  router.setGroupGate(async () => ({
    disabled: false,
    allows: (plugin) => !blocked.has(plugin),
  }));

  assert.strictEqual(await router.route(message("!daily"), {}), null);
  assert.strictEqual(await router.route(message("!level"), {}), "nivel");
});

test("gate: sin gate el router funciona igual que antes", async () => {
  const router = new Router();
  router.registerPlugin({ name: "economy", register: (api) => api.register(() => "coins") }, {});
  assert.strictEqual(await router.route(message("!daily"), {}), "coins");
});

test("modulos: resuelve clave, plugin y etiqueta", () => {
  assert.strictEqual(resolveModule("economia").plugin, "economy");
  assert.strictEqual(resolveModule("economy").plugin, "economy");
  assert.strictEqual(resolveModule("Economía").plugin, "economy");
  assert.strictEqual(resolveModule("niveles").plugin, "levels");
  assert.strictEqual(resolveModule("no-existe"), null);
  assert.ok(GROUP_MODULES.some((module) => module.plugin === "ai"));
});
