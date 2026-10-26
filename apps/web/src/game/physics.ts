/**
 * physics.ts — Modulo PURO de simulacion del mini-juego del sapo.
 *
 * Sin DOM, sin canvas, sin React, sin Math.random(). Importable desde Node.
 *
 * INVARIANTE CENTRAL
 * ------------------
 * La dificultad de alcanzar una plataforma es IDENTICA para las 4 columnas y
 * para todas las preguntas y cuestionarios. El conocimiento decide A DONDE
 * saltas; la habilidad decide QUE TAN RAPIDO llegas, nunca SI llegas.
 *
 * Todo lo que define la dificultad vive en PHYSICS. Los helpers geometricos
 * (platformTopFor, branchFor, columnCenterX) reciben el indice de columna a
 * proposito: son el unico lugar donde alguien podria meter asimetria, y el test
 * de equidad los recorre columna por columna para impedirlo.
 */

export const PHYSICS = Object.freeze({
  LOGICAL_W: 400,
  LOGICAL_H: 700,
  GRAVITY: 2200, // px/s^2
  V_MIN: 900, // px/s con power = 0
  V_MAX: 1600, // px/s con power = 1
  CHARGE_PERIOD_MS: 900, // 0 -> 1, luego ping-pong
  PLATFORM_TOP_DY: 360, // px sobre los pies del sapo
  BRANCH_DY: 470, // px sobre los pies del sapo
  PLATFORM_W: 78,
  RAIL_SLIDE_MS: 300,
  STUN_MS: 800,
  COLUMNS: 4,
});

/** Timestep fijo de la simulacion: 1/120 s. Desacoplado del refresh rate. */
export const FIXED_DT = 1 / 120;
export const FIXED_DT_MS = 1000 / 120;

// ---------------------------------------------------------------------------
// Geometria: el UNICO punto donde podria entrar asimetria entre columnas.
// ---------------------------------------------------------------------------

/** Altura (px sobre el riel) de la superficie de la plataforma de una columna. */
export function platformTopFor(_columnIndex: number): number {
  return PHYSICS.PLATFORM_TOP_DY;
}

/** Altura (px sobre el riel) de la rama espinosa sobre una columna. */
export function branchFor(_columnIndex: number): number {
  return PHYSICS.BRANCH_DY;
}

/** Centro horizontal logico de una columna. Equiespaciadas. */
export function columnCenterX(columnIndex: number): number {
  const slot = PHYSICS.LOGICAL_W / PHYSICS.COLUMNS;
  return slot * (columnIndex + 0.5);
}

/** Columna mas cercana a una x logica. */
export function columnFromX(x: number): number {
  const slot = PHYSICS.LOGICAL_W / PHYSICS.COLUMNS;
  return clamp(Math.floor(x / slot), 0, PHYSICS.COLUMNS - 1);
}

// ---------------------------------------------------------------------------
// Utilidades numericas
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Medidor ping-pong: sube 0->1 en CHARGE_PERIOD_MS y rebota de vuelta. */
export function chargePower(chargeMs: number): number {
  const t = (chargeMs / PHYSICS.CHARGE_PERIOD_MS) % 2;
  return t <= 1 ? t : 2 - t;
}

/** Velocidad inicial vertical para un power dado. */
export function velocityFor(power: number): number {
  return lerp(PHYSICS.V_MIN, PHYSICS.V_MAX, clamp(power, 0, 1));
}

/** Apice analitico (px sobre el riel) para un power dado. */
export function apexFor(power: number): number {
  const v = velocityFor(power);
  return (v * v) / (2 * PHYSICS.GRAVITY);
}

/** Power necesario para que el apice quede exactamente a una altura dada. */
export function powerForApex(height: number): number {
  const v = Math.sqrt(2 * PHYSICS.GRAVITY * height);
  return (v - PHYSICS.V_MIN) / (PHYSICS.V_MAX - PHYSICS.V_MIN);
}

export type PowerWindow = {
  min: number;
  max: number;
  center: number;
  half: number;
  width: number;
};

/**
 * Ventana analitica de power que aterriza en la plataforma:
 * apice > plataforma y apice < rama. Identica para toda columna.
 */
export function powerWindow(columnIndex = 0): PowerWindow {
  const min = powerForApex(platformTopFor(columnIndex));
  const max = powerForApex(branchFor(columnIndex));
  return {
    min,
    max,
    center: (min + max) / 2,
    half: (max - min) / 2,
    width: max - min,
  };
}

