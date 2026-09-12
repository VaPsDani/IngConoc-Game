/**
 * socket.ts — Conexion al API y sincronizacion de reloj.
 *
 * El servidor manda deadlines como timestamp ABSOLUTO suyo. Aqui se estima el
 * offset entre el reloj del celular y el del servidor con 3 rondas de ping, y
 * se toma la MEDIANA: en un WiFi cargado basta un paquete retrasado para
 * arruinar un promedio.
 */

import { io, type Socket } from 'socket.io-client';
import {
  ClientClock,
  PING_ROUNDS,
  pingSample,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@ingconoc/shared';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * El API vive en :3001 del mismo host. En la LAN de la universidad el celular
 * entra por la IP del laptop, asi que se deriva del `location` en vez de
 * quemar `localhost`, que en el celular apuntaria al propio celular.
 */
export function apiUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // En producción el mismo Express sirve la web Y Socket.IO: mismo origen, sin
  // CORS, y WSS hereda el TLS de Caddy. Cadena vacía = origen actual.
  if (!import.meta.env.DEV) return '';
  // En dev Vite está en :5173 y el API en :3001. Se deriva del hostname y no de
  // 'localhost', porque en el celular localhost sería el propio celular.
  const port = (import.meta.env.VITE_API_PORT as string | undefined) ?? '3001';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export function createSocket(): GameSocket {
  return io(apiUrl(), {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    // Sin tope: si el WiFi de la facultad se cae 2 minutos, queremos volver.
    reconnectionAttempts: Infinity,
    timeout: 10_000,
  });
}

/**
 * 3 rondas de ping secuenciales. Devuelve cuando el reloj esta sincronizado.
 * Si alguna se pierde, el reloj queda con las muestras que haya: peor
 * precision, nunca un bloqueo.
 */
export async function syncClock(socket: GameSocket, clock: ClientClock): Promise<void> {
  for (let i = 0; i < PING_ROUNDS; i++) {
    const t0 = Date.now();
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        socket.off('player:pong', onPong);
        resolve(false);
      }, 3000);
      const onPong = (p: { t0: number; tServer: number }) => {
        if (p.t0 !== t0) return;
        clearTimeout(timer);
        socket.off('player:pong', onPong);
        clock.addSample(pingSample(t0, p.tServer, Date.now()));
        resolve(true);
      };
      socket.on('player:pong', onPong);
      socket.emit('player:ping', { t0 });
    });
    if (!ok) break;
  }
}

// --- Credenciales en localStorage ------------------------------------------

const PLAYER_KEY = 'ingconoc:player';
const HOST_KEY = 'ingconoc:host';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* modo privado o almacenamiento lleno: se juega igual, sin reconexion */
  }
}

function clear(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nada que hacer */
  }
}

export type StoredPlayer = {
  sessionId: string;
  playerId: string;
  token: string;
  nickname: string;
};

export type StoredHost = {
  sessionId: string;
  token: string;
  /** Clave de recuperacion, para no volver a tipearla en este dispositivo. */
  hostToken?: string;
  code?: string;
};

export const playerStore = {
  get: () => read<StoredPlayer>(PLAYER_KEY),
  set: (v: StoredPlayer) => write(PLAYER_KEY, v),
  clear: () => clear(PLAYER_KEY),
};

export const hostStore = {
  get: () => read<StoredHost>(HOST_KEY),
  set: (v: StoredHost) => write(HOST_KEY, v),
  clear: () => clear(HOST_KEY),
};

/**
 * Clave de anfitrion (HOST_KEY del servidor). Se guarda aparte de la sesion:
 * sobrevive a terminar una partida y empezar otra.
 */
const HOST_AUTH_KEY = 'ingconoc:hostkey';

export const hostKeyStore = {
  // Se guarda en crudo, no como JSON: es una cadena y punto.
  get: (): string => {
    try {
      return localStorage.getItem(HOST_AUTH_KEY) ?? '';
    } catch {
      return '';
    }
  },
  set: (v: string): void => {
    try {
      localStorage.setItem(HOST_AUTH_KEY, v);
    } catch {
      /* modo privado: habrá que tipearla cada vez */
    }
  },
  clear: () => clear(HOST_AUTH_KEY),
};

export { ClientClock };
