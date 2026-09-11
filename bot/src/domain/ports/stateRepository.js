/**
 * Port: StateRepository
 *
 * Contrato de un repositorio de estado persistente (una colección de MongoDB
 * con un único documento `{_id: "state"}`). Implementado por los adapters de
 * `infrastructure/storage/*.js` (subclases de BaseStore).
 *
 * Los casos de uso (interfaces/commands) dependen de este contrato, no de la
 * clase concreta del store.
 */
export const StateRepository = Object.freeze({
  async ready() { throw new Error("StateRepository.ready() not implemented"); },
  async save() { throw new Error("StateRepository.save() not implemented"); },
});
