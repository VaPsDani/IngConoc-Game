/**
 * TEST DE EQUIDAD — el guardian del invariante central.
 *
 * Si alguien mas adelante introduce cualquier asimetria entre columnas
 * (plataformas a distinta altura, ramas distintas, gravedad por columna,
 * anchos distintos, un "modificador de dificultad" por opcion), este test
 * falla. No lo debilites: es lo unico que separa este juego de un Kahoot
 * donde la opcion C es mas facil que la A.
 */

import { describe, it, expect } from 'vitest';
import {
  PHYSICS,
  FIXED_DT,
  apexFor,
  branchFor,
  chargePower,
  columnCenterX,
  createGameState,
  createInput,
  platformTopFor,
  powerWindow,
  precisionFor,
  simulateJump,
  step,
  stepAir,
  velocityFor,
} from './physics';

// ---------------------------------------------------------------------------
// PRNG con semilla fija. Nada de Math.random en ningun punto de la simulacion.
// ---------------------------------------------------------------------------

/** mulberry32: PRNG de 32 bits, rapido y reproducible entre plataformas. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: ruido gaussiano a partir del PRNG con semilla. */
function makeGaussian(seed: number): () => number {
  const rand = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };
}

const TRIALS = 2000;
const SEED = 0x5eed_1234;

type Profile = { name: string; target: number; sigma: number };

/**
 * Cada columna recibe EXACTAMENTE la misma secuencia de ruido (mismo seed,
 * PRNG reiniciado por columna). Asi el test no tiene ruido de muestreo: con
 * fisica simetrica las 4 tasas son identicas bit a bit, y cualquier diferencia
 * es una asimetria real, no azar. La tolerancia de +-1 pp queda como red de
 * seguridad por si alguien mete algo estocastico.
 */
function successRateForColumn(columnIndex: number, profile: Profile): number {
  const gauss = makeGaussian(SEED);
  let hits = 0;
  for (let i = 0; i < TRIALS; i++) {
    const power = profile.target + gauss() * profile.sigma;
    if (simulateJump(power, columnIndex) === 'land') hits++;
  }
  return hits / TRIALS;
}

describe('equidad entre las 4 columnas', () => {
  const w = powerWindow();
  const profiles: Profile[] = [
    { name: 'experto  (target=centro, sigma=0.06)', target: w.center, sigma: 0.06 },
    { name: 'promedio (target=centro, sigma=0.12)', target: w.center, sigma: 0.12 },
    { name: 'novato   (target=0.50,   sigma=0.25)', target: 0.5, sigma: 0.25 },
  ];

  for (const profile of profiles) {
    it(`tasa de exito identica en las 4 columnas — ${profile.name}`, () => {
      const rates: number[] = [];
      for (let c = 0; c < PHYSICS.COLUMNS; c++) {
        rates.push(successRateForColumn(c, profile));
      }

      const pct = rates.map((r) => (r * 100).toFixed(2) + '%');
      const min = Math.min(...rates);
      const max = Math.max(...rates);
      // eslint-disable-next-line no-console
      console.log(
        `[equidad] ${profile.name}  n=${TRIALS}  ` +
          `A=${pct[0]} B=${pct[1]} C=${pct[2]} D=${pct[3]}  ` +
          `spread=${((max - min) * 100).toFixed(4)} pp`,
      );

      // Requisito: identicas dentro de +-1 punto porcentual.
      expect((max - min) * 100).toBeLessThanOrEqual(1);

      // Y, siendo la fisica simetrica y el ruido identico, exactamente iguales.
      for (let c = 1; c < PHYSICS.COLUMNS; c++) {
        expect(rates[c]).toBe(rates[0]);
      }

      // Sanidad: el juego no puede ser ni trivial ni imposible.
      expect(rates[0]).toBeGreaterThan(0.05);
      expect(rates[0]).toBeLessThan(0.98);
    });
  }

  it('la geometria por columna es literalmente la misma', () => {
    for (let c = 0; c < PHYSICS.COLUMNS; c++) {
      expect(platformTopFor(c)).toBe(PHYSICS.PLATFORM_TOP_DY);
      expect(branchFor(c)).toBe(PHYSICS.BRANCH_DY);
      expect(powerWindow(c)).toEqual(powerWindow(0));
    }
  });

  it('las columnas estan equiespaciadas y no se solapan', () => {
    const centers = Array.from({ length: PHYSICS.COLUMNS }, (_, c) => columnCenterX(c));
    const gaps = centers.slice(1).map((x, i) => x - centers[i]);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 12);
    expect(gaps[0]).toBeGreaterThan(PHYSICS.PLATFORM_W);
  });

  it('un barrido fino de power da el mismo veredicto en las 4 columnas', () => {
    for (let i = 0; i <= 4000; i++) {
      const p = i / 4000;
      const ref = simulateJump(p, 0);
      for (let c = 1; c < PHYSICS.COLUMNS; c++) {
        expect(simulateJump(p, c)).toBe(ref);
      }
    }
  });
});

