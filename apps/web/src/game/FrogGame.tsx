/**
 * FrogGame.tsx — Componente autocontenido: canvas, bucle rAF e input tactil.
 *
 * No sabe cual es la respuesta correcta y no debe recibirla nunca.
 * Solo reporta en que nenufar aterrizo el sapo.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  FIXED_DT,
  FIXED_DT_MS,
  PHYSICS,
  columnFromX,
  createGameState,
  createInput,
  step,
  type GameState,
} from './physics';
import { computeViewport, render, toLogical, type RenderInfo, type Viewport } from './render';

export type FrogGameOption = {
  id: string;
  label: 'A' | 'B' | 'C' | 'D';
  text: string;
  color: string;
};

export type FrogGameAnswer = {
  optionId: string;
  /** 0..1, que tan centrado estuvo el release ganador. */
  precision: number;
  /** intentos fallidos + 1. */
  attempts: number;
  elapsedMs: number;
};

export type FrogGameProps = {
  options: FrogGameOption[];
  /** Ventana total de la pregunta. El padre la calcula al montar. */
  timeLimitMs: number;
  onAnswer: (r: FrogGameAnswer) => void;
  /**
   * Red de seguridad. En el flujo multijugador el padre desmonta el
   * componente cuando vence el deadline del servidor, asi que normalmente
   * esto no llega a dispararse.
   */
  onTimeout: () => void;
  /**
   * Deadline ABSOLUTO en reloj del servidor. Si viene, la barra de tiempo se
   * dibuja contra el (con `clockNow`) en vez de contra el tiempo de simulacion,
   * que puede derivar si el celular pierde frames.
   */
  deadlineAt?: number;
  /** Hora estimada del SERVIDOR. Por defecto, el reloj local. */
  clockNow?: () => number;
  /** Columna inicial del sapo. Cosmetico: moverse por el riel es gratis. */
  startColumn?: number;
  className?: string;
};

export function FrogGame({
  options,
  timeLimitMs,
  onAnswer,
  onTimeout,
  deadlineAt,
  clockNow,
  startColumn = 1,
  className,
}: FrogGameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const stateRef = useRef<GameState>(createGameState(startColumn));
  const inputRef = useRef(createInput());
  const viewRef = useRef<Viewport>(computeViewport(1, 1, 1));
  const pointerIdRef = useRef<number | null>(null);
  const finishedRef = useRef(false);

  // Callbacks y props volatiles por ref: el bucle rAF se monta UNA vez.
  const optionsRef = useRef(options);
  const onAnswerRef = useRef(onAnswer);
  const onTimeoutRef = useRef(onTimeout);
  const timeLimitRef = useRef(timeLimitMs);
  const deadlineRef = useRef(deadlineAt);
  const clockNowRef = useRef(clockNow);
  optionsRef.current = options;
  onAnswerRef.current = onAnswer;
  onTimeoutRef.current = onTimeout;
  timeLimitRef.current = timeLimitMs;
  deadlineRef.current = deadlineAt;
  clockNowRef.current = clockNow;

  // --- Tamano del canvas: DPR + letterboxing ---------------------------------
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    // El backing store sigue al DPR o se ve borroso en el celular.
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    viewRef.current = computeViewport(cssW, cssH, dpr);
  }, []);

  useEffect(() => {
    resize();
    const wrap = wrapRef.current;
    if (!wrap) return;
    // La barra de direcciones de Safari cambia la altura a mitad de partida.
    // Eso solo re-escala el letterbox; la fisica no se entera.
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    window.addEventListener('orientationchange', resize);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', resize);
    };
  }, [resize]);

  // --- Bucle: fisica a paso fijo con acumulador, render desacoplado ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);

      let frameMs = now - last;
      last = now;
      // Pestana en segundo plano o hitch de GC: no dejamos explotar el acumulador.
      if (!(frameMs >= 0) || frameMs > 250) frameMs = 250;
      acc += frameMs;

      const state = stateRef.current;
      const input = inputRef.current;

      // Timestep FIJO de 1/120 s. Dos celulares a 60 y 120 Hz con el mismo
      // input ejecutan exactamente los mismos pasos y obtienen el mismo salto.
      let guard = 0;
      while (acc >= FIXED_DT_MS && guard++ < 240) {
        step(state, FIXED_DT, input);
        acc -= FIXED_DT_MS;
      }
      if (guard >= 240) acc = 0;

      // El countdown lo manda el servidor cuando hay deadline absoluto; si no,
      // se cae al tiempo de simulacion (modo suelto, sin sala).
      const deadline = deadlineRef.current;
      const timeLeftMs =
        deadline !== undefined
          ? Math.max(0, deadline - (clockNowRef.current?.() ?? Date.now()))
          : Math.max(0, timeLimitRef.current - state.elapsedMs);

      const info: RenderInfo = {
        options: optionsRef.current,
        timeLeftMs,
        timeLimitMs: timeLimitRef.current,
      };
      render(ctx, state, info, viewRef.current);

      if (!finishedRef.current) {
        if (state.result) {
          finishedRef.current = true;
          const opt = optionsRef.current[state.result.columnIndex];
          onAnswerRef.current({
            optionId: opt ? opt.id : String(state.result.columnIndex),
            precision: state.result.precision,
            attempts: state.result.attempts,
            elapsedMs: state.result.elapsedMs,
          });
        } else if (timeLeftMs <= 0) {
          finishedRef.current = true;
          state.phase = 'finished';
          onTimeoutRef.current();
        }
      }
    };

    raf = requestAnimationFrame(frame);

    // Al volver de background, no arrastramos el tiempo perdido.
    const onVisibility = () => {
      last = performance.now();
      acc = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // --- Input: Pointer Events, un solo puntero, una sola mano ----------------
  const logicalFromEvent = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return toLogical(e.clientX - rect.left, e.clientY - rect.top, viewRef.current);
  };

  const handleDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (finishedRef.current) return;
    if (pointerIdRef.current !== null) return;
    pointerIdRef.current = e.pointerId;
    // Puede lanzar si el puntero ya no esta activo; no es motivo para no jugar.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: el juego sigue funcionando igual */
    }
    const { x } = logicalFromEvent(e);
    // Posicionar es gratis: tocar cualquier punto elige columna al instante.
    inputRef.current.requestColumn = columnFromX(x);
    inputRef.current.pointerDown = true;
  };

  const handleMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    const { x } = logicalFromEvent(e);
    inputRef.current.requestColumn = columnFromX(x);
  };

  const handleUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    inputRef.current.pointerDown = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div ref={wrapRef} className={className ?? 'h-full w-full'}>
      <canvas
        ref={canvasRef}
        // touch-action: none o al arrastrar la pagina hace scroll.
        className="block h-full w-full touch-none select-none"
        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

export { PHYSICS };
export default FrogGame;
