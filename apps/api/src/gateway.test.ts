/**
 * Tests de integracion del gateway: servidor y clientes de Socket.IO reales.
 *
 * Lo que se prueba aqui NO se puede probar en room.test.ts, porque son cosas
 * del cable: que evento sale, cuando, y con que contenido.
 *
 * El primero es una regresion de un bug real: el servidor mandaba
 * `player:result` en cuanto llegaba la respuesta, asi que el alumno sabia si
 * habia acertado ANTES del reveal. Con eso, el primero en responder podia
 * avisarle a la fila de atras.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, Quiz, ServerToClientEvents } from '@ingconoc/shared';
import { Gateway } from './gateway.ts';
import type { Config } from './config.ts';

export const TEST_HOST_KEY = 'clave-de-prueba-larga';

/** Config de test: sin disco, caps chicos para poder probarlos. */
export const TEST_CONFIG: Config = {
  port: 0,
  hostKey: TEST_HOST_KEY,
  dataDir: '',
  webDist: null,
  publicUrl: 'http://test',
  trustProxy: false,
  maxRooms: 3,
  maxPlayersPerRoom: 60,
  roomTtlMs: 4 * 60 * 60 * 1000,
  lobbyIdleTtlMs: 30 * 60 * 1000,
  snapshotEnabled: false,
};

const QUIZ: Quiz = {
  id: 'test',
  title: 'Test',
  questions: [0, 1].map((qi) => ({
    id: `q${qi}`,
    prompt: `Pregunta ${qi}`,
    timeLimitSec: 5,
    options: (['A', 'B', 'C', 'D'] as const).map((label, oi) => ({
      id: `q${qi}o${oi}`,
      label,
      text: `Opción ${label}`,
      color: '#7ee3a0',
      isCorrect: oi === 1,
    })),
  })),
};

let httpServer: HttpServer;
let io: Server<ClientToServerEvents, ServerToClientEvents>;
let gateway: Gateway;
let port: number;
const clients: ClientSocket[] = [];

/** Silencia el log del gateway para que la salida del test sea legible. */
const originalLog = console.log;

beforeEach(async () => {
  console.log = () => {};
  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: true } });
  gateway = new Gateway(io, new Map([[QUIZ.id, QUIZ]]), TEST_CONFIG);
  gateway.attach();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  gateway.close();
  io.close();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  console.log = originalLog;
});

function connect(): ClientSocket {
  const c = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(c);
  return c;
}

function once<T>(socket: ClientSocket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeoutMs);
    socket.once(event, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Graba TODOS los eventos de un tipo desde que se engancha. Evita la carrera
 * clasica de encadenar `once`: si el servidor emite dos eventos seguidos, el
 * segundo llega antes de que el test alcance a registrarse para escucharlo.
 */
function recorder<T>(socket: ClientSocket, event: string) {
  const buf: T[] = [];
  socket.on(event, (p: T) => buf.push(p));
  return {
    buf,
    async waitFor(pred: (p: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
      const start = Date.now();
      for (;;) {
        const hit = buf.find(pred);
        if (hit) return hit;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`timeout esperando ${event} (recibidos: ${buf.length})`);
        }
        await sleep(10);
      }
    },
  };
}

type StateEvent = {
  phase: string;
  question?: { id: string; index: number; options: { id: string }[] };
  answered: boolean;
  myScore: number;
  myRank: number;
};

/** Host con sala creada y lista. */
async function makeHost() {
  const host = connect();
  await once(host, 'connect');
  host.emit('host:createSession', { quizId: QUIZ.id, hostKey: TEST_HOST_KEY });
  const session = await once<{ code: string; sessionId: string; token: string }>(
    host,
    'host:sessionCreated',
  );
  return { host, session };
}

async function makePlayer(code: string, nickname: string) {
  const socket = connect();
  await once(socket, 'connect');
  socket.emit('player:join', { code, nickname });
  const joined = await once<{ playerId: string; token: string; nickname: string }>(
    socket,
    'player:joined',
  );
  return { socket, ...joined };
}

