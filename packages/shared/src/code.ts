/**
 * code.ts — Codigo de sala de 6 caracteres.
 *
 * Se dicta en voz alta y se lee desde el fondo del salon, asi que el alfabeto
 * excluye los pares que se confunden: O/0, I/1/L. Quedan 31 simbolos.
 * 31^6 = 887 millones de combinaciones; con una sola clase activa, la
 * probabilidad de colision es despreciable, pero igual se reintenta.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** Longitud de la clave de recuperacion del host. Mismo alfabeto. */

/** Caracteres prohibidos, por ambiguos. */
export const CODE_BANNED = 'O0I1L';

/**
 * Genera un codigo. `rand` se inyecta para poder testear con un PRNG con
 * semilla; en produccion se pasa `Math.random`.
 */
export function generateCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Genera un codigo que no colisione con los ya tomados. Tras muchos intentos
 * fallidos se rinde y lanza, en vez de girar para siempre.
 */
export function generateUniqueCode(
  taken: (code: string) => boolean,
  rand: () => number = Math.random,
  maxTries = 200,
): string {
  for (let i = 0; i < maxTries; i++) {
    const code = generateCode(rand);
    if (!taken(code)) return code;
  }
  throw new Error('No se pudo generar un codigo de sala libre');
}

/** Normaliza lo que el alumno tipea: mayusculas, sin espacios ni guiones. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * Clave de recuperacion del host: 6 caracteres del mismo alfabeto sin
 * ambiguedades, porque se lee de una pantalla proyectada y se teclea a mano.
 *
 * 31^6 = 887 millones. Poca entropia para internet abierto, suficiente aqui
 * porque para usarla hace falta ADEMAS el codigo de sala y el servidor limita
 * los intentos de recuperacion por IP.
 */
export function generateHostToken(rand: () => number = Math.random): string {
  return generateCode(rand);
}