/** precision = 1 - |power - centro| / mitadAncho, clamp 0..1. */
export function precisionFor(power: number, columnIndex = 0): number {
  const w = powerWindow(columnIndex);
  return clamp(1 - Math.abs(power - w.center) / w.half, 0, 1);
}

// ---------------------------------------------------------------------------
// Integracion balistica
// ---------------------------------------------------------------------------

export type AirOutcome = 'flying' | 'land' | 'branch' | 'short';

export type AirStep = { h: number; vy: number; outcome: AirOutcome };

/**
 * Avanza un paso de vuelo. Integracion analitica exacta dentro del paso
 * (movimiento balistico puro), asi que el resultado no depende del tamano del
 * paso mas alla de la deteccion de cruces: determinista en todo dispositivo.
 *
 * h = altura de los PIES sobre el riel. vy positivo = hacia arriba.
 */
export function stepAir(h: number, vy: number, dt: number, columnIndex: number): AirStep {
  const g = PHYSICS.GRAVITY;
  const platform = platformTopFor(columnIndex);
  const branch = branchFor(columnIndex);

  const h1 = h + vy * dt - 0.5 * g * dt * dt;
  const v1 = vy - g * dt;

  // Altura maxima alcanzada DENTRO del paso (el apice puede caer entre muestras).
  let hMax = Math.max(h, h1);
  if (vy > 0 && v1 < 0) hMax = Math.max(hMax, h + (vy * vy) / (2 * g));

  // 1. La rama manda: si la cabeza llega a la rama, aturdido.
  if (hMax >= branch) return { h: hMax, vy: 0, outcome: 'branch' };

  // 2. Plataforma one-way: solo aterriza bajando y cruzando la superficie.
  const wasAbove = h > platform || hMax > platform;
  if (v1 < 0 && wasAbove && h1 <= platform) {
    return { h: platform, vy: 0, outcome: 'land' };
  }

  // 3. De vuelta al riel.
  if (h1 <= 0 && v1 < 0) return { h: 0, vy: 0, outcome: 'short' };

  return { h: h1, vy: v1, outcome: 'flying' };
}

/**
 * Simula un salto completo a timestep fijo y devuelve su resolucion.
 * Es exactamente el mismo codigo que corre el juego. Lo usa el test de equidad.
 */
export function simulateJump(power: number, columnIndex = 0): AirOutcome {
  let h = 0;
  let vy = velocityFor(power);
  // Cota generosa: 6 s de vuelo. Un salto real dura menos de 1.5 s.
  for (let i = 0; i < 720; i++) {
    const r = stepAir(h, vy, FIXED_DT, columnIndex);
    h = r.h;
    vy = r.vy;
    if (r.outcome !== 'flying') return r.outcome;
  }
  return 'short';
}

// ---------------------------------------------------------------------------
// Estado del juego
// ---------------------------------------------------------------------------

export type Phase = 'ground' | 'airborne' | 'stunned' | 'finished';

/** Resultado del ultimo intento resuelto, para feedback visual. */
export type LastOutcome = null | 'land' | 'branch' | 'short';

export type GameState = {
  phase: Phase;
  /** Tiempo de simulacion acumulado, en ms. Base de todo lo temporal. */
  elapsedMs: number;

  /** Columna sobre la que esta (o hacia la que se desliza) el sapo. */
  column: number;
  /** x logica actual del sapo (interpolada durante el deslizamiento). */
  x: number;
  slideFromX: number;
  slideMs: number; // ms transcurridos del deslizamiento actual

  /** Altura de los pies sobre el riel. */
  h: number;
  vy: number;

  charging: boolean;
  chargeMs: number;
  power: number;

  /** Power con el que se solto el ultimo salto (para el feedback). */
  lastReleasePower: number;
  lastOutcome: LastOutcome;
  /** ms restantes de aturdimiento/recuperacion. */
  stunMsLeft: number;

  /** Intentos fallidos hasta ahora. */
  failedAttempts: number;

  /** Se llena solo cuando el sapo aterriza. */
  result: null | {
    columnIndex: number;
    precision: number;
    attempts: number;
    elapsedMs: number;
  };
};

export type GameInput = {
  pointerDown: boolean;
  /** Columna pedida por el jugador. step() la consume (la deja en null). */
  requestColumn: number | null;
};

