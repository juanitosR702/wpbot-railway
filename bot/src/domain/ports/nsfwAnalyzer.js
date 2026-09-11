/**
 * Port: NsfwAnalyzer
 *
 * Contrato de clasificación NSFW de un buffer de media.
 * Implementado por `infrastructure/nsfw/nsfwDetector.js` (NsfwDetector).
 *
 * analyze(buffer, options) -> Promise<{
 *   score: number, nsfw: boolean, provider: string, reason?: string,
 *   details?: object, skipped?: boolean, cached?: boolean, error?: string,
 * }>
 */
export const NsfwAnalyzer = Object.freeze({
  async analyze() { throw new Error("NsfwAnalyzer.analyze() not implemented"); },
});