describe('ventana de power', () => {
  it('coincide con el calculo analitico y mide ~26% del medidor', () => {
    const w = powerWindow();
    expect(w.min).toBeCloseTo(0.512244, 5);
    expect(w.max).toBeCloseTo(0.768649, 5);
    expect(w.width).toBeCloseTo(0.256405, 5);
    // eslint-disable-next-line no-console
    console.log(
      `[ventana] power valido = [${w.min.toFixed(6)}, ${w.max.toFixed(6)}]  ` +
        `ancho=${(w.width * 100).toFixed(2)}%  centro=${w.center.toFixed(6)}`,
    );
  });

  it('los bordes analiticos coinciden con la simulacion a paso fijo', () => {
    const w = powerWindow();
    const eps = 1e-3;
    expect(simulateJump(w.min - eps)).toBe('short');
    expect(simulateJump(w.min + eps)).toBe('land');
    expect(simulateJump(w.max - eps)).toBe('land');
    expect(simulateJump(w.max + eps)).toBe('branch');
  });

  it('el apice en los bordes es exactamente la plataforma y la rama', () => {
    const w = powerWindow();
    expect(apexFor(w.min)).toBeCloseTo(PHYSICS.PLATFORM_TOP_DY, 6);
    expect(apexFor(w.max)).toBeCloseTo(PHYSICS.BRANCH_DY, 6);
  });

  it('power 0 se queda corto y power 1 choca con la rama', () => {
    expect(simulateJump(0)).toBe('short');
    expect(simulateJump(1)).toBe('branch');
  });

  it('precision vale 1 en el centro y 0 en los bordes', () => {
    const w = powerWindow();
    expect(precisionFor(w.center)).toBeCloseTo(1, 10);
    expect(precisionFor(w.min)).toBeCloseTo(0, 10);
    expect(precisionFor(w.max)).toBeCloseTo(0, 10);
    expect(precisionFor(w.center + w.half / 2)).toBeCloseTo(0.5, 10);
    expect(precisionFor(0)).toBe(0);
    expect(precisionFor(1)).toBe(0);
  });
});

