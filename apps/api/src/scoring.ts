/**
 * scoring.ts — Puntaje. Vive SOLO en el servidor.
 *
 * points = round((700 + 300*speed + 100*precision) * mult)
 *   speed  = clamp(1 - elapsedMs/timeLimitMs, 0, 1)   <- medido con el reloj del servidor
 *   mult   = min(1 + 0.1*(streak-1), 1.5)             <- racha de aciertos consecutivos
 *
 * Dos decisiones deliberadas del diseno:
 *
 * 1. `attempts` NO resta. Cada intento fallido ya se pago con 800 ms de stun
 *    dentro del mini-juego, y el tiempo ya entra por `speed`. Restarlo otra vez
 *    seria cobrar dos veces lo mismo y convertiria la habilidad en algo que
 *    decide SI puntuas, rompiendo el invariante del Paso 1. Se guarda como
 *    telemetria y nada mas.
 *
 * 2. `precision` la reporta el cliente y es trivialmente falsificable. Por eso
 *    vale como maximo 100 de ~1200 puntos (8 %) y va clampeada a [0,1]. Mentir
 *    en `precision` da menos ventaja que responder medio segundo antes.
 */

export const BASE_POINTS = 700;
export const SPEED_POINTS = 300;
export const PRECISION_POINTS = 100;
export const STREAK_STEP = 0.1;
export const STREAK_MAX_MULT = 1.5;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function speedFactor(elapsedMs: number, timeLimitMs: number): number {
  if (!(timeLimitMs > 0)) return 0;
  return clamp(1 - elapsedMs / timeLimitMs, 0, 1);
}

/** Multiplicador de racha. `streak` es la racha YA incluyendo este acierto. */
export function streakMultiplier(streak: number): number {
  if (streak < 1) return 1;
  return Math.min(1 + STREAK_STEP * (streak - 1), STREAK_MAX_MULT);
}

export type ScoreInput = {
  elapsedMs: number;
  timeLimitMs: number;
  /** Reportada por el cliente. Se clampea; nunca se confia mas alla de eso. */
  precision: number;
  /** Racha incluyendo este acierto (1 para el primero). */
  streak: number;
};

export function computePoints(input: ScoreInput): number {
  const speed = speedFactor(input.elapsedMs, input.timeLimitMs);
  const precision = Number.isFinite(input.precision) ? clamp(input.precision, 0, 1) : 0;
  const mult = streakMultiplier(input.streak);
  return Math.round((BASE_POINTS + SPEED_POINTS * speed + PRECISION_POINTS * precision) * mult);
}

/** Cota superior teorica: respuesta instantanea, precision 1, racha >= 6. */
export const MAX_POINTS_PER_QUESTION = computePoints({
  elapsedMs: 0,
  timeLimitMs: 1,
  precision: 1,
  streak: 6,
});
