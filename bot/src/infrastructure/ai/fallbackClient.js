/**
 * Envoltorio de varios proveedores de IA (Gemini, OpenRouter, NVIDIA...).
 *
 * El primer proveedor de la lista es el principal; si falla por cuota, clave
 * invalida, saturacion o red, se prueba el siguiente. Un proveedor que falla
 * por cuota/clave queda en cuarentena unos minutos para no pagar su latencia
 * en cada mensaje. El resto de errores (por ejemplo un 400 por prompt
 * demasiado largo) tambien rotan: es mas util intentarlo con otro modelo que
 * devolver el error.
 */
const COOLDOWN_STATUSES = new Set([401, 402, 403, 429]);
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

export class FallbackClient {
  constructor(providers = [], { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    this.providers = providers.filter((provider) => provider?.client);
    this.cooldownMs = cooldownMs;
    this._cooldownUntil = new Map();
    this.supportsTools = this.providers.some((provider) => provider.client.supportsTools);
  }

  isConfigured() {
    return this.providers.some((provider) => provider.client.isConfigured());
  }

  /** Cadena completa para `!aistatus`. */
  describe() {
    const now = Date.now();
    return this.providers.map((provider) => ({
      name: provider.name,
      model: provider.model || null,
      configured: Boolean(provider.client.isConfigured()),
      tools: Boolean(provider.client.supportsTools),
      cooling: (this._cooldownUntil.get(provider.name) || 0) > now,
    }));
  }

  async chat(messages) {
    return this._run({
      requireTools: false,
      invoke: (client) => client.chat(messages),
    });
  }

  async chatWithTools(args) {
    return this._run({
      requireTools: true,
      invoke: (client) => client.chatWithTools(args),
    });
  }

  async _run({ requireTools, invoke }) {
    const configured = this.providers.filter((provider) => provider.client.isConfigured());
    if (!configured.length) {
      return { ok: false, error: "Falta GEMINI_API_KEY (o la clave de otro proveedor) en .env." };
    }

    const queue = this._queue(configured, requireTools);
    let last = null;

    for (const provider of queue) {
      let result;
      try {
        result = await invoke(provider.client);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }

      if (result?.ok) {
        this._cooldownUntil.delete(provider.name);
        return {
          ...result,
          provider: provider.name,
          model: result.model || provider.model || null,
        };
      }

      last = { ...(result || {}), ok: false, provider: provider.name };
      this._maybeCool(provider.name, last);
      if (queue.length > 1) {
        console.warn(
          `[ai] Proveedor "${provider.name}" fallo (${describeFailure(last)}); probando el siguiente.`,
        );
      }
    }

    return last || { ok: false, error: "Ningun proveedor de IA respondio." };
  }

  /**
   * Proveedores disponibles en orden. Si todos estan en cuarentena se prueba
   * igual el que sale antes, para no quedarse mudo por un bloqueo temporal.
   */
  _queue(configured, requireTools) {
    const now = Date.now();
    const candidates = configured.filter((provider) => {
      if (requireTools && !provider.client.supportsTools) return false;
      return (this._cooldownUntil.get(provider.name) || 0) <= now;
    });
    if (candidates.length) return candidates;

    const usable = configured.filter((provider) => !requireTools || provider.client.supportsTools);
    const pool = usable.length ? usable : configured;
    return pool.slice(0, 1);
  }

  _maybeCool(name, result) {
    const status = Number(result?.status || 0);
    const message = String(result?.error || "");
    if (
      COOLDOWN_STATUSES.has(status) ||
      /quota|cuota|rate.?limit|credit|unauthorized|invalid api key|api key/i.test(message)
    ) {
      this._cooldownUntil.set(name, Date.now() + this.cooldownMs);
    }
  }
}

function describeFailure(result) {
  if (result?.status) return `HTTP ${result.status}`;
  const message = String(result?.error || "sin detalle");
  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}