describe('medidor de carga', () => {
  it('sube 0->1 en CHARGE_PERIOD_MS y hace ping-pong', () => {
    expect(chargePower(0)).toBeCloseTo(0, 12);
    expect(chargePower(PHYSICS.CHARGE_PERIOD_MS / 2)).toBeCloseTo(0.5, 12);
    expect(chargePower(PHYSICS.CHARGE_PERIOD_MS)).toBeCloseTo(1, 12);
    expect(chargePower(PHYSICS.CHARGE_PERIOD_MS * 1.5)).toBeCloseTo(0.5, 12);
    expect(chargePower(PHYSICS.CHARGE_PERIOD_MS * 2)).toBeCloseTo(0, 12);
    expect(chargePower(PHYSICS.CHARGE_PERIOD_MS * 2.5)).toBeCloseTo(0.5, 12);
  });

  it('nunca sale de [0,1]', () => {
    for (let ms = 0; ms < 10000; ms += 7) {
      const p = chargePower(ms);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('plataforma one-way', () => {
  it('se atraviesa subiendo y se aterriza bajando', () => {
    const platform = PHYSICS.PLATFORM_TOP_DY;
    // Subiendo justo por encima de la plataforma: no aterriza.
    const up = stepAir(platform - 1, 500, FIXED_DT, 0);
    expect(up.outcome).toBe('flying');
    expect(up.h).toBeGreaterThan(platform);
    // Bajando cruzando la plataforma: aterriza.
    const down = stepAir(platform + 1, -500, FIXED_DT, 0);
    expect(down.outcome).toBe('land');
    expect(down.h).toBe(platform);
  });
});

describe('determinismo del paso fijo', () => {
  it('el mismo input produce el mismo resultado bit a bit', () => {
    const run = () => {
      const s = createGameState(2);
      const input = createInput();
      // 400 ms de carga y suelta.
      input.pointerDown = true;
      for (let i = 0; i < Math.round(400 / (FIXED_DT * 1000)); i++) step(s, FIXED_DT, input);
      input.pointerDown = false;
      for (let i = 0; i < 600; i++) step(s, FIXED_DT, input);
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('un salto exitoso rellena result con la columna elegida', () => {
    const w = powerWindow();
    const holdMs = w.center * PHYSICS.CHARGE_PERIOD_MS; // power = centro exacto
    const s = createGameState(0);
    const input = createInput();
    input.requestColumn = 3;
    // Dejamos que termine el deslizamiento por el riel (gratis).
    for (let i = 0; i < 60; i++) step(s, FIXED_DT, input);
    expect(s.column).toBe(3);
    expect(s.x).toBeCloseTo(columnCenterX(3), 6);

    input.pointerDown = true;
    const steps = Math.round(holdMs / (FIXED_DT * 1000));
    for (let i = 0; i < steps; i++) step(s, FIXED_DT, input);
    input.pointerDown = false;
    for (let i = 0; i < 600; i++) step(s, FIXED_DT, input);

    expect(s.phase).toBe('finished');
    expect(s.result).not.toBeNull();
    expect(s.result!.columnIndex).toBe(3);
    expect(s.result!.attempts).toBe(1);
    expect(s.result!.precision).toBeGreaterThan(0.9);
  });

  it('un fallo cuesta STUN_MS y permite reintentar', () => {
    const s = createGameState(1);
    const input = createInput();
    input.pointerDown = true;
    for (let i = 0; i < 6; i++) step(s, FIXED_DT, input); // power minusculo
    input.pointerDown = false;
    for (let i = 0; i < 600; i++) step(s, FIXED_DT, input);
    expect(s.failedAttempts).toBe(1);
    expect(s.phase).toBe('ground');
    expect(s.result).toBeNull();
    expect(s.h).toBe(0);
  });

  it('tras chocar con la rama vuelve al riel y se puede reintentar', () => {
    const s = createGameState(1);
    const input = createInput();
    // Hold de 900 ms exactos -> power = 1 -> choca con la rama.
    input.pointerDown = true;
    const steps = Math.round(PHYSICS.CHARGE_PERIOD_MS / (FIXED_DT * 1000));
    for (let i = 0; i < steps; i++) step(s, FIXED_DT, input);
    input.pointerDown = false;
    step(s, FIXED_DT, input);
    expect(s.phase).toBe('airborne');

    // La caida desde la rama (654 ms) cabe dentro del stun (800 ms).
    for (let i = 0; i < 600; i++) step(s, FIXED_DT, input);
    expect(s.lastOutcome).toBe('branch');
    expect(s.failedAttempts).toBe(1);
    expect(s.phase).toBe('ground');
    expect(s.h).toBe(0);
    expect(s.result).toBeNull();

    // Y el siguiente intento, bien calibrado, si aterriza.
    input.pointerDown = true;
    const good = Math.round((powerWindow().center * PHYSICS.CHARGE_PERIOD_MS) / (FIXED_DT * 1000));
    for (let i = 0; i < good; i++) step(s, FIXED_DT, input);
    input.pointerDown = false;
    for (let i = 0; i < 600; i++) step(s, FIXED_DT, input);
    expect(s.result).not.toBeNull();
    expect(s.result!.attempts).toBe(2);
  });

  it('no se puede cambiar de columna en el aire', () => {
    const s = createGameState(0);
    const input = createInput();
    input.pointerDown = true;
    for (let i = 0; i < 60; i++) step(s, FIXED_DT, input);
    input.pointerDown = false;
    step(s, FIXED_DT, input);
    expect(s.phase).toBe('airborne');
    input.requestColumn = 3;
    for (let i = 0; i < 30; i++) step(s, FIXED_DT, input);
    expect(s.column).toBe(0);
  });
});

describe('constantes', () => {
  it('PHYSICS esta congelado', () => {
    expect(Object.isFrozen(PHYSICS)).toBe(true);
  });

  it('la rama esta por encima de la plataforma', () => {
    expect(PHYSICS.BRANCH_DY).toBeGreaterThan(PHYSICS.PLATFORM_TOP_DY);
  });

  it('V_MIN no alcanza la plataforma y V_MAX no pasa de la rama... a proposito', () => {
    // Con power=0 el salto se queda corto; con power=1 choca. La ventana esta
    // estrictamente dentro de (0,1), que es lo que hace jugable el medidor.
    expect(apexFor(0)).toBeLessThan(PHYSICS.PLATFORM_TOP_DY);
    expect(apexFor(1)).toBeGreaterThan(PHYSICS.BRANCH_DY);
    expect(velocityFor(0)).toBe(PHYSICS.V_MIN);
    expect(velocityFor(1)).toBe(PHYSICS.V_MAX);
  });
});
