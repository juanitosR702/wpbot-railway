import { test } from "node:test";
import assert from "node:assert";

import {
  DEFAULT_FICHA,
  FICHA_PRESETS,
  MAX_LIST_OPTIONS,
  formSteps,
  parseFieldLines,
  renderFicha,
  renderFormConfig,
  rowTitle,
} from "../src/shared/utils/fichaForm.js";

test("ficha: la ficha por defecto pide datos, actividad y compromiso", () => {
  const steps = formSteps(DEFAULT_FICHA);

  assert.strictEqual(steps.length, 7);
  assert.strictEqual(steps[0].field.label, "Nombre o apodo");
  assert.deepStrictEqual(
    DEFAULT_FICHA.fields.filter((field) => field.section).map((field) => field.section),
    ["DATOS DEL INTEGRANTE", "UN POCO SOBRE TI", "COMPROMISO"],
  );
  const country = steps.find((step) => step.field.label === "País").field;
  assert.ok(country.options.includes("Colombia"));
});

test("ficha: el preset de GHOST DRAGONS trae la ficha completa", () => {
  const preset = FICHA_PRESETS.dragon;

  assert.match(preset.header, /🐉/);
  assert.match(preset.header, /FICHA DE INGRESO/);
  assert.match(preset.footer, /Una sola unión, una sola lealtad/);
  assert.strictEqual(formSteps(preset).length, 7);
  assert.ok(formSteps(preset).some((step) => step.field.options.length > 0));

  const text = renderFicha(preset, { 1: "Ana", 9: "Sí" });
  assert.match(text, /🐉/);
  assert.match(text, /• Nombre o apodo: Ana/);
  assert.match(text, /Una sola unión, una sola lealtad/);
});

test("ficha: parsea secciones, texto libre y desplegables", () => {
  const fields = parseFieldLines([
    "# DATOS",
    "Nombre",
    "País | Colombia, México , Colombia",
    "",
    "# COMPROMISO",
    "¿Aceptas? | Sí, No",
  ].join("\n"));

  assert.deepStrictEqual(fields[0], { section: "DATOS" });
  assert.deepStrictEqual(fields[1], { label: "Nombre", options: [] });
  // Se recortan espacios y se quitan opciones repetidas.
  assert.deepStrictEqual(fields[2], { label: "País", options: ["Colombia", "México"] });
  assert.deepStrictEqual(fields[3], { section: "COMPROMISO" });
  assert.deepStrictEqual(fields[4], { label: "¿Aceptas?", options: ["Sí", "No"] });
});

test("ficha: rechaza un desplegable con demasiadas opciones", () => {
  const options = Array.from({ length: MAX_LIST_OPTIONS + 1 }, (_, i) => `Opción ${i + 1}`);
  assert.throws(
    () => parseFieldLines(`País | ${options.join(", ")}`),
    /máximo es 9/,
  );
});

test("ficha: exige al menos un campo", () => {
  assert.throws(() => parseFieldLines("# SOLO UNA SECCIÓN"), /al menos un campo/);
});

test("ficha: renderiza encabezado, secciones, valores y pie", () => {
  const text = renderFicha(DEFAULT_FICHA, {
    1: "Ana",
    2: "22",
    3: "anita",
    4: "Colombia",
    6: "Activo/a",
    7: "Quiero entrar",
    9: "Sí",
  });

  assert.ok(text.startsWith("✦ FICHA DE INGRESO ✦"));
  assert.match(text, /✦ \*DATOS DEL INTEGRANTE\*/);
  assert.match(text, /• Nombre o apodo: Ana/);
  assert.match(text, /• Edad: 22/);
  assert.match(text, /✦ \*COMPROMISO\*/);
  assert.match(text, /• ¿Aceptas las reglas del clan\?: Sí/);
  assert.ok(text.trim().endsWith(DEFAULT_FICHA.footer));
});

test("ficha: los valores faltantes se muestran como guion y el remitente se menciona", () => {
  const text = renderFicha(
    { header: "Test", fields: [{ label: "Nombre", options: [] }], footer: "" },
    {},
    { senderNumber: "573001112233", senderName: "Ana", groupName: "Clan", date: "13/11/2026" },
  );

  assert.match(text, /• Nombre: —/);
  assert.match(text, /👤 Enviado por: @573001112233 \(Ana\)/);
  assert.match(text, /🏷 Grupo: Clan/);
  assert.match(text, /🕒 13\/11\/2026/);
});

test("ficha: el resumen de configuración se puede volver a pegar", () => {
  const text = renderFormConfig({
    header: "Encabezado",
    fields: [
      { section: "DATOS" },
      { label: "Nombre", options: [] },
      { label: "País", options: ["Colombia", "Otro"] },
    ],
    footer: "Pie",
  });

  assert.match(text, /# DATOS/);
  assert.match(text, /Nombre$/m);
  assert.match(text, /País \| Colombia, Otro/);
});

test("ficha: los títulos de fila se recortan al límite de WhatsApp", () => {
  assert.strictEqual(rowTitle("Colombia"), "Colombia");
  const long = rowTitle("Una opción absurdamente larguísima");
  assert.ok(long.length <= 24);
  assert.ok(long.endsWith("…"));
});
