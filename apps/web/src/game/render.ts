/**
 * render.ts — Dibuja un GameState sobre un CanvasRenderingContext2D.
 *
 * No toca la simulacion. Puede leer el estado pero nunca lo modifica.
 * Todo lo visual que importa a la jugabilidad (plataforma y rama) se deriva de
 * PHYSICS, para que lo que ves sea exactamente lo que la fisica evalua.
 */

import {
  PHYSICS,
  columnCenterX,
  type GameState,
  clamp,
} from './physics';

// --- Anclaje del mundo logico -------------------------------------------------

/** y logica del riel (los pies del sapo cuando esta en el suelo). */
export const RAIL_Y = 640;

/**
 * Altura visual del sapo. La fisica es un punto en los PIES, asi que para que
 * "chocar con la rama" se vea como la cabeza tocando las espinas, dibujamos las
 * puntas de las espinas FROG_H por encima de BRANCH_DY. Cuando los pies llegan
 * a BRANCH_DY, la cabeza toca exactamente la punta de la espina.
 */
export const FROG_H = 30;

/** y de la superficie de las plataformas (identica para las 4). */
export const PLATFORM_Y = RAIL_Y - PHYSICS.PLATFORM_TOP_DY; // 260
/** y de las puntas de las espinas. */
export const SPIKE_TIP_Y = RAIL_Y - (PHYSICS.BRANCH_DY + FROG_H); // 140

const PAD_H = 13;

export type OptionView = { label: string; text: string; color: string };

export type RenderInfo = {
  options: OptionView[];
  timeLeftMs: number;
  timeLimitMs: number;
};

export type Viewport = {
  cssW: number;
  cssH: number;
  dpr: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};

/**
 * Letterboxing: el mundo logico 400x700 se escala entero y se centra.
 * Si la barra de direcciones de Safari cambia la altura a mitad de partida,
 * cambia `scale` y nada mas. La fisica ni se entera.
 */
export function computeViewport(cssW: number, cssH: number, dpr: number): Viewport {
  const scale = Math.min(cssW / PHYSICS.LOGICAL_W, cssH / PHYSICS.LOGICAL_H);
  return {
    cssW,
    cssH,
    dpr,
    scale,
    offsetX: (cssW - PHYSICS.LOGICAL_W * scale) / 2,
    offsetY: (cssH - PHYSICS.LOGICAL_H * scale) / 2,
  };
}

/** Pasa un punto de coordenadas CSS del canvas a coordenadas logicas. */
export function toLogical(cssX: number, cssY: number, view: Viewport): { x: number; y: number } {
  return {
    x: (cssX - view.offsetX) / view.scale,
    y: (cssY - view.offsetY) / view.scale,
  };
}

// --- Utilidades de dibujo -----------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
}

