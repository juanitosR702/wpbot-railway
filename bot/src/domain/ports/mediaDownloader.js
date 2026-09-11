/**
 * Port: MediaDownloader
 *
 * Contrato de descarga de audio (búsqueda por nombre o URL directa).
 * Implementado por `infrastructure/youtube/downloader.js` (YouTubeDownloader).
 */
export const MediaDownloader = Object.freeze({
  isUrl(text) { throw new Error("MediaDownloader.isUrl() not implemented"); },
  async search(query, maxResults) { throw new Error("MediaDownloader.search() not implemented"); },
  async resolve(input) { throw new Error("MediaDownloader.resolve() not implemented"); },
  async searchAndDownload(input) { throw new Error("MediaDownloader.searchAndDownload() not implemented"); },
});
