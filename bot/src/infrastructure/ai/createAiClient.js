import { FallbackClient } from "./fallbackClient.js";

/**
 * Arma la cadena de proveedores de IA.
 *
 * - `AI_PROVIDER=openai` conserva el comportamiento antiguo (un solo cliente
 *   OpenAI-compatible con `OPENAI_*`).
 * - Por defecto: Gemini (principal) -> OpenRouter -> NVIDIA. Los tramos sin
 *   clave se omiten, asi que con solo `GEMINI_API_KEY` todo sigue igual.
 */
export async function createAiClient(config) {
  const providers = [];

  if (config.provider === "openai") {
    const OpenaiClient = await importOpenaiClient();
    if (OpenaiClient) {
      providers.push({ name: "openai", model: config.openaiModel, client: new OpenaiClient(config) });
    }
    return new FallbackClient(providers);
  }

  const { GeminiClient } = await import("./geminiClient.js");
  providers.push({ name: "gemini", model: config.model, client: new GeminiClient(config) });

  if (config.openrouterApiKey) {
    const OpenaiClient = await importOpenaiClient();
    if (OpenaiClient) {
      providers.push({
        name: "openrouter",
        model: config.openrouterModel,
        client: new OpenaiClient(
          openaiConfig(config, {
            apiKey: config.openrouterApiKey,
            baseUrl: config.openrouterBaseUrl,
            model: config.openrouterModel,
          }),
        ),
      });
    }
  }

  if (config.nvidiaApiKey) {
    const OpenaiClient = await importOpenaiClient();
    if (OpenaiClient) {
      providers.push({
        name: "nvidia",
        model: config.nvidiaModel,
        client: new OpenaiClient(
          openaiConfig(config, {
            apiKey: config.nvidiaApiKey,
            baseUrl: config.nvidiaBaseUrl,
            model: config.nvidiaModel,
          }),
        ),
      });
    }
  }

  return new FallbackClient(providers);
}

// `OpenaiClient` reutiliza los campos `openai*` del config; para cada
// proveedor OpenAI-compatible se clonan con su clave/URL/modelo.
function openaiConfig(config, { apiKey, baseUrl, model }) {
  return {
    ...config,
    openaiApiKey: apiKey,
    openaiBaseUrl: baseUrl,
    openaiModel: model,
    openaiTemperature: config.temperature,
    openaiMaxTokens: config.maxTokens,
    timeoutMs: config.fallbackTimeoutMs,
  };
}

// `openai` puede no estar instalado en un checkout local incompleto: sin el
// paquete simplemente se omite ese tramo en vez de romper toda la IA.
async function importOpenaiClient() {
  try {
    const { OpenaiClient } = await import("./openaiClient.js");
    return OpenaiClient;
  } catch (err) {
    console.warn(`[ai] Sin cliente OpenAI-compatible (${err?.message || err}); se omite ese tramo.`);
    return null;
  }
}
