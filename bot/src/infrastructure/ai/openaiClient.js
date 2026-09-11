import OpenAI from "openai";

export class OpenaiClient {
  constructor(config) {
    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      timeout: config.timeoutMs,
    });
    this.config = config;
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
}
