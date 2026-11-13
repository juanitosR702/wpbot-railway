export class GeminiClient {
  constructor(config) {
    this.config = config;
    this.supportsTools = true;
  }

  isConfigured() {
    return Boolean(this.config.apiKey);
  }

  /**
   * POST a `:generateContent`. Google retira modelos y a veces los nuevos
   * están saturados (503 "high demand"), así que si el modelo configurado
   * falla se prueba el que sugiere el propio error o uno de la lista de
   * respaldo. El que funcione se recuerda en memoria (`config.model`).
   */
  async _generate(body) {
    const deadline = Date.now() + this.config.timeoutMs;
    const tried = new Set();
    let model = this.config.model;

    const attempt = async (target) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { timedOut: true };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const base = this.config.apiUrl.replace(/\/$/, "");
        const url = `${base}/models/${encodeURIComponent(target)}:generateContent`;
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "x-goog-api-key": this.config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        return { response, data };
      } finally {
        clearTimeout(timer);
      }
    };

    for (let i = 0; i < MAX_ATTEMPTS && model && !tried.has(model); i++) {
      tried.add(model);

      let result;
      try {
        result = await attempt(model);
      } catch (err) {
        const error = err?.name === "AbortError" ? "Timeout consultando Gemini." : err?.message || "Error consultando Gemini.";
        return { ok: false, error };
      }
      if (result.timedOut) return { ok: false, error: "Timeout consultando Gemini." };

      const { response, data } = result;
      if (response.ok) {
        if (model !== this.config.model) {
          console.warn(`[ai] El modelo "${this.config.model}" no respondio; usando "${model}".`);
          this.config.model = model;
        }
        return { ok: true, data };
      }

      const next = nextModel(model, data, tried);
      if (!next) {
        return {
          ok: false,
          status: response.status,
          error: data?.error?.message || data?.message || `Gemini respondio HTTP ${response.status}`,
        };
      }
      console.warn(
        `[ai] Modelo "${model}" no disponible (${data?.error?.status || response.status}); probando "${next}".`,
      );
      model = next;
    }

    return { ok: false, error: `Ningun modelo de Gemini respondio (probados: ${[...tried].join(", ")}).` };
  }

  async chat(messages) {
    if (!this.isConfigured()) {
      return { ok: false, error: "Falta GEMINI_API_KEY en .env." };
    }

    const system = messages.find((message) => message.role === "system")?.content || this.config.systemPrompt;
    const contents = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" || message.role === "model" ? "model" : "user",
        parts: [{ text: message.content }],
      }));

    const result = await this._generate({
      system_instruction: {
        parts: [{ text: system }],
      },
      contents,
      generationConfig: {
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxTokens,
      },
    });
    if (!result.ok) return result;

    const content = normalizeContent(result.data?.candidates?.[0]?.content?.parts);
    if (!content) return { ok: false, error: "Gemini no devolvio contenido." };

    return {
      ok: true,
      content,
      usage: result.data?.usageMetadata || null,
      model: this.config.model,
    };
  }

  /**
   * Conversación con function calling.
   * turns: [{ role: "user", text }, { role: "model", functionCall: { id, name, args } },
   *         { role: "user", functionResponse: { id, name, response } }]
   * Devuelve texto final o la llamada a herramienta que pide el modelo.
   */
  async chatWithTools({ system, turns, tools, temperature, maxTokens }) {
    if (!this.isConfigured()) {
      return { ok: false, error: "Falta GEMINI_API_KEY en .env." };
    }

    const result = await this._generate({
      system_instruction: { parts: [{ text: system }] },
      contents: turns.map(toGeminiTurn),
      ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(toGeminiTool) }] } : {}),
      generationConfig: {
        temperature: temperature ?? this.config.temperature,
        maxOutputTokens: maxTokens ?? this.config.maxTokens,
      },
    });
    if (!result.ok) return result;

    const parts = result.data?.candidates?.[0]?.content?.parts || [];
    const callPart = parts.find((part) => part?.functionCall) || null;
    const call = callPart?.functionCall || null;
    // Gemini 3 exige devolver el `thoughtSignature` junto al functionCall en el
    // siguiente turno; si se pierde, responde "Function call is missing a
    // thought_signature in functionCall parts".
    const thoughtSignature =
      signatureOf(callPart) || parts.map(signatureOf).find(Boolean) || null;
    const text = parts
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();

    return {
      ok: true,
      text,
      functionCall: call
        ? {
            name: call.name,
            args: call.args || {},
            id: call.id || null,
            thoughtSignature,
          }
        : null,
      usage: result.data?.usageMetadata || null,
      model: this.config.model,
    };
  }
}

// Orden de respaldo si el modelo configurado no responde (3.5 es el mas
// estable hoy; los 3.6+ suelen dar 503 "high demand" al lanzarse).
const FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
];
const MAX_ATTEMPTS = 3;

// Siguiente modelo a probar: el que sugiere Google si retiro el actual, o uno
// de la lista de respaldo si esta saturado. null = no reintentar.
function nextModel(current, data, tried) {
  const suggested = suggestedModel(data);
  if (suggested && suggested !== current && !tried.has(suggested)) return suggested;
  if (isUnavailable(data)) return FALLBACK_MODELS.find((model) => !tried.has(model)) || null;
  return null;
}

// 503 / "high demand" / "overloaded" son transitorios y valen otro modelo.
function isUnavailable(data) {
  const status = String(data?.error?.status || "");
  const message = String(data?.error?.message || "");
  return (
    status === "UNAVAILABLE" ||
    /high demand|overloaded|temporarily unavailable|try again later|no longer available/i.test(message)
  );
}

// Extrae el modelo que Google sugiere cuando retira el actual. Si el error no
// trae una alternativa, devuelve null y no se reintenta por esa via.
function suggestedModel(data) {
  const message = String(data?.error?.message || data?.message || "");
  const match =
    message.match(/use models\/([A-Za-z0-9._-]+)/i) ||
    message.match(/model[^.]*?\bmodels\/([A-Za-z0-9._-]+)/i);
  return match ? match[1].replace(/[.,;:]+$/, "") : null;
}

// Gemini usa enums en mayusculas (OBJECT, STRING...) y no acepta JSON Schema
// completo. Convertimos el esquema neutro que define el plugin.
function toGeminiTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  };
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const result = { ...schema };
  if (typeof result.type === "string") result.type = result.type.toUpperCase();
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
  }
  if (result.items) result.items = toGeminiSchema(result.items);
  return result;
}

function signatureOf(part) {
  return part?.thoughtSignature || part?.thought_signature || null;
}

function toGeminiTurn(turn) {
  if (turn.functionResponse) {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: turn.functionResponse.name,
          response: turn.functionResponse.response ?? {},
          ...(turn.functionResponse.id ? { id: turn.functionResponse.id } : {}),
        },
      }],
    };
  }

  if (turn.functionCall) {
    return {
      role: "model",
      parts: [{
        functionCall: {
          name: turn.functionCall.name,
          args: turn.functionCall.args ?? {},
          ...(turn.functionCall.id ? { id: turn.functionCall.id } : {}),
        },
        // Obligatorio en Gemini 3: se devuelve la firma tal cual vino.
        ...(turn.functionCall.thoughtSignature
          ? { thoughtSignature: turn.functionCall.thoughtSignature }
          : {}),
      }],
    };
  }

  return {
    role: turn.role === "model" || turn.role === "assistant" ? "model" : "user",
    parts: [{ text: String(turn.text || "") }],
  };
}

function normalizeContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || "";
    })
    .join("")
    .trim();
}
