export class GeminiClient {
  constructor(config) {
    this.config = config;
    this.supportsTools = true;
  }

  isConfigured() {
    return Boolean(this.config.apiKey);
  }

  /**
   * POST a `:generateContent`. Si Google retira el modelo configurado, su
   * error trae el nombre del reemplazo ("use models/gemini-3.8-flash"); en ese
   * caso reintenta una vez con ese modelo y lo recuerda en memoria.
   */
  async _generate(body) {
    const attempt = async (model) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const base = this.config.apiUrl.replace(/\/$/, "");
        const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
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

    try {
      let result = await attempt(this.config.model);
      if (!result.response.ok) {
        const suggested = suggestedModel(result.data);
        if (suggested && suggested !== this.config.model) {
          console.warn(
            `[ai] El modelo "${this.config.model}" no esta disponible; reintentando con "${suggested}".`,
          );
          this.config.model = suggested;
          result = await attempt(suggested);
        }
      }

      const { response, data } = result;
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: data?.error?.message || data?.message || `Gemini respondio HTTP ${response.status}`,
        };
      }
      return { ok: true, data };
    } catch (err) {
      const error = err?.name === "AbortError" ? "Timeout consultando Gemini." : err?.message || "Error consultando Gemini.";
      return { ok: false, error };
    }
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
    const call = parts.find((part) => part?.functionCall)?.functionCall || null;
    const text = parts
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();

    return {
      ok: true,
      text,
      functionCall: call ? { name: call.name, args: call.args || {} } : null,
      usage: result.data?.usageMetadata || null,
      model: this.config.model,
    };
  }
}

// Extrae el modelo que Google sugiere cuando retira el actual. Si el error no
// trae una alternativa, devuelve null y no se reintenta.
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

function toGeminiTurn(turn) {
  if (turn.functionResponse) {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: turn.functionResponse.name,
          response: turn.functionResponse.response ?? {},
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
        },
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