export function createGameState(startColumn = 1): GameState {
  const col = clamp(startColumn, 0, PHYSICS.COLUMNS - 1);
  return {
    phase: 'ground',
    elapsedMs: 0,
    column: col,
    x: columnCenterX(col),
    slideFromX: columnCenterX(col),
    slideMs: PHYSICS.RAIL_SLIDE_MS,
    h: 0,
    vy: 0,
    charging: false,
    chargeMs: 0,
    power: 0,
    lastReleasePower: 0,
    lastOutcome: null,
    stunMsLeft: 0,
    failedAttempts: 0,
    result: null,
  };
}

export function createInput(): GameInput {
  return { pointerDown: false, requestColumn: null };
}

/** Suavizado del deslizamiento por el riel. Cosmetico: no cuesta nada. */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Avanza la simulacion un paso fijo. Muta state y consume input.requestColumn.
 * dt en segundos; el bucle de render siempre pasa FIXED_DT.
 */
export function step(state: GameState, dt: number, input: GameInput): GameState {
  const dtMs = dt * 1000;
  if (state.phase === 'finished') return state;

  state.elapsedMs += dtMs;

  switch (state.phase) {
    case 'ground': {
      // --- Posicionar: gratis, instantaneo, sin costo. No es prueba de habilidad.
      if (input.requestColumn !== null) {
        const target = clamp(input.requestColumn, 0, PHYSICS.COLUMNS - 1);
        if (target !== state.column) {
          state.slideFromX = state.x;
          state.column = target;
          state.slideMs = 0;
        }
        input.requestColumn = null;
      }
      if (state.slideMs < PHYSICS.RAIL_SLIDE_MS) {
        state.slideMs = Math.min(state.slideMs + dtMs, PHYSICS.RAIL_SLIDE_MS);
        const t = easeInOut(state.slideMs / PHYSICS.RAIL_SLIDE_MS);
        state.x = lerp(state.slideFromX, columnCenterX(state.column), t);
      } else {
        state.x = columnCenterX(state.column);
      }

      // --- Cargar: esta si es la habilidad.
      if (input.pointerDown) {
        if (!state.charging) {
          state.charging = true;
          state.chargeMs = 0;
        }
        state.chargeMs += dtMs;
        state.power = chargePower(state.chargeMs);
      } else if (state.charging) {
        // --- Soltar: salto puramente vertical, en la misma columna.
        const power = state.power;
        state.charging = false;
        state.chargeMs = 0;
        state.power = 0;
        state.lastReleasePower = power;
        // El riel es libre: al despegar el sapo ya esta centrado en su columna.
        state.x = columnCenterX(state.column);
        state.slideMs = PHYSICS.RAIL_SLIDE_MS;
        state.h = 0;
        state.vy = velocityFor(power);
        state.phase = 'airborne';
      }
      break;
    }

    case 'airborne': {
      const r = stepAir(state.h, state.vy, dt, state.column);
      state.h = r.h;
      state.vy = r.vy;
      if (r.outcome === 'land') {
        state.lastOutcome = 'land';
        state.phase = 'finished';
        state.result = {
          columnIndex: state.column,
          precision: precisionFor(state.lastReleasePower, state.column),
          attempts: state.failedAttempts + 1,
          elapsedMs: state.elapsedMs,
        };
      } else if (r.outcome === 'branch' || r.outcome === 'short') {
        state.lastOutcome = r.outcome;
        state.failedAttempts += 1;
        state.phase = 'stunned';
        state.stunMsLeft = PHYSICS.STUN_MS;
      }
      break;
    }

    case 'stunned': {
      // El fallo cuesta 800 ms y nada mas. El tiempo es la unica moneda.
      if (state.h > 0) {
        // Ya fallo: solo lo dejamos caer al riel, sin reevaluar colisiones.
        const v1 = state.vy - PHYSICS.GRAVITY * dt;
        const h1 = state.h + state.vy * dt - 0.5 * PHYSICS.GRAVITY * dt * dt;
        state.h = Math.max(0, h1);
        state.vy = state.h > 0 ? v1 : 0;
      }
      state.stunMsLeft -= dtMs;
      if (state.stunMsLeft <= 0 && state.h <= 0) {
        state.stunMsLeft = 0;
        state.h = 0;
        state.vy = 0;
        state.phase = 'ground';
        // Si el jugador nunca solto, no arrancamos una carga nueva sin querer.
        state.charging = false;
        state.chargeMs = 0;
        state.power = 0;
      }
      break;
    }
  }

  return state;
}