describe('el resultado no se filtra antes del reveal', () => {
  it('responder devuelve un acuse SIN correctitud, y el resultado llega en REVEAL', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');
    // Hace falta un segundo jugador que NO responda: si responden todos, la
    // sala cierra la pregunta sola y el reveal seria legitimo, no una fuga.
    await makePlayer(session.code, 'Silencio');

    // Espia: cualquier player:result antes del reveal es el bug.
    const results = recorder<unknown>(p.socket, 'player:result');
    const states = recorder<StateEvent>(p.socket, 'player:state');
    const acks = recorder<{ questionId: string; elapsedMs: number }>(
      p.socket,
      'player:answerAccepted',
    );

    host.emit('host:startGame');
    const state = await states.waitFor((s) => s.phase === 'QUESTION_ACTIVE');

    p.socket.emit('player:answer', {
      questionId: state.question!.id,
      optionId: state.question!.options[1].id, // la correcta
      precision: 1,
      attempts: 1,
    });

    const ack = await acks.waitFor();
    expect(ack.questionId).toBe('q0');
    // El acuse NO dice si acerto ni cuantos puntos dio.
    expect(Object.keys(ack).sort()).toEqual(['elapsedMs', 'questionId']);
    // Y el tiempo lo midio el servidor.
    expect(ack.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(ack.elapsedMs).toBeLessThan(5000);

    // La pregunta sigue abierta (falta Silencio) y aun asi no llego nada.
    await sleep(200);
    expect(results.buf).toEqual([]);
    // El estado si dice que ya respondio, para pintar la pantalla de espera.
    expect((await states.waitFor((s) => s.answered)).answered).toBe(true);

    // Recien al cerrar la pregunta llega el resultado.
    host.emit('host:closeQuestion');
    const result = await once<{ correct: boolean; points: number; answered: boolean }>(
      p.socket,
      'player:result',
    );
    expect(result.answered).toBe(true);
    expect(result.correct).toBe(true);
    expect(result.points).toBeGreaterThan(0);
  });

  it('quien no responde recibe result con 0 puntos en el reveal', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Callado');
    host.emit('host:startGame');
    await once(p.socket, 'player:state');

    host.emit('host:closeQuestion');
    const result = await once<{ correct: boolean; points: number; answered: boolean }>(
      p.socket,
      'player:result',
    );
    expect(result.correct).toBe(false);
    expect(result.points).toBe(0);
    // Distingue "fallé" de "se me acabó el tiempo": el celular pinta pantallas
    // distintas y decirle "Incorrecto" a quien no respondió es mentirle.
    expect(result.answered).toBe(false);
  });
});

describe('lo que viaja por el cable', () => {
  it('la pregunta que recibe el jugador no trae isCorrect', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');
    host.emit('host:startGame');
    const state = await once<unknown>(p.socket, 'player:state');
    expect(JSON.stringify(state)).not.toContain('isCorrect');
  });

  it('el host tampoco recibe isCorrect hasta el reveal', async () => {
    const { host, session } = await makeHost();
    await makePlayer(session.code, 'Dani');
    const statePromise = once<unknown>(host, 'host:questionState');
    host.emit('host:startGame');
    const state = await statePromise;
    expect(JSON.stringify(state)).not.toContain('isCorrect');

    // En REVEAL si viaja, pero como un id suelto, no como bandera en la opcion.
    host.emit('host:closeQuestion');
    const reveal = await once<{ correctOptionId: string }>(host, 'host:reveal');
    expect(reveal.correctOptionId).toBe('q0o1');
  });
});

