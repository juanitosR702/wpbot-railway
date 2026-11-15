import { test } from "node:test";
import assert from "node:assert";

import { parseFichaText, formSteps } from "../src/shared/utils/fichaForm.js";
import { fichaPlugin } from "../src/interfaces/commands/ficha/index.js";

const GROUP = "120363000000000001@g.us";

test("ficha pegada: reconoce encabezado, campos con secciones y pie", () => {
  const form = parseFichaText(
    [
      "ENCABEZADO: 🐉 FICHA DE INGRESO",
      "CAMPOS",
      "# DATOS DEL INTEGRANTE",
      "Nombre o apodo",
      "Edad",
      "País | Colombia, México, Perú",
      "PIE: Gracias por tu interés.",
    ].join("\n"),
  );

  assert.strictEqual(form.header, "🐉 FICHA DE INGRESO");
  assert.strictEqual(form.footer, "Gracias por tu interés.");

  const labels = form.fields.filter((field) => field.label).map((field) => field.label);
  assert.deepStrictEqual(labels, ["Nombre o apodo", "Edad", "País"]);
  assert.deepStrictEqual(form.fields[0], { section: "DATOS DEL INTEGRANTE" });
  assert.deepStrictEqual(form.fields[3].options, ["Colombia", "México", "Perú"]);
});

test("ficha pegada: sin marcador de encabezado, lo previo a CAMPOS es el título", () => {
  const form = parseFichaText(
    ["🐉 FICHA DE INGRESO", "CAMPOS", "Nombre", "Edad", "PIE: Escribe !ficha"].join("\n"),
  );

  assert.strictEqual(form.header, "🐉 FICHA DE INGRESO");
  assert.strictEqual(form.footer, "Escribe !ficha");
  assert.deepStrictEqual(
    form.fields.map((field) => field.label),
    ["Nombre", "Edad"],
  );
});

test("ficha pegada: sin marcadores todo son campos", () => {
  const form = parseFichaText("Nombre\nEdad\n¿Aceptas las reglas? | Sí, No");

  assert.strictEqual(form.header, "");
  assert.strictEqual(form.footer, "");
  assert.strictEqual(formSteps(form).length, 3);
});

test("ficha pegada: tolera marcadores en la misma línea (lo que manda la IA)", () => {
  const form = parseFichaText(
    "ENCABEZADO: FICHA RÁPIDA CAMPOS Nombre Edad País | Colombia, México PIE: Escribe !ficha",
  );

  // Al venir todo en una línea no se pueden separar los campos: lo importante
  // es que no explote y conserve al menos el encabezado y el pie.
  assert.match(form.header, /FICHA RÁPIDA/);
  assert.match(form.footer, /Escribe !ficha/);
  assert.ok(form.fields.length >= 1);
});

test("ficha pegada: el encabezado puede tener varias líneas", () => {
  const form = parseFichaText(
    ["[ENCABEZADO]", "🐉 GHOST DRAGONS", "✦ FICHA ✦", "[CAMPOS]", "Nombre", "[PIE]", "Suerte"].join("\n"),
  );

  assert.strictEqual(form.header, "🐉 GHOST DRAGONS\n✦ FICHA ✦");
  assert.strictEqual(form.footer, "Suerte");
  assert.deepStrictEqual(form.fields, [{ label: "Nombre", options: [] }]);
});

test("ficha pegada: sin campos explica el error", () => {
  assert.throws(() => parseFichaText("ENCABEZADO: solo esto"), /al menos un campo/);
});

test("ficha pegada: demasiadas opciones se rechazan", () => {
  const options = Array.from({ length: 10 }, (_, index) => `op${index + 1}`).join(", ");
  assert.throws(() => parseFichaText(`Campo | ${options}`), /máximo es 9/);
});

// ---- !setficha importar (carga de una sola vez) ----

function fakeStore() {
  const saved = [];
  return {
    saved,
    form: () => null,
    setForm: (jid, form) => saved.push({ jid, form }),
    clearForm() {},
    destination: () => "",
    ready: async () => {},
    save: async () => {},
  };
}

async function setup(store) {
  let handler = null;
  fichaPlugin.register(
    { register: (fn) => { handler = fn; }, getCommands: () => [], prefix: "!" },
    { store, ownerPolicy: { isCreatorJid: () => false } },
  );
  return handler;
}

function makeCtx(overrides = {}) {
  const sender = "573001112233@s.whatsapp.net";
  const body = String(overrides.commandBody || "");
  const ctx = {
    phone: GROUP,
    sender,
    name: "Ana",
    text: "",
    isGroup: true,
    isCommand: true,
    command: "setficha",
    prefix: "!",
    // El router deriva los args del texto: solo la primera palabra ("importar").
    args: body.trim() ? [body.trim().split(/\s+/)[0]] : [],
    commandBody: "",
    raw: { key: { participant: sender } },
    services: { sendMessage: async () => ({}) },
    getGroupMetadata: async () => ({
      subject: "Clan",
      participants: [{ id: sender, admin: "admin" }],
    }),
    ...overrides,
  };
  ctx.sendMessage = async () => ({ key: { id: "m1" } });
  ctx.sendList = async () => ({ key: { id: "m1" } });
  return ctx;
}

test("setficha: importar guarda la ficha completa de una vez", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(
    makeCtx({
      commandBody: [
        "importar",
        "ENCABEZADO: FICHA DEL CLAN",
        "CAMPOS",
        "# DATOS",
        "Nombre o apodo",
        "Edad",
        "País | Colombia, México",
        "PIE: Gracias",
      ].join("\n"),
    }),
  );

  assert.strictEqual(store.saved.length, 1);
  assert.strictEqual(store.saved[0].jid, GROUP);
  assert.strictEqual(store.saved[0].form.header, "FICHA DEL CLAN");
  assert.match(reply, /Ficha guardada/);
  assert.match(reply, /!lobby filtros/);
  assert.match(reply, /País \| Colombia, México/);

  const country = store.saved[0].form.fields.find((field) => field.label === "País");
  assert.deepStrictEqual(country.options, ["Colombia", "México"]);
});

test("setficha: importar sin texto explica cómo usarlo", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ commandBody: "importar" }));

  assert.strictEqual(store.saved.length, 0);
  assert.match(reply, /Pega la ficha/);
});

test("setficha: importar con un error de formato no guarda nada", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(makeCtx({ commandBody: "importar\nENCABEZADO: solo el título" }));

  assert.strictEqual(store.saved.length, 0);
  assert.match(reply, /al menos un campo/);
});

test("setficha: un miembro normal no puede importar la ficha", async () => {
  const store = fakeStore();
  const handler = await setup(store);

  const reply = await handler(
    makeCtx({
      commandBody: "importar\nNombre",
      getGroupMetadata: async () => ({
        subject: "Clan",
        participants: [{ id: "573001112233@s.whatsapp.net", admin: null }],
      }),
    }),
  );

  assert.strictEqual(store.saved.length, 0);
  assert.match(reply, /admin/i);
});
