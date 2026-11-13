export class GeminiClient {
  constructor(config) {
    this.config = config;
    this.supportsTools = true;
    // Modelos retirados por Google (definitivo) y modelos con cuota diaria
    // agotada (temporal, con la hora de reintento que informa la API).
    this._invalidModels = new Set();
    this._cooldownUntil = new Map();
  }

  isConfigured() {
    return Boolean(this.config.apiKey);
  }

  _isCooling(model) {
    const until = this._cooldownUntil.get(model) || 0;
    if (until > Date.now()) return true;
    this._cooldownUntil.delete(model);
    return false;
  }

  _cool(model, data) {
    const ms = retryAfterMs(data) ?? 60 * 60 * 1000;
    this._cooldownUntil.set(model, Date.now() + ms);
  }

  _nextCooldownMs() {
    const now = Date.now();
    let next = 0;
    for (const until of this._cooldownUntil.values()) {
      if (until > now && (!next || until - now < next)) next = until - now;
    }
    return next;
  }

  /**
   * POST a `:generateContent`. Google retira modelos, a veces los nuevos estan
   * saturados (503 "high demand") y la cuota gratuita es por modelo y por dia
   * (429 RESOURCE_EXHAUSTED). Se prueba el modelo configurado y, si no puede,
   * el que sugiere el error o uno de la lista de respaldo.
   */
  async _generate(body) {
    const deadline = Date.now() + this.config.timeoutMs;
    const tried = new Set();

    const queue = [];
    const addCandidate = (model) => {
      if (model && !queue.includes(model) && !tried.has(model)) queue.push(model);
    };
    addCandidate(this.config.model);
    FALLBACK_MODELS.forEach(addCandidate);

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

    let lastError = null;
    let attempts = 0;

    while (queue.length && attempts < MAX_ATTEMPTS) {
      const model = queue.shift();
      if (!model || tried.has(model) || this._invalidModels.has(model)) continue;
      if (this._isCooling(model)) continue;

      tried.add(model);
      attempts++;

      let result;
      try {
        result = await attempt(model);
      } catch (err) {
        const error = err?.name === "AbortError" ? "Timeout consultando Gemini." : err?.message || "Error consultando Gemini.";
        return { ok: false, error };
      }
      if (result.timedOut) return { ok: false, error: "Timeout consultando Gemini." };

      const { response, data } = result;
      if (response.ok) return { ok: true, data, model };

      lastError = {
        ok: false,
        status: response.status,
        error: data?.error?.message || data?.message || `Gemini respondio HTTP ${response.status}`,
      };

      const suggested = suggestedModel(data);
      if (suggested && suggested !== model) {
        this._invalidModels.add(model);
        console.warn(`[ai] El modelo "${model}" ya no esta disponible; usando "${suggested}".`);
        if (model === this.config.model) this.config.model = suggested;
        // Se adelanta el sugerido (aunque ya este en la lista de respaldo)
        // para no gastar intentos en modelos peores.
        const suggestedIndex = queue.indexOf(suggested);
        if (suggestedIndex !== -1) queue.splice(suggestedIndex, 1);
        queue.unshift(suggested);
        continue;
      }

      if (isQuotaExhausted(data)) {
        this._cool(model, data);
        console.warn(`[ai] Cuota agotada para "${model}"; probando otro modelo.`);
        continue;
      }

      if (isUnavailable(data)) {
        console.warn(
          `[ai] Modelo "${model}" no disponible (${data?.error?.status || response.status}); probando otro.`,
        );
        continue;
      }

      break;
    }

    if (lastError) return lastError;

    const waitMs = this._nextCooldownMs();
    return {
      ok: false,
      error: waitMs
        ? `Cuota gratuita de Gemini agotada; reintenta en ~${Math.ceil(waitMs / 60000)} min.`
        : "Ningun modelo de Gemini respondio.",
    };
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
      model: result.model || this.config.model,
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
      model: result.model || this.config.model,
    };
  }
}

// Orden de respaldo si el modelo configurado no responde (3.5 es el mas
// estable hoy; los 3.6+ suelen dar 503 "high demand" al lanzarse y la cuota
// gratuita es por modelo, asi que el lite sirve de segunda opcion).
const FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
];
const MAX_ATTEMPTS = 3;

// 503 / "high demand" / "overloaded" son transitorios y valen otro modelo.
function isUnavailable(data) {
  const status = String(data?.error?.status || "");
  const message = String(data?.error?.message || "");
  return (
    status === "UNAVAILABLE" ||
    /high demand|overloaded|temporarily unavailable|try again later|no longer available/i.test(message)
  );
}

// Cuota diaria agotada. La cuota gratuita de Gemini es POR MODELO, asi que
// cambiar de modelo (3.5 -> 3.1 lite -> ...) suele devolver el servicio.
function isQuotaExhausted(data) {
  const status = String(data?.error?.status || "");
  const message = String(data?.error?.message || "");
  return (
    status === "RESOURCE_EXHAUSTED" ||
    /exceeded your current quota|quota exceeded|rate limit|rate.?limits|per day limit/i.test(message)
  );
}

// La API dice "Please retry in 13h28m39.5s". Lo usamos para no volver a
// intentar ese modelo hasta que se renueve la cuota.
function retryAfterMs(data) {
  const message = String(data?.error?.message || "");
  const match = message.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
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