describe('reconexion', () => {
  it('player:resume devuelve puntaje, puesto y si ya respondio', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');
    // Segundo jugador mudo: mantiene la pregunta abierta durante la caida.
    await makePlayer(session.code, 'Silencio');

    const states = recorder<StateEvent>(p.socket, 'player:state');
    const acks = recorder(p.socket, 'player:answerAccepted');
    host.emit('host:startGame');
    const state = await states.waitFor((s) => s.phase === 'QUESTION_ACTIVE');

    p.socket.emit('player:answer', {
      questionId: state.question!.id,
      optionId: state.question!.options[1].id,
      precision: 1,
      attempts: 3,
    });
    await acks.waitFor();

    // Se le cae el WiFi.
    p.socket.close();
    await sleep(100);

    // Vuelve con las credenciales de localStorage. Los grabadores se enganchan
    // ANTES de emitir el resume: el servidor manda joined y state seguidos.
    const back = connect();
    await once(back, 'connect');
    const backJoined = recorder<{ nickname: string }>(back, 'player:joined');
    const backStates = recorder<StateEvent>(back, 'player:state');
    back.emit('player:resume', {
      sessionId: session.sessionId,
      playerId: p.playerId,
      token: p.token,
    });

    expect((await backJoined.waitFor()).nickname).toBe('Dani');
    const restored = await backStates.waitFor();

    expect(restored.phase).toBe('QUESTION_ACTIVE');
    // Clave: ya respondio, asi que el cliente pinta la pantalla de espera y
    // no le deja jugar de nuevo.
    expect(restored.answered).toBe(true);
    expect(restored.myScore).toBeGreaterThan(0);
    expect(restored.myRank).toBe(1);
  });

  it('resume con token robado no entra', async () => {
    const { session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');

    const ladron = connect();
    await once(ladron, 'connect');
    ladron.emit('player:resume', {
      sessionId: session.sessionId,
      playerId: p.playerId,
      token: 'token-inventado',
    });
    const err = await once<{ code: string }>(ladron, 'player:error');
    expect(err.code).toBe('RESUME_FAILED');
  });

  it('una segunda respuesta a la misma pregunta se rechaza', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');
    // Mudo para que la pregunta siga abierta; si no, el rechazo seria por
    // cierre y no por respuesta duplicada.
    await makePlayer(session.code, 'Silencio');

    const states = recorder<StateEvent>(p.socket, 'player:state');
    const acks = recorder(p.socket, 'player:answerAccepted');
    host.emit('host:startGame');
    const state = await states.waitFor((s) => s.phase === 'QUESTION_ACTIVE');

    const payload = {
      questionId: state.question!.id,
      optionId: state.question!.options[0].id,
      precision: 1,
      attempts: 1,
    };
    p.socket.emit('player:answer', payload);
    await acks.waitFor();

    const errPromise = once<{ code: string }>(p.socket, 'player:error');
    p.socket.emit('player:answer', payload);
    expect((await errPromise).code).toBe('ALREADY_ANSWERED');
  });
});

describe('control del host', () => {
  it('un jugador no puede disparar acciones de host', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Vivo');

    // El "jugador" manda eventos de host: se ignoran en silencio.
    p.socket.emit('host:startGame');
    await sleep(150);

    const statePromise = once<{ phase: string }>(host, 'host:questionState');
    host.emit('host:startGame');
    // Si el jugador lo hubiera arrancado, esto seria una transicion invalida
    // y nunca llegaria el estado de QUESTION_ACTIVE.
    expect((await statePromise).phase).toBe('QUESTION_ACTIVE');
  });

  it('expulsar saca al jugador y avisa a su celular', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Molesto');
    await once(host, 'host:roster');

    const kicked = once(p.socket, 'player:kicked');
    host.emit('host:kickPlayer', { playerId: p.playerId });
    await kicked;

    const roster = await once<{ players: unknown[] }>(host, 'host:roster');
    expect(roster.players).toEqual([]);
  });

  it('la sala avanza LOBBY -> ... -> FINAL con el podio', async () => {
    const { host, session } = await makeHost();
    const p = await makePlayer(session.code, 'Dani');

    const states = recorder<StateEvent>(p.socket, 'player:state');
    const acks = recorder<{ questionId: string }>(p.socket, 'player:answerAccepted');
    const reveals = recorder<{ questionId: string }>(host, 'host:reveal');
    const finals = recorder<{ podium: { nickname: string; score: number }[] }>(host, 'host:final');

    host.emit('host:startGame');
    for (let q = 0; q < QUIZ.questions.length; q++) {
      const state = await states.waitFor(
        (s) => s.phase === 'QUESTION_ACTIVE' && s.question?.index === q,
      );
      p.socket.emit('player:answer', {
        questionId: state.question!.id,
        optionId: state.question!.options[1].id,
        precision: 1,
        attempts: 1,
      });
      await acks.waitFor((a) => a.questionId === `q${q}`);
      // Respondieron todos: la sala cierra la pregunta sola.
      await reveals.waitFor((r) => r.questionId === `q${q}`);
      host.emit('host:nextQuestion'); // -> DISCUSSION
      await sleep(60);
      host.emit('host:nextQuestion'); // -> siguiente | FINAL
      await sleep(60);
    }

    const final = await finals.waitFor();
    expect(final.podium[0].nickname).toBe('Dani');
    // Dos aciertos seguidos: el segundo lleva multiplicador de racha 1.1.
    expect(final.podium[0].score).toBeGreaterThan(2000);
  });
});
