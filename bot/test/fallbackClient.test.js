import { test } from "node:test";
import assert from "node:assert";

import { FallbackClient } from "../src/infrastructure/ai/fallbackClient.js";

function fakeClient({ configured = true, tools = true, chatResult, toolsResult } = {}) {
  const client = {
    calls: 0,
    supportsTools: tools,
    isConfigured: () => configured,
    async chat() {
      client.calls++;
      return chatResult ?? { ok: true, content: "ok", model: "fake" };
    },
    async chatWithTools() {
      client.calls++;
      return toolsResult ?? { ok: true, text: "ok", model: "fake" };
    },
  };
  return client;
}

// Los avisos de rotacion son esperados en estas pruebas; se silencian.
async function quiet(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

function chain(...providers) {
  return new FallbackClient(
    providers.map(([name, client, model]) => ({ name, client, model })),
  );
}

test("fallback: usa el siguiente proveedor si el primero agota la cuota", async () => {
  const gemini = fakeClient({ chatResult: { ok: false, status: 429, error: "quota exceeded" } });
  const nvidia = fakeClient({ chatResult: { ok: true, content: "hola", model: "nemotron" } });
  const client = chain(
    ["gemini", gemini, "gemini-3.5-flash"],
    ["nvidia", nvidia, "nemotron"],
  );

  const result = await quiet(() => client.chat([{ role: "user", content: "hola" }]));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.provider, "nvidia");
  assert.strictEqual(result.model, "nemotron");
  assert.strictEqual(gemini.calls, 1);
  assert.strictEqual(nvidia.calls, 1);
});

test("fallback: el proveedor sin cuota queda en cuarentena y no se reintenta", async () => {
  const gemini = fakeClient({ chatResult: { ok: false, status: 429, error: "quota exceeded" } });
  const nvidia = fakeClient({ chatResult: { ok: true, content: "hola", model: "nemotron" } });
  const client = chain(
    ["gemini", gemini, "gemini-3.5-flash"],
    ["nvidia", nvidia, "nemotron"],
  );

  await quiet(() => client.chat([{ role: "user", content: "uno" }]));
  const second = await quiet(() => client.chat([{ role: "user", content: "dos" }]));

  assert.strictEqual(second.ok, true);
  assert.strictEqual(gemini.calls, 1);
  assert.strictEqual(nvidia.calls, 2);

  const status = client.describe().find((p) => p.name === "gemini");
  assert.strictEqual(status.cooling, true);
});

test("fallback: omite en chatWithTools a quien no soporta herramientas", async () => {
  const gemini = fakeClient({ tools: false, chatResult: { ok: true, content: "sin tools" } });
  const openrouter = fakeClient({ toolsResult: { ok: true, text: "con tools", model: "or" } });
  const client = chain(
    ["gemini", gemini],
    ["openrouter", openrouter],
  );

  const result = await quiet(() =>
    client.chatWithTools({ system: "sys", turns: [{ role: "user", text: "hola" }], tools: [] }),
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.provider, "openrouter");
  assert.strictEqual(gemini.calls, 0);
});

test("fallback: si todos fallan devuelve el ultimo error con su proveedor", async () => {
  const gemini = fakeClient({ chatResult: { ok: false, status: 503, error: "saturado" } });
  const nvidia = fakeClient({ chatResult: { ok: false, status: 500, error: "boom" } });
  const client = chain(
    ["gemini", gemini],
    ["nvidia", nvidia],
  );

  const result = await quiet(() => client.chat([{ role: "user", content: "hola" }]));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.provider, "nvidia");
  assert.strictEqual(result.error, "boom");
});

test("fallback: sin claves configuradas avisa que falta la API key", async () => {
  const gemini = fakeClient({ configured: false });
  const client = chain(["gemini", gemini]);

  assert.strictEqual(client.isConfigured(), false);
  const result = await client.chat([{ role: "user", content: "hola" }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /GEMINI_API_KEY/);
});

test("fallback: con todo en cuarentena igual intenta el primero", async () => {
  let attempt = 0;
  const gemini = {
    calls: 0,
    supportsTools: true,
    isConfigured: () => true,
    async chat() {
      gemini.calls++;
      attempt++;
      if (attempt === 1) return { ok: false, status: 429, error: "quota" };
      return { ok: true, content: "recuperado", model: "gemini-3.5-flash" };
    },
  };
  const client = new FallbackClient([{ name: "gemini", client: gemini, model: "gemini-3.5-flash" }]);

  const first = await quiet(() => client.chat([{ role: "user", content: "uno" }]));
  assert.strictEqual(first.ok, false);

  const second = await quiet(() => client.chat([{ role: "user", content: "dos" }]));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(gemini.calls, 2);
});
