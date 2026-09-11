/**
 * Port: AiClient
 *
 * Contrato de un cliente LLM para chat. Implementado por
 * `infrastructure/ai/geminiClient.js` y `infrastructure/ai/openaiClient.js`.
 *
 * chat(messages) -> Promise<{
 *   ok: boolean, content?: string, model?: string, usage?: object,
 *   error?: string, status?: number,
 * }>
 */
export const AiClient = Object.freeze({
  isConfigured() { throw new Error("AiClient.isConfigured() not implemented"); },
  async chat() { throw new Error("AiClient.chat() not implemented"); },
});