/** Oscurece un color #rrggbb por un factor 0..1. */
function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r},${g},${b})`;
}

// --- Escena -------------------------------------------------------------------

function drawBackground(ctx: CanvasRenderingContext2D, t: number): void {
  const { LOGICAL_W: W, LOGICAL_H: H } = PHYSICS;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0b2a3a');
  sky.addColorStop(0.45, '#0f4152');
  sky.addColorStop(0.8, '#125a63');
  sky.addColorStop(1, '#0d3b46');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Burbujas lentas: puramente decorativas, derivadas del tiempo, sin random.
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 14; i++) {
    const bx = ((i * 97) % W) + 12;
    const speed = 18 + (i % 5) * 7;
    const by = H - ((t * speed + i * 130) % (H + 60));
    const br = 2 + (i % 4);
    ellipse(ctx, bx, by, br, br);
    ctx.fill();
  }

  // Juncos del fondo.
  ctx.strokeStyle = 'rgba(12,60,58,0.55)';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const rx = 20 + i * 74;
    const sway = Math.sin(t * 0.7 + i) * 8;
    ctx.beginPath();
    ctx.moveTo(rx, H);
    ctx.quadraticCurveTo(rx + sway, H - 120, rx + sway * 2, H - 230);
    ctx.stroke();
  }
}

function drawBranch(ctx: CanvasRenderingContext2D, t: number): void {
  const W = PHYSICS.LOGICAL_W;
  const trunkY = SPIKE_TIP_Y - 26;

  // Tronco.
  const grad = ctx.createLinearGradient(0, trunkY - 10, 0, SPIKE_TIP_Y);
  grad.addColorStop(0, '#6b4a2f');
  grad.addColorStop(1, '#3c2717');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-4, trunkY - 12);
  ctx.quadraticCurveTo(W / 2, trunkY - 4, W + 4, trunkY - 12);
  ctx.lineTo(W + 4, trunkY + 14);
  ctx.quadraticCurveTo(W / 2, trunkY + 22, -4, trunkY + 14);
  ctx.closePath();
  ctx.fill();

  // Espinas: sus PUNTAS estan en SPIKE_TIP_Y, que es la frontera real de fallo.
  ctx.fillStyle = '#d9d3c4';
  ctx.strokeStyle = '#2a1a10';
  ctx.lineWidth = 1;
  for (let x = 8; x < W; x += 22) {
    const base = trunkY + 12 + Math.sin(x * 0.3) * 2;
    ctx.beginPath();
    ctx.moveTo(x - 7, base);
    ctx.lineTo(x + 7, base);
    ctx.lineTo(x, SPIKE_TIP_Y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Linea de peligro sutil, latiendo. Marca la referencia, no la ventana.
  const pulse = 0.16 + 0.1 * Math.sin(t * 3);
  ctx.strokeStyle = `rgba(255,90,90,${pulse})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(0, SPIKE_TIP_Y);
  ctx.lineTo(W, SPIKE_TIP_Y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPlatforms(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  info: RenderInfo,
  t: number,
): void {
  const halfW = PHYSICS.PLATFORM_W / 2;
  const landed = state.result?.columnIndex ?? -1;

  for (let c = 0; c < PHYSICS.COLUMNS; c++) {
    const cx = columnCenterX(c);
    const opt = info.options[c];
    const color = opt?.color ?? '#7fd4a2';
    const bob = Math.sin(t * 1.6 + c * 1.4) * 2;
    const y = PLATFORM_Y + bob;
    const isLanded = c === landed;

    // Tallo hacia el agua.
    ctx.strokeStyle = 'rgba(30,90,80,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, y + PAD_H);
    ctx.quadraticCurveTo(cx + 6, y + 90, cx, y + 170);
    ctx.stroke();

    if (isLanded) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
    }

    // Nenufar: canto inferior + superficie superior (la superficie ES la fisica).
    ctx.fillStyle = shade(color, 0.55);
    ellipse(ctx, cx, y + PAD_H * 0.55, halfW, PAD_H * 0.85);
    ctx.fill();

    ctx.fillStyle = color;
    ellipse(ctx, cx, y, halfW, PAD_H * 0.8);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Muesca del nenufar.
    ctx.fillStyle = shade(color, 0.42);
    ctx.beginPath();
    ctx.moveTo(cx + halfW * 0.15, y);
    ctx.lineTo(cx + halfW * 0.95, y - 5);
    ctx.lineTo(cx + halfW * 0.95, y + 5);
    ctx.closePath();
    ctx.fill();

    // Brillo de la superficie: el borde one-way sobre el que se aterriza.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - halfW * 0.9, y - PAD_H * 0.45);
    ctx.quadraticCurveTo(cx, y - PAD_H * 1.05, cx + halfW * 0.9, y - PAD_H * 0.45);
    ctx.stroke();

    // Etiqueta de la opcion.
    ctx.fillStyle = '#0b2a3a';
    ctx.font = 'bold 17px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opt?.label ?? '', cx, y + 1);
  }
}

