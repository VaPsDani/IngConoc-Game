/**
 * loadtest.ts — 40 celulares simulados contra una sala real.
 *
 *   node scripts/loadtest.ts [--url http://127.0.0.1:3001] [--players 40]
 *
 * Abre un socket de host, crea la sala, mete N jugadores, juega el cuestionario
 * completo y responde en momentos aleatorios dentro de la ventana de cada
 * pregunta. Mide lo unico que importa para saber si aguanta la clase:
 * cuantos entraron, cuantas respuestas se aceptaron y rechazaron, la latencia
 * de `player:answer` -> `player:result`, y cuanta memoria gasta el servidor.
 *
 * No usa @ingconoc/shared a proposito: es un cliente externo, igual que lo
 * seria un celular, y asi prueba el contrato del cable y no los tipos.
 */

import { io, type Socket } from 'socket.io-client';

// --- Argumentos -------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL = arg('url', 'http://127.0.0.1:3001');
const PLAYERS = Number(arg('players', '40'));
const QUIZ_ID = arg('quiz', 'ic-demo');
/** Fraccion que NUNCA responde (se quedan mirando el celular). */
const SILENT_RATIO = Number(arg('silent', '0.1'));
/** Fraccion que responde DESPUES del deadline, para probar la gracia. */
const LATE_RATIO = Number(arg('late', '0.1'));

// --- Utilidades -------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PRNG con semilla: la corrida es reproducible. */
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
const rand = mulberry32(0xc0ffee);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function connect(): Socket {
  return io(URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 20_000,
  });
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

// --- Metricas ---------------------------------------------------------------

const metrics = {
  connectOk: 0,
  connectFail: 0,
  joinOk: 0,
  joinFail: 0,
  answersSent: 0,
  answersAccepted: 0,
  answersRejected: 0,
  rejectionsByCode: new Map<string, number>(),
  answerLatencies: [] as number[],
  pingRtts: [] as number[],
};

function countRejection(code: string): void {
  metrics.rejectionsByCode.set(code, (metrics.rejectionsByCode.get(code) ?? 0) + 1);
}

type PlayerCtx = {
  index: number;
  socket: Socket;
  playerId: string | null;
  nickname: string;
  /** Pregunta actual segun el servidor. */
  question: { id: string; timeLimitMs: number; options: { id: string }[] } | null;
  deadlineAt: number | null;
  answeredFor: Set<string>;
  pendingAnswerAt: number | null;
  timer: NodeJS.Timeout | null;
  profile: 'normal' | 'silent' | 'late';
};

async function health(): Promise<Record<string, unknown>> {
  const res = await fetch(`${URL}/health`);
  return (await res.json()) as Record<string, unknown>;
}

