import { test } from "node:test";
import assert from "node:assert";

import { GeminiClient } from "../src/infrastructure/ai/geminiClient.js";

function makeClient(overrides = {}) {
  return new GeminiClient({
    apiKey: "test-key",
    apiUrl: "https://example.test/v1beta",
    model: "gemini-2.5-flash",
    temperature: 0.4,
    maxTokens: 100,
    timeoutMs: 5000,
    systemPrompt: "sys",
    ...overrides,
  });
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("gemini: reintenta con el modelo sugerido cuando retiran el actual", async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      if (url.includes("gemini-2.5-flash")) {
        return jsonResponse(404, {
          error: {
            message:
              "This model models/gemini-2.5-flash is no longer available to new users. " +
              "Please update your code to use models/gemini-3.8-flash for the latest features and improvements.",
          },
        });
      }
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "hola" }] } }] });
    },
    async () => {
      const ai = makeClient();
      const result = await ai.chat([{ role: "user", content: "que tal" }]);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, "hola");
      assert.strictEqual(result.model, "gemini-3.8-flash");
      assert.strictEqual(urls.length, 2);
      assert.ok(urls[1].includes("gemini-3.8-flash"));
      assert.strictEqual(ai.config.model, "gemini-3.8-flash");
    },
  );
});

test("gemini: chatWithTools tambien usa el modelo sugerido", async () => {
  await withFetch(
    async (url) =>
      url.includes("gemini-2.5-flash")
        ? jsonResponse(400, {
            error: { message: "This model is no longer available. Please use models/gemini-3.8-flash." },
          })
        : jsonResponse(200, { candidates: [{ content: { parts: [{ text: "listo" }] } }] }),
    async () => {
      const ai = makeClient();
      const result = await ai.chatWithTools({ system: "sys", turns: [{ role: "user", text: "hola" }] });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.text, "listo");
      assert.strictEqual(result.model, "gemini-3.8-flash");
    },
  );
});

test("gemini: si el modelo esta saturado (503) usa uno de respaldo", async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      if (url.includes("gemini-3.8-flash")) {
        return jsonResponse(503, {
          error: { status: "UNAVAILABLE", message: "This model is currently experiencing high demand." },
        });
      }
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    },
    async () => {
      const ai = makeClient({ model: "gemini-3.8-flash" });
      const result = await ai.chat([{ role: "user", content: "hola" }]);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.model, "gemini-3.5-flash");
      assert.strictEqual(urls.length, 2);
      assert.ok(urls[1].includes("gemini-3.5-flash"));
      // El modelo principal no cambia: el respaldo es solo para esta peticion.
      assert.strictEqual(ai.config.model, "gemini-3.8-flash");
    },
  );
});

test("gemini: si se agota la cuota de un modelo, usa otro y lo recuerda", async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      if (url.includes("gemini-3.5-flash")) {
        return jsonResponse(429, {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message:
              "You exceeded your current quota. Quota exceeded for metric: " +
              "generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash. " +
              "Please retry in 13h28m39s.",
          },
        });
      }
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    },
    async () => {
      const ai = makeClient({ model: "gemini-3.5-flash" });
      const first = await ai.chat([{ role: "user", content: "hola" }]);

      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.model, "gemini-3.1-flash-lite");
      assert.strictEqual(urls.length, 2);
      assert.ok(urls[1].includes("gemini-3.1-flash-lite"));
      assert.strictEqual(ai.config.model, "gemini-3.5-flash");

      const before = urls.length;
      const second = await ai.chat([{ role: "user", content: "otra" }]);
      assert.strictEqual(second.ok, true);
      // 3.5 quedo en cuarentena por cuota: va directo al lite.
      assert.strictEqual(urls.length, before + 1);
      assert.ok(urls.at(-1).includes("gemini-3.1-flash-lite"));
    },
  );
});

test("gemini: conserva el thoughtSignature de los functionCall", async () => {
  await withFetch(
    async () =>
      jsonResponse(200, {
        candidates: [{
          content: {
            parts: [{ functionCall: { name: "ping", args: { texto: "hola" } }, thoughtSignature: "SIG123" }],
          },
        }],
      }),
    async () => {
      const ai = makeClient({ model: "gemini-3.5-flash" });
      const result = await ai.chatWithTools({
        system: "sys",
        turns: [{ role: "user", text: "usa ping" }],
        tools: [{ name: "ping", description: "d", parameters: { type: "object" } }],
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.functionCall.name, "ping");
      assert.strictEqual(result.functionCall.thoughtSignature, "SIG123");
    },
  );
});

test("gemini: devuelve el thoughtSignature al reenviar el functionCall", async () => {
  let request = null;
  await withFetch(
    async (url, init) => {
      request = JSON.parse(init.body);
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "listo" }] } }] });
    },
    async () => {
      const ai = makeClient({ model: "gemini-3.5-flash" });
      const result = await ai.chatWithTools({
        system: "sys",
        turns: [
          { role: "user", text: "usa ping" },
          { role: "model", functionCall: { name: "ping", args: { texto: "hola" }, thoughtSignature: "SIG123" } },
          { role: "user", functionResponse: { name: "ping", response: { ok: true } } },
        ],
        tools: [{ name: "ping", description: "d", parameters: { type: "object" } }],
      });

      assert.strictEqual(result.ok, true);
      const callPart = request.contents[1].parts[0];
      assert.strictEqual(callPart.functionCall.name, "ping");
      assert.strictEqual(callPart.thoughtSignature, "SIG123");
    },
  );
});

test("gemini: no reintenta con errores que no son de cuota ni de modelo", async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      return jsonResponse(403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
    },
    async () => {
      const ai = makeClient();
      const result = await ai.chat([{ role: "user", content: "hola" }]);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 403);
      assert.strictEqual(urls.length, 1);
      assert.strictEqual(ai.config.model, "gemini-2.5-flash");
    },
  );
});
