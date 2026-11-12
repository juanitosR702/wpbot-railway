import OpenAI from "openai";

export class OpenaiClient {
  constructor(config) {
    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      timeout: config.timeoutMs,
    });
    this.config = config;
    this.supportsTools = true;
  }

  isConfigured() {
    return Boolean(this.config.openaiApiKey);
  }

  async chat(messages) {
    const openaiMessages = messages.map(m => ({
      role: m.role === "model" ? "assistant" : m.role,
      content: m.content || m.parts?.[0]?.text || "",
    }));

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.openaiModel,
        messages: openaiMessages,
        temperature: this.config.openaiTemperature,
        max_tokens: this.config.openaiMaxTokens,
      });

      return {
        ok: true,
        content: completion.choices?.[0]?.message?.content || "",
        usage: completion.usage ? {
          promptTokenCount: completion.usage.prompt_tokens,
          candidatesTokenCount: completion.usage.completion_tokens,
          totalTokenCount: completion.usage.total_tokens,
        } : null,
        model: this.config.openaiModel,
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err), status: err.status };
    }
  }

  async chatWithTools({ system, turns, tools, temperature, maxTokens }) {
    const messages = [{ role: "system", content: system }];

    for (const turn of turns) {
      if (turn.functionCall) {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: turn.functionCall.id || `call_${messages.length}`,
            type: "function",
            function: {
              name: turn.functionCall.name,
              arguments: JSON.stringify(turn.functionCall.args || {}),
            },
          }],
        });
        continue;
      }

      if (turn.functionResponse) {
        messages.push({
          role: "tool",
          tool_call_id: turn.functionResponse.id || `call_${messages.length - 1}`,
          content: JSON.stringify(turn.functionResponse.response ?? {}),
        });
        continue;
      }

      messages.push({
        role: turn.role === "model" ? "assistant" : "user",
        content: String(turn.text || ""),
      });
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.openaiModel,
        messages,
        ...(tools?.length
          ? { tools: tools.map((tool) => ({ type: "function", function: tool })), tool_choice: "auto" }
          : {}),
        temperature: temperature ?? this.config.openaiTemperature,
        max_tokens: maxTokens ?? this.config.openaiMaxTokens,
      });

      const message = completion.choices?.[0]?.message;
      const call = message?.tool_calls?.[0];

      return {
        ok: true,
        text: (message?.content || "").trim(),
        functionCall: call
          ? {
              id: call.id,
              name: call.function?.name,
              args: safeJson(call.function?.arguments),
            }
          : null,
        usage: completion.usage
          ? {
              promptTokenCount: completion.usage.prompt_tokens,
              candidatesTokenCount: completion.usage.completion_tokens,
              totalTokenCount: completion.usage.total_tokens,
            }
          : null,
        model: this.config.openaiModel,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        status: err.status,
        unsupportedTools: err.status === 400 || err.status === 404 || err.status === 422,
      };
    }
  }
}

function safeJson(value) {
  if (!value) return {};
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}
