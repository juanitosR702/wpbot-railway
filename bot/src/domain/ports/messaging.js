/**
 * Puertos del canal de mensajería compartidos entre el driving adapter
 * (interfaces/bot/router.js) y los casos de uso (interfaces/commands).
 *
 * HALT: sentinela que un handler puede devolver para consumir el mensaje sin
 * producir respuesta, deteniendo el paso por los plugins posteriores.
 */
export const HALT = Object.freeze({ __routerHalt: true });
