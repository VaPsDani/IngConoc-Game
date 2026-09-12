/**
 * ratelimit.ts — Token bucket POR IP, no por socket.
 *
 * El limite por socket del Paso 2 se evadia abriendo mas sockets. Este va por
 * direccion, que es el recurso que de verdad escasea para el atacante.
 *
 * Cubos separados por accion porque los costes son distintos: crear una sala
 * reserva memoria para siempre, responder no reserva nada.
 */

export type BucketSpec = {
  /** Tope de fichas acumulables (rafaga permitida). */
  capacity: number;
  /** Fichas que se reponen por segundo. */
  refillPerSec: number;
};

export type Action = 'create' | 'join' | 'answer' | 'recover' | 'ping' | 'other';

/**
 * Un salon entero comparte el NAT de la universidad, asi que `join` y `answer`
 * tienen que tolerar 40 personas detras de una sola IP. `create` y `recover`
 * son de una sola persona: ahi se aprieta.
 */
export const DEFAULT_LIMITS: Record<Action, BucketSpec> = {
  // 40 alumnos entrando a la vez desde el mismo NAT, con reintentos.
  join: { capacity: 120, refillPerSec: 4 },
  // 40 respuestas por pregunta; una pregunta dura >= 25 s.
  answer: { capacity: 120, refillPerSec: 8 },
  // 3 rondas al entrar por cada uno de 40.
  ping: { capacity: 200, refillPerSec: 20 },
  // Solo el profe crea salas. Y el cap de 3 salas ya lo limita aparte.
  create: { capacity: 5, refillPerSec: 0.05 },
  // Fuerza bruta sobre 31^6: a 0.1/s son 280 años. Con el codigo de sala además.
  recover: { capacity: 5, refillPerSec: 0.1 },
  other: { capacity: 60, refillPerSec: 10 },
};

type Bucket = { tokens: number; updatedAt: number };

/** Se purgan las IP inactivas para que el Map no crezca sin fin. */
const IDLE_EVICT_MS = 10 * 60_000;

export class IpRateLimiter {
  private readonly buckets = new Map<string, Map<Action, Bucket>>();
  private readonly limits: Record<Action, BucketSpec>;
  private lastSweep = 0;

  constructor(limits: Record<Action, BucketSpec> = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /**
   * Descuenta una ficha. `false` = pasado de vueltas.
   * `now` entra por parametro para poder testear sin esperar.
   */
  take(ip: string, action: Action, now: number = Date.now()): boolean {
    this.maybeSweep(now);
    const spec = this.limits[action] ?? this.limits.other;

    let perIp = this.buckets.get(ip);
    if (!perIp) {
      perIp = new Map();
      this.buckets.set(ip, perIp);
    }
    let bucket = perIp.get(action);
    if (!bucket) {
      bucket = { tokens: spec.capacity, updatedAt: now };
      perIp.set(action, bucket);
    }

    const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(spec.capacity, bucket.tokens + elapsedSec * spec.refillPerSec);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Fichas restantes. Solo para tests y diagnostico. */
  remaining(ip: string, action: Action): number {
    return this.buckets.get(ip)?.get(action)?.tokens ?? this.limits[action].capacity;
  }

  get trackedIps(): number {
    return this.buckets.size;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [ip, perIp] of this.buckets) {
      let newest = 0;
      for (const b of perIp.values()) newest = Math.max(newest, b.updatedAt);
      if (now - newest > IDLE_EVICT_MS) this.buckets.delete(ip);
    }
  }
}

/**
 * IP real del cliente. Detras de Caddy la conexion viene de 127.0.0.1, asi que
 * hay que mirar X-Forwarded-For — pero SOLO si confiamos en el proxy, porque si
 * no cualquiera se inventa la cabecera y evade el limite.
 */
export function clientIp(
  handshake: { address?: string; headers: Record<string, unknown> },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = handshake.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string' && raw.length > 0 && raw.length < 256) {
      // El primero de la lista es el cliente original.
      const first = raw.split(',')[0]!.trim();
      if (first.length > 0) return first;
    }
  }
  return handshake.address ?? 'desconocida';
}
