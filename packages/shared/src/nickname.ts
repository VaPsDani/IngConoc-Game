/**
 * nickname.ts — Saneado y deduplicado de apodos.
 *
 * Son 40 companeros de clase escribiendo en un campo de texto libre que se
 * proyecta en la pared. El saneado no pretende ser un filtro de contenido
 * (para eso esta el boton de expulsar del host): pretende que nada rompa el
 * layout ni inyecte caracteres raros.
 */

export const NICKNAME_MAX = 16;

/**
 * Recorta a NICKNAME_MAX, colapsa espacios y quita caracteres de control y
 * de formato bidireccional (los que permiten dar vuelta el texto de la
 * pantalla del proyector).
 */
export function sanitizeNickname(raw: string): string {
  const cleaned = raw
    // Controles C0/C1, marcas bidi, zero-width, y separadores raros.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, NICKNAME_MAX).join('');
}

export function isValidNickname(name: string): boolean {
  return name.length > 0 && [...name].length <= NICKNAME_MAX;
}

/**
 * Deduplica: "Dani" ya tomado -> "Dani (2)", "Dani (3)"...
 * Si el sufijo hace pasar de NICKNAME_MAX, recorta la base para que quepa.
 */
export function dedupeNickname(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const room = NICKNAME_MAX - suffix.length;
    const base = [...desired].slice(0, room).join('').trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Salida de emergencia: nunca deberia llegar aqui con 40 jugadores.
  return `${desired.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
}
