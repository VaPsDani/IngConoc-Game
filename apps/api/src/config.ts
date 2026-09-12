/**
 * config.ts — Toda la configuracion por entorno, en un solo lugar y validada
 * AL ARRANCAR.
 *
 * Misma filosofia que el validador de cuestionarios: si algo esencial falta, el
 * proceso NO levanta. Un servidor que arranca sin HOST_KEY es un servidor donde
 * cualquiera crea salas hasta llenar la memoria.
 */

import { resolve } from 'node:path';

export type Config = {
  port: number;
  /** Clave que exige `host:createSession`. Obligatoria. */
  hostKey: string;
  /** Raiz de datos persistidos: snapshots y resultados exportados. */
  dataDir: string;
  /** Build estatico de la web. Vacio = no se sirve nada (modo dev con Vite). */
  webDist: string | null;
  /** Origen publico para armar el joinUrl del QR. */
  publicUrl: string | null;
  /** Confiar en X-Forwarded-For (solo detras de Caddy). */
  trustProxy: boolean;
  /** Maximo de salas VIVAS por proceso. */
  maxRooms: number;
  /** Maximo de jugadores por sala. */
  maxPlayersPerRoom: number;
  /** TTL absoluto de una sala. */
  roomTtlMs: number;
  /** Sala en LOBBY sin actividad: se descarta antes. */
  lobbyIdleTtlMs: number;
  /** Escribir snapshots en cada transicion. */
  snapshotEnabled: boolean;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} debe ser un número positivo, llegó ${JSON.stringify(raw)}`);
  }
  return Math.floor(n);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const hostKey = env.HOST_KEY ?? '';
  if (hostKey.length < 8) {
    problems.push(
      'HOST_KEY es obligatoria y debe tener al menos 8 caracteres. ' +
        'Sin ella cualquiera puede crear salas en bucle. ' +
        'Genera una con:  node -e "console.log(crypto.randomUUID())"',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Configuración inválida, no arranco:\n  ${problems.join('\n  ')}`);
  }

  return {
    port: envInt('PORT', 3001),
    hostKey,
    dataDir: resolve(env.DATA_DIR ?? './data-runtime'),
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    publicUrl: env.PUBLIC_URL ?? null,
    trustProxy: envBool('TRUST_PROXY', false),
    maxRooms: envInt('MAX_ROOMS', 3),
    maxPlayersPerRoom: envInt('MAX_PLAYERS_PER_ROOM', 60),
    roomTtlMs: envInt('ROOM_TTL_MIN', 240) * 60_000,
    lobbyIdleTtlMs: envInt('LOBBY_IDLE_TTL_MIN', 30) * 60_000,
    snapshotEnabled: envBool('SNAPSHOT', true),
  };
}
