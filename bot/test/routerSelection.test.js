import { test } from "node:test";
import assert from "node:assert";

import { Router } from "../src/interfaces/bot/router.js";

function capture(router) {
  const state = { ctx: null };
  router.register(async (ctx) => {
    state.ctx = ctx;
    return null;
  });
  return state;
}

test("router: convierte una respuesta de lista en ctx.selection", async () => {
  const router = new Router({ prefix: "!" });
  const state = capture(router);

  await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: { listResponseMessage: { singleSelectReply: { selectedRowId: "f:o:1:2" } } },
  }, {});

  assert.ok(state.ctx);
  assert.strictEqual(state.ctx.selection, "f:o:1:2");
  assert.strictEqual(state.ctx.text, "");
  assert.strictEqual(state.ctx.isCommand, false);
});

test("router: acepta botones y plantillas como selección", async () => {
  const router = new Router({ prefix: "!" });
  const state = capture(router);

  await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: { buttonsResponseMessage: { selectedButtonId: "f:s" } },
  }, {});
  assert.strictEqual(state.ctx.selection, "f:s");

  await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: { templateButtonReplyMessage: { selectedId: "f:e" } },
  }, {});
  assert.strictEqual(state.ctx.selection, "f:e");
});

test("router: acepta una respuesta nativa (single_select) como selección", async () => {
  const router = new Router({ prefix: "!" });
  const state = capture(router);

  await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: {
          name: "single_select",
          paramsJson: JSON.stringify({ id: "f:o:1:2" }),
        },
      },
    },
  }, {});

  assert.strictEqual(state.ctx.selection, "f:o:1:2");
  assert.strictEqual(state.ctx.text, "");
});

test("router: un paramsJson roto no rompe el mensaje", async () => {
  const router = new Router({ prefix: "!" });
  const state = capture(router);

  const reply = await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: "{no-json" },
      },
    },
  }, {});

  // Sin id legible ni texto, el mensaje se descarta (no hay contexto).
  assert.strictEqual(reply, null);
  assert.strictEqual(state.ctx, null);
});

test("router: un mensaje de texto normal no trae selección", async () => {
  const router = new Router({ prefix: "!" });
  const state = capture(router);

  await router.route({
    key: { remoteJid: "1203@g.us", participant: "57300@s.whatsapp.net" },
    message: { conversation: "hola" },
  }, {});

  assert.strictEqual(state.ctx.selection, null);
  assert.strictEqual(state.ctx.text, "hola");
  assert.strictEqual(state.ctx.isCommand, false);
});
