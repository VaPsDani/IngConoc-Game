/**
 * clock.ts — Reloj del cliente sincronizado con el del servidor.
 *
 * Todos los deadlines viajan como timestamp ABSOLUTO del servidor. El cliente
 * necesita saber cuanto adelanta o atrasa su propio reloj para traducirlos.
 *
 * Se hacen 3 rondas de ping y se toma la MEDIANA del offset, no el promedio:
 * en un WiFi de universidad basta un paquete retrasado para arruinar una media,
 * y la mediana lo ignora.
 */

export type PingSample = {
  /** Ida y vuelta completa. */
  rttMs: number;
  /** tServer - tCliente, ya corregido por media latencia. */
  offsetMs: number;
};

export const PING_ROUNDS = 3;

/**
 * Calcula una muestra a partir de un ping.
 * Supone latencia simetrica, que es lo estandar (NTP simplificado).
 */
export function pingSample(t0: number, tServer: number, t1: number): PingSample {
  const rttMs = t1 - t0;
  return { rttMs, offsetMs: tServer - (t0 + rttMs / 2) };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Offset final a partir de las muestras: mediana, robusta a un outlier. */
export function offsetFromSamples(samples: PingSample[]): number {
  return median(samples.map((s) => s.offsetMs));
}

/**
 * Reloj del cliente. `now()` devuelve la hora estimada DEL SERVIDOR.
 * Mientras no haya sincronizado, el offset es 0 y degrada al reloj local:
 * peor precision, nunca un crash.
 */
export class ClientClock {
  private offsetMs = 0;
  private samples: PingSample[] = [];
  synced = false;

  addSample(sample: PingSample): void {
    this.samples.push(sample);
    this.offsetMs = offsetFromSamples(this.samples);
    if (this.samples.length >= PING_ROUNDS) this.synced = true;
  }

  /** Hora estimada del servidor, en ms. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  /** ms que faltan para un deadline expresado en reloj del servidor. */
  msUntil(deadlineAt: number): number {
    return deadlineAt - this.now();
  }

  get offset(): number {
    return this.offsetMs;
  }

  get rtt(): number {
    return median(this.samples.map((s) => s.rttMs));
  }

  reset(): void {
    this.samples = [];
    this.offsetMs = 0;
    this.synced = false;
  }
}
