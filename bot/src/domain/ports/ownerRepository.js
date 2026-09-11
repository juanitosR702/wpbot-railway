/**
 * Port: OwnerRepository
 *
 * Fuente de verdad de números del creador/bot y objetivos protegidos extra.
 * Implementado por `infrastructure/users/ownerStorage.js` (createOwnerRepository).
 *
 * El dominio (`domain/users/ownerPolicy.js`) y los casos de uso dependen de este
 * contrato; nunca de la implementación concreta ni de `env`/Mongo directamente.
 */
export const OwnerRepository = Object.freeze({
  creatorNumbers() { throw new Error("OwnerRepository.creatorNumbers() not implemented"); },
  botNumbers() { throw new Error("OwnerRepository.botNumbers() not implemented"); },
  creatorJids() { throw new Error("OwnerRepository.creatorJids() not implemented"); },
  botNumberJids() { throw new Error("OwnerRepository.botNumberJids() not implemented"); },
  extraProtectedEntries() { throw new Error("OwnerRepository.extraProtectedEntries() not implemented"); },
  extraProtectedJids() { throw new Error("OwnerRepository.extraProtectedJids() not implemented"); },
  addProtectedTarget(target) { throw new Error("OwnerRepository.addProtectedTarget() not implemented"); },
  removeProtectedTarget(target) { throw new Error("OwnerRepository.removeProtectedTarget() not implemented"); },
});