function drawRail(ctx: CanvasRenderingContext2D, state: GameState): void {
  const W = PHYSICS.LOGICAL_W;

  // Tronco-riel donde vive el sapo.
  const grad = ctx.createLinearGradient(0, RAIL_Y, 0, RAIL_Y + 34);
  grad.addColorStop(0, '#7a5636');
  grad.addColorStop(1, '#402a19');
  ctx.fillStyle = grad;
  roundRect(ctx, -6, RAIL_Y, W + 12, 34, 10);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  roundRect(ctx, -6, RAIL_Y, W + 12, 6, 3);
  ctx.fill();

  // Marcas de columna: el riel es libre, esto solo orienta.
  for (let c = 0; c < PHYSICS.COLUMNS; c++) {
    const cx = columnCenterX(c);
    const on = c === state.column;
    ctx.fillStyle = on ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.16)';
    roundRect(ctx, cx - 14, RAIL_Y + 12, 28, 4, 2);
    ctx.fill();
  }

  // Fondo del estanque.
  ctx.fillStyle = '#0a2f38';
  ctx.fillRect(0, RAIL_Y + 34, W, PHYSICS.LOGICAL_H - RAIL_Y - 34);
}

function drawFrog(ctx: CanvasRenderingContext2D, state: GameState, t: number): void {
  const feetY = RAIL_Y - state.h;
  const cx = state.x;

  // Squash de carga: las patas comprimiendose SON el medidor de fuerza.
  const p = state.charging ? state.power : 0;
  const squash = 1 - 0.38 * p; // altura
  const spread = 1 + 0.26 * p; // ancho

  // Estiramiento en el aire, proporcional a la velocidad vertical.
  const airStretch =
    state.phase === 'airborne' ? clamp(1 + Math.abs(state.vy) / 9000, 1, 1.18) : 1;

  const bodyH = FROG_H * squash * airStretch;
  const bodyW = 34 * spread * (2 - airStretch);
  const bodyCy = feetY - bodyH / 2;

  const stunned = state.phase === 'stunned';
  const tilt = stunned ? Math.sin(t * 22) * 0.16 : 0;

  ctx.save();
  ctx.translate(cx, bodyCy);
  ctx.rotate(tilt);

  // Sombra sobre el riel.
  if (state.h < 60) {
    ctx.save();
    ctx.rotate(-tilt);
    ctx.fillStyle = `rgba(0,0,0,${0.28 * (1 - state.h / 60)})`;
    ellipse(ctx, 0, bodyH / 2 + 3, bodyW * 0.55, 4);
    ctx.fill();
    ctx.restore();
  }

  // Patas traseras plegadas.
  ctx.strokeStyle = '#2f7a45';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * bodyW * 0.28, -bodyH * 0.05);
    ctx.lineTo(s * bodyW * 0.66, bodyH * 0.18 - 6 * p);
    ctx.lineTo(s * bodyW * 0.52, bodyH * 0.5);
    ctx.stroke();
  }

  // Cuerpo.
  const body = ctx.createLinearGradient(0, -bodyH / 2, 0, bodyH / 2);
  body.addColorStop(0, stunned ? '#8fbf7a' : '#8ede7a');
  body.addColorStop(1, stunned ? '#3f7a49' : '#3f9e52');
  ctx.fillStyle = body;
  ellipse(ctx, 0, 0, bodyW / 2, bodyH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,40,25,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ojos.
  const eyeY = -bodyH * 0.34;
  const eyeX = bodyW * 0.21;
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#f4fff0';
    ellipse(ctx, s * eyeX, eyeY, 6.5, 6.5 * (0.7 + 0.3 * squash));
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,40,25,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#10241a';
    if (stunned) {
      // Ojos en aspa.
      ctx.strokeStyle = '#10241a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s * eyeX - 3.5, eyeY - 3.5);
      ctx.lineTo(s * eyeX + 3.5, eyeY + 3.5);
      ctx.moveTo(s * eyeX + 3.5, eyeY - 3.5);
      ctx.lineTo(s * eyeX - 3.5, eyeY + 3.5);
      ctx.stroke();
    } else {
      ellipse(ctx, s * eyeX, eyeY + (state.phase === 'airborne' ? -1.5 : 0), 3, 3.4);
      ctx.fill();
    }
  }

  // Boca.
  ctx.strokeStyle = 'rgba(10,40,25,0.6)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, -bodyH * 0.02, bodyW * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  ctx.restore();

  // Estrellitas de aturdimiento.
  if (stunned) {
    ctx.fillStyle = '#ffe98a';
    for (let i = 0; i < 3; i++) {
      const a = t * 6 + (i * Math.PI * 2) / 3;
      const sx = cx + Math.cos(a) * 20;
      const sy = bodyCy - bodyH * 0.75 + Math.sin(a) * 6;
      ellipse(ctx, sx, sy, 3, 3);
      ctx.fill();
    }
  }

  // Aura de carga: crece con la fuerza. Sin marcas, sin ventana, sin numeros.
  if (state.charging) {
    ctx.strokeStyle = `rgba(190,255,180,${0.25 + 0.45 * p})`;
    ctx.lineWidth = 2 + 2 * p;
    ctx.beginPath();
    ctx.moveTo(cx, feetY - bodyH - 6);
    ctx.lineTo(cx, feetY - bodyH - 6 - 26 * p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6, feetY - bodyH - 2 - 26 * p);
    ctx.lineTo(cx, feetY - bodyH - 10 - 26 * p);
    ctx.lineTo(cx + 6, feetY - bodyH - 2 - 26 * p);
    ctx.stroke();
  }
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  info: RenderInfo,
): void {
  const W = PHYSICS.LOGICAL_W;

  // Barra de tiempo.
  const frac = clamp(info.timeLeftMs / Math.max(info.timeLimitMs, 1), 0, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 12, 8, W - 24, 7, 4);
  ctx.fill();
  ctx.fillStyle = frac > 0.35 ? '#7ee3a0' : frac > 0.15 ? '#ffce5c' : '#ff6b6b';
  roundRect(ctx, 12, 8, (W - 24) * frac, 7, 4);
  ctx.fill();

  // Leyenda de opciones, 2x2. Cabe justo encima del tronco de la rama (y=102).
  const CELL_H = 34;
  const ROW_PITCH = 38;
  const TOP = 22;
  ctx.textBaseline = 'middle';
  for (let c = 0; c < PHYSICS.COLUMNS; c++) {
    const opt = info.options[c];
    if (!opt) continue;
    const col = c % 2;
    const row = (c / 2) | 0;
    const x = 10 + col * ((W - 20) / 2);
    const y = TOP + row * ROW_PITCH;
    const cw = (W - 20) / 2 - 5;

    const active = c === state.column;
    ctx.fillStyle = active ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
    roundRect(ctx, x, y, cw, CELL_H, 8);
    ctx.fill();
    if (active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = opt.color;
    roundRect(ctx, x + 6, y + 7, 20, 20, 5);
    ctx.fill();
    ctx.fillStyle = '#0b2a3a';
    ctx.font = 'bold 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opt.label, x + 16, y + CELL_H / 2 + 0.5);

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    let label = opt.text;
    const maxW = cw - 36;
    if (ctx.measureText(label).width > maxW) {
      while (label.length > 1 && ctx.measureText(label + '…').width > maxW) {
        label = label.slice(0, -1);
      }
      label += '…';
    }
    ctx.fillText(label, x + 32, y + CELL_H / 2 + 0.5);
  }

  // Pie: intentos y consejo. El fallo solo cuesta tiempo, y se dice.
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  const hint =
    state.phase === 'stunned'
      ? state.lastOutcome === 'branch'
        ? '¡Ay! Te pasaste. Menos fuerza.'
        : 'Te quedaste corto. Más fuerza.'
      : state.result
        ? '¡En el nenúfar!'
        : 'Desliza para elegir · mantén y suelta para saltar';
  ctx.fillText(hint, PHYSICS.LOGICAL_W / 2, PHYSICS.LOGICAL_H - 16);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText(`intentos ${state.failedAttempts}`, 14, PHYSICS.LOGICAL_H - 16);
}

/** Punto de entrada del render. */
export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  info: RenderInfo,
  view: Viewport,
): void {
  const t = state.elapsedMs / 1000;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = '#061a22';
  ctx.fillRect(0, 0, view.cssW, view.cssH);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  ctx.beginPath();
  ctx.rect(0, 0, PHYSICS.LOGICAL_W, PHYSICS.LOGICAL_H);
  ctx.clip();

  drawBackground(ctx, t);
  drawBranch(ctx, t);
  drawPlatforms(ctx, state, info, t);
  drawRail(ctx, state);
  drawFrog(ctx, state, t);
  drawHud(ctx, state, info);

  ctx.restore();
}