// --- Corrida ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== loadtest: ${PLAYERS} jugadores contra ${URL} ===\n`);
  const memBefore = await health();

  // 1. Host crea la sala.
  const host = connect();
  await waitFor(host, 'connect', 10_000).catch(() => {
    throw new Error(`No se pudo conectar al servidor en ${URL}. ¿Está corriendo el API?`);
  });
  host.emit('host:createSession', { quizId: QUIZ_ID });
  const session = await waitFor<{ code: string; totalQuestions: number; quizTitle: string }>(
    host,
    'host:sessionCreated',
  );
  console.log(`sala ${session.code} — "${session.quizTitle}" (${session.totalQuestions} preguntas)`);

  let hostPhase = 'LOBBY';
  host.on('host:questionState', (p: { phase: string }) => {
    hostPhase = p.phase;
  });

  // Escucha permanente: si se engancha con `once` despues del bucle, el evento
  // ya paso y se pierde.
  let finalPayload: { fullLeaderboard: { nickname: string; score: number }[] } | null = null;
  host.on('host:final', (p: { fullLeaderboard: { nickname: string; score: number }[] }) => {
    finalPayload = p;
  });

  // 2. Los 40 se conectan y entran.
  const players: PlayerCtx[] = [];
  const t0Connect = Date.now();

  await Promise.all(
    Array.from({ length: PLAYERS }, async (_, index) => {
      const socket = connect();
      const ctx: PlayerCtx = {
        index,
        socket,
        playerId: null,
        nickname: `Alumno${index + 1}`,
        question: null,
        deadlineAt: null,
        answeredFor: new Set(),
        pendingAnswerAt: null,
        timer: null,
        profile:
          index % 10 === 0 && SILENT_RATIO > 0
            ? 'silent'
            : index % 10 === 5 && LATE_RATIO > 0
              ? 'late'
              : 'normal',
      };
      players.push(ctx);

      try {
        await waitFor(socket, 'connect', 15_000);
        metrics.connectOk++;
      } catch {
        metrics.connectFail++;
        return;
      }

      socket.on('player:error', (e: { code: string }) => {
        if (ctx.pendingAnswerAt !== null) {
          metrics.answersRejected++;
          countRejection(e.code);
          ctx.pendingAnswerAt = null;
        } else {
          countRejection(e.code);
        }
      });

      socket.on('player:answerAccepted', () => {
        if (ctx.pendingAnswerAt !== null) {
          metrics.answerLatencies.push(Date.now() - ctx.pendingAnswerAt);
          metrics.answersAccepted++;
          ctx.pendingAnswerAt = null;
        }
      });

      socket.on(
        'player:state',
        (p: {
          phase: string;
          question?: { id: string; timeLimitMs: number; options: { id: string }[] };
          deadlineAt?: number;
        }) => {
          ctx.question = p.question ?? null;
          ctx.deadlineAt = p.deadlineAt ?? null;
          if (p.phase === 'QUESTION_ACTIVE' && p.question && !ctx.answeredFor.has(p.question.id)) {
            scheduleAnswer(ctx);
          }
        },
      );

      socket.emit('player:join', { code: session.code, nickname: ctx.nickname });
      try {
        const joined = await waitFor<{ playerId: string }>(socket, 'player:joined', 15_000);
        ctx.playerId = joined.playerId;
        metrics.joinOk++;
      } catch {
        metrics.joinFail++;
        return;
      }

      // 3 rondas de ping, igual que el cliente real.
      for (let r = 0; r < 3; r++) {
        const t0 = Date.now();
        socket.emit('player:ping', { t0 });
        try {
          await waitFor(socket, 'player:pong', 5000);
          metrics.pingRtts.push(Date.now() - t0);
        } catch {
          /* un pong perdido no invalida la corrida */
        }
      }
    }),
  );

  const connectMs = Date.now() - t0Connect;
  console.log(
    `conectados ${metrics.connectOk}/${PLAYERS}, dentro de la sala ${metrics.joinOk}` +
      ` (${connectMs} ms en total)\n`,
  );

  /** Responde en un momento aleatorio dentro de la ventana de la pregunta. */
  function scheduleAnswer(ctx: PlayerCtx): void {
    if (!ctx.question || ctx.deadlineAt === null) return;
    const q = ctx.question;
    if (ctx.answeredFor.has(q.id)) return;
    ctx.answeredFor.add(q.id);
    if (ctx.timer) clearTimeout(ctx.timer);

    if (ctx.profile === 'silent') return; // nunca responde: fuerza el deadline

    const remaining = ctx.deadlineAt - Date.now();
    // 'late' dispara pasada la gracia, para que el servidor lo rechace.
    const at =
      ctx.profile === 'late'
        ? remaining + 1500 + 400 + rand() * 600
        : Math.max(50, remaining * (0.1 + rand() * 0.85));

    ctx.timer = setTimeout(() => {
      const option = q.options[Math.floor(rand() * q.options.length)];
      ctx.pendingAnswerAt = Date.now();
      metrics.answersSent++;
      ctx.socket.emit('player:answer', {
        questionId: q.id,
        optionId: option.id,
        precision: rand(),
        attempts: 1 + Math.floor(rand() * 4),
      });
    }, at);
  }

  // 3. Jugar el cuestionario completo.
  host.emit('host:startGame');
  await sleep(300);

  for (let q = 0; q < session.totalQuestions; q++) {
    // Esperar a que la pregunta cierre sola (deadline + gracia) o porque todos
    // respondieron. Cota dura por si algo se cuelga.
    const limit = Date.now() + 60_000;
    while (hostPhase === 'QUESTION_ACTIVE' && Date.now() < limit) await sleep(200);
    console.log(
      `pregunta ${q + 1}/${session.totalQuestions} cerrada — fase=${hostPhase}` +
        ` aceptadas=${metrics.answersAccepted} rechazadas=${metrics.answersRejected}`,
    );
    await sleep(200);
    host.emit('host:nextQuestion'); // REVEAL -> DISCUSSION
    await sleep(200);
    host.emit('host:nextQuestion'); // DISCUSSION -> siguiente | FINAL
    await sleep(400);
  }

  // Anotado a mano: TS estrecha a null porque no ve que el callback lo asigna.
  const final = finalPayload as { fullLeaderboard: { nickname: string; score: number }[] } | null;

  const memAfter = await health();

  // 4. Reporte.
  const lat = metrics.answerLatencies;
  console.log('\n=== RESULTADOS ===');
  console.log(`conexiones exitosas       ${metrics.connectOk}/${PLAYERS}`);
  console.log(`conexiones fallidas       ${metrics.connectFail}`);
  console.log(`entraron a la sala        ${metrics.joinOk} (fallos: ${metrics.joinFail})`);
  console.log(`respuestas enviadas       ${metrics.answersSent}`);
  console.log(`respuestas aceptadas      ${metrics.answersAccepted}`);
  console.log(`respuestas rechazadas     ${metrics.answersRejected}`);
  if (metrics.rejectionsByCode.size > 0) {
    for (const [code, n] of metrics.rejectionsByCode) {
      console.log(`  rechazo ${code.padEnd(20)} ${n}`);
    }
  }
  console.log(`latencia answer->result   p50 ${percentile(lat, 50)} ms · p95 ${percentile(lat, 95)} ms · max ${Math.max(0, ...lat)} ms · n=${lat.length}`);
  console.log(`ping RTT                  p50 ${percentile(metrics.pingRtts, 50)} ms · p95 ${percentile(metrics.pingRtts, 95)} ms`);
  console.log(
    `memoria servidor          rss ${memBefore.rssMb} -> ${memAfter.rssMb} MB · ` +
      `heap ${memBefore.heapUsedMb} -> ${memAfter.heapUsedMb} MB`,
  );
  console.log(`salas vivas               ${memAfter.rooms}`);
  if (final) {
    const top = final.fullLeaderboard.slice(0, 3);
    console.log(`podio                     ${top.map((r) => `${r.nickname} ${r.score}`).join(' · ')}`);
    console.log(`jugadores en la tabla     ${final.fullLeaderboard.length}`);
  } else {
    console.log('podio                     (no llegó host:final)');
  }
  console.log('');

  for (const p of players) {
    if (p.timer) clearTimeout(p.timer);
    p.socket.close();
  }
  host.close();
  await sleep(300);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nloadtest falló:', err.message);
  process.exit(1);
});
