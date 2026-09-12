/**
 * Tests del endurecimiento del Paso 3.
 *
 * Los tres vectores que reporté al final del Paso 2 ahora son críticos porque
 * esto sale a internet. Cada uno tiene aquí un test que falla si alguien quita
 * la defensa:
 *
 *   1. Bucle de host:createSession   -> HOST_KEY + cap de salas
 *   2. Rate limit evadible por socket -> limitador POR IP
 *   3. Payloads sin acotar            -> validacion de longitud y forma
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, Quiz, ServerToClientEvents } from '@ingconoc/shared';
import { Gateway } from './gateway.ts';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { clientIp, IpRateLimiter } from './ratelimit.ts';

const HOST_KEY = 'clave-de-prueba-larga';

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

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    hostKey: HOST_KEY,
    dataDir: '',
    webDist: null,
    publicUrl: 'http://test',
    trustProxy: false,
    maxRooms: 3,
    maxPlayersPerRoom: 60,
    roomTtlMs: 4 * 60 * 60 * 1000,
    lobbyIdleTtlMs: 30 * 60 * 1000,
    snapshotEnabled: false,
    ...over,
  };
}

let httpServer: HttpServer;
let io: Server<ClientToServerEvents, ServerToClientEvents>;
let gateway: Gateway;
let port: number;
const clients: ClientSocket[] = [];
const originalLog = console.log;

async function boot(config: Config = makeConfig()): Promise<void> {
  console.log = () => {};
  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: true }, maxHttpBufferSize: 8192 });
  gateway = new Gateway(io, new Map([[QUIZ.id, QUIZ]]), config);
  gateway.attach();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
}

beforeEach(async () => {
  await boot();
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
  const c = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
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
 * Buffer de eventos con espera por predicado. Encadenar `once` tiene una
 * carrera: si el servidor emite dos eventos seguidos, el segundo llega antes
 * de que el test alcance a registrarse para escucharlo.
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

type Session = { code: string; sessionId: string; hostToken: string };

async function createSession(hostKey = HOST_KEY) {
  const host = connect();
  await once(host, 'connect');
  host.emit('host:createSession', { quizId: QUIZ.id, hostKey });
  return { host, session: await once<Session>(host, 'host:sessionCreated') };
}

// ---------------------------------------------------------------------------

describe('HOST_KEY', () => {
  it('sin la clave correcta NO se crea sala', async () => {
    const host = connect();
    await once(host, 'connect');
    host.emit('host:createSession', { quizId: QUIZ.id, hostKey: 'no-es-la-clave' });
    const err = await once<{ code: string }>(host, 'host:error');
    expect(err.code).toBe('BAD_HOST_KEY');
    expect(gateway.roomCount).toBe(0);
  });

  it('con la clave correcta sí', async () => {
    const { session } = await createSession();
    expect(session.code).toHaveLength(6);
    expect(gateway.roomCount).toBe(1);
  });

  it('un hostKey vacío o ausente se rechaza como payload inválido', async () => {
    const host = connect();
    await once(host, 'connect');
    host.emit('host:createSession', { quizId: QUIZ.id } as never);
    const err = await once<{ code: string }>(host, 'host:error');
    expect(err.code).toBe('BAD_PAYLOAD');
    expect(gateway.roomCount).toBe(0);
  });

  it('el servidor no arranca sin HOST_KEY', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/HOST_KEY es obligatoria/);
    expect(() => loadConfig({ HOST_KEY: 'corta' } as NodeJS.ProcessEnv)).toThrow(/HOST_KEY/);
    expect(() => loadConfig({ HOST_KEY: 'una-clave-suficientemente-larga' } as NodeJS.ProcessEnv))
      .not.toThrow();
  });
});

describe('caps duros', () => {
  it('no pasa de MAX_ROOMS salas vivas', async () => {
    for (let i = 0; i < 3; i++) await createSession();
    expect(gateway.roomCount).toBe(3);

    const host = connect();
    await once(host, 'connect');
    host.emit('host:createSession', { quizId: QUIZ.id, hostKey: HOST_KEY });
    const err = await once<{ code: string }>(host, 'host:error');
    expect(err.code).toBe('TOO_MANY_ROOMS');
    expect(gateway.roomCount).toBe(3);
  });

  it('no pasa de maxPlayersPerRoom jugadores', async () => {
    // Se reinicia el gateway con un cap chico para no abrir 60 sockets.
    for (const c of clients.splice(0)) c.close();
    gateway.close();
    io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await boot(makeConfig({ maxPlayersPerRoom: 2 }));

    const { session } = await createSession();
    for (const nick of ['Uno', 'Dos']) {
      const p = connect();
      await once(p, 'connect');
      p.emit('player:join', { code: session.code, nickname: nick });
      await once(p, 'player:joined');
    }
    const tercero = connect();
    await once(tercero, 'connect');
    tercero.emit('player:join', { code: session.code, nickname: 'Tres' });
    const err = await once<{ code: string }>(tercero, 'player:error');
    expect(err.code).toBe('ROOM_FULL');
  });
});

describe('validación de payloads', () => {
  it('rechaza un apodo gigante sin llegar a la máquina de estados', async () => {
    const { session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'x'.repeat(5000) });
    const err = await once<{ code: string }>(p, 'player:error');
    expect(err.code).toBe('BAD_NICKNAME');
    expect(gateway.roomByCode(session.code)!.players.size).toBe(0);
  });

  it('rechaza ids con forma rara en player:answer', async () => {
    const { host, session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'Dani' });
    await once(p, 'player:joined');
    host.emit('host:startGame');
    await once(p, 'player:state');

    p.emit('player:answer', {
      questionId: '../../etc/passwd',
      optionId: 'q0o1',
      precision: 1,
      attempts: 1,
    });
    const err = await once<{ code: string }>(p, 'player:error');
    expect(err.code).toBe('WRONG_QUESTION');
  });

  it('rechaza precision y attempts que no son números', async () => {
    const { host, session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'Dani' });
    await once(p, 'player:joined');
    host.emit('host:startGame');
    const state = await once<{ question: { id: string; options: { id: string }[] } }>(
      p,
      'player:state',
    );

    p.emit('player:answer', {
      questionId: state.question.id,
      optionId: state.question.options[0].id,
      precision: 'mucha' as unknown as number,
      attempts: 1,
    });
    const err = await once<{ code: string }>(p, 'player:error');
    expect(err.code).toBe('WRONG_QUESTION');
  });

  it('un código de sala mal formado no revienta nada', async () => {
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: 'x'.repeat(300), nickname: 'Dani' });
    const err = await once<{ code: string }>(p, 'player:error');
    expect(err.code).toBe('BAD_NICKNAME'); // campo inválido: code
    expect(gateway.roomCount).toBe(0);
  });
});

describe('rate limit por IP', () => {
  it('abrir más sockets NO da más presupuesto: el cubo es de la IP', async () => {
    // El limitador de creación permite 5 en ráfaga. Con 8 sockets distintos
    // desde la misma IP, los últimos deben rebotar igual.
    const errores: string[] = [];
    for (let i = 0; i < 8; i++) {
      const host = connect();
      await once(host, 'connect');
      const result = await new Promise<string>((resolve) => {
        host.once('host:sessionCreated', () => resolve('ok'));
        host.once('host:error', (e: { code: string }) => resolve(e.code));
        host.emit('host:createSession', { quizId: QUIZ.id, hostKey: HOST_KEY });
      });
      errores.push(result);
    }
    // Los 3 primeros crean sala; del 4º al 5º chocan con el cap de salas; del
    // 6º en adelante ni siquiera llegan: los frena el limitador de la IP.
    expect(errores).toContain('TOO_MANY_ROOMS');
    expect(errores).toContain('RATE_LIMITED');
    expect(gateway.roomCount).toBe(3);
  });

  it('la fuerza bruta sobre la clave de recuperación se agota rápido', async () => {
    const { session } = await createSession();
    const atacante = connect();
    await once(atacante, 'connect');

    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await new Promise<string>((resolve) => {
        atacante.once('host:error', (e: { code: string }) => resolve(e.code));
        atacante.once('host:sessionCreated', () => resolve('ENTRO'));
        atacante.emit('host:recover', { code: session.code, hostToken: 'ZZZZZZ' });
      });
      codes.push(r);
    }
    expect(codes).not.toContain('ENTRO');
    expect(codes.filter((c) => c === 'RATE_LIMITED').length).toBeGreaterThan(0);
  });
});

describe('IpRateLimiter (unidad)', () => {
  it('gasta la ráfaga y luego repone con el tiempo', () => {
    const lim = new IpRateLimiter({
      create: { capacity: 3, refillPerSec: 1 },
      join: { capacity: 3, refillPerSec: 1 },
      answer: { capacity: 3, refillPerSec: 1 },
      recover: { capacity: 3, refillPerSec: 1 },
      ping: { capacity: 3, refillPerSec: 1 },
      other: { capacity: 3, refillPerSec: 1 },
    });
    const t0 = 1_000_000;
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(true);
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(true);
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(true);
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(false);
    // Un segundo después vuelve una ficha.
    expect(lim.take('1.1.1.1', 'create', t0 + 1000)).toBe(true);
    expect(lim.take('1.1.1.1', 'create', t0 + 1000)).toBe(false);
  });

  it('cada IP tiene su propio cubo', () => {
    const lim = new IpRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) lim.take('1.1.1.1', 'create', t0);
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(false);
    expect(lim.take('2.2.2.2', 'create', t0)).toBe(true);
  });

  it('cada acción tiene su propio cubo', () => {
    const lim = new IpRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) lim.take('1.1.1.1', 'create', t0);
    expect(lim.take('1.1.1.1', 'create', t0)).toBe(false);
    // Quedarse sin crear salas no impide responder.
    expect(lim.take('1.1.1.1', 'answer', t0)).toBe(true);
  });

  it('aguanta 40 alumnos entrando a la vez desde el mismo NAT', () => {
    const lim = new IpRateLimiter();
    const t0 = 1_000_000;
    let ok = 0;
    for (let i = 0; i < 40; i++) if (lim.take('190.0.0.1', 'join', t0 + i * 50)) ok++;
    expect(ok).toBe(40);
    // Y responden las 5 preguntas.
    let answers = 0;
    for (let q = 0; q < 5; q++) {
      for (let i = 0; i < 40; i++) {
        if (lim.take('190.0.0.1', 'answer', t0 + q * 30_000 + i * 100)) answers++;
      }
    }
    expect(answers).toBe(200);
  });

  it('X-Forwarded-For solo se cree si confiamos en el proxy', () => {
    const handshake = {
      address: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    };
    expect(clientIp(handshake, true)).toBe('203.0.113.9');
    // Sin proxy de confianza, la cabecera es del atacante: se ignora.
    expect(clientIp(handshake, false)).toBe('127.0.0.1');
  });
});

describe('recuperación del host', () => {
  it('la clave es de 6 caracteres del alfabeto sin ambigüedades', async () => {
    const { session } = await createSession();
    expect(session.hostToken).toHaveLength(6);
    expect(session.hostToken).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    for (const ambiguo of 'O0I1L') expect(session.hostToken).not.toContain(ambiguo);
  });

  it('devuelve control total desde otro dispositivo', async () => {
    const { host, session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'Dani' });
    await once(p, 'player:joined');

    // El proyector se muere.
    host.close();
    await sleep(120);

    const states = recorder<{ phase: string }>(p, 'player:state');
    const nuevo = connect();
    await once(nuevo, 'connect');
    nuevo.emit('host:recover', { code: session.code, hostToken: session.hostToken });
    const restored = await once<Session & { totalQuestions: number }>(nuevo, 'host:sessionCreated');
    expect(restored.code).toBe(session.code);

    // Y manda de verdad: puede arrancar la partida.
    nuevo.emit('host:startGame');
    const activa = await states.waitFor((s) => s.phase === 'QUESTION_ACTIVE');
    expect(activa.phase).toBe('QUESTION_ACTIVE');
  });

  it('acepta la clave en minúsculas y con espacios (se teclea a mano)', async () => {
    const { session } = await createSession();
    const nuevo = connect();
    await once(nuevo, 'connect');
    nuevo.emit('host:recover', {
      code: session.code.toLowerCase(),
      hostToken: ` ${session.hostToken.toLowerCase()} `,
    });
    expect((await once<Session>(nuevo, 'host:sessionCreated')).code).toBe(session.code);
  });

  it('con clave incorrecta no entra, y el mensaje no revela si la sala existe', async () => {
    const { session } = await createSession();
    const a = connect();
    await once(a, 'connect');
    a.emit('host:recover', { code: session.code, hostToken: 'ZZZZZZ' });
    const errMalToken = await once<{ code: string; message: string }>(a, 'host:error');

    const b = connect();
    await once(b, 'connect');
    b.emit('host:recover', { code: 'QQQQQQ', hostToken: 'ZZZZZZ' });
    const errSalaInexistente = await once<{ code: string; message: string }>(b, 'host:error');

    expect(errMalToken.code).toBe('RECOVER_FAILED');
    expect(errSalaInexistente.message).toBe(errMalToken.message);
  });

  it('la sala sobrevive sin host y nadie pierde puntaje', async () => {
    const { host, session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'Dani' });
    await once(p, 'player:joined');
    // Segundo jugador para que la pregunta no se cierre sola.
    const q = connect();
    await once(q, 'connect');
    q.emit('player:join', { code: session.code, nickname: 'Otro' });
    await once(q, 'player:joined');

    host.emit('host:startGame');
    const state = await once<{ question: { id: string; options: { id: string }[] } }>(
      p,
      'player:state',
    );
    p.emit('player:answer', {
      questionId: state.question.id,
      optionId: state.question.options[1].id,
      precision: 1,
      attempts: 1,
    });
    await once(p, 'player:answerAccepted');

    // Se cae el anfitrión.
    const sinHost = once<{ hostConnected: boolean; myScore: number }>(p, 'player:state');
    host.close();
    const visto = await sinHost;

    // El jugador ve "esperando al anfitrión", NO un error, y conserva puntos.
    expect(visto.hostConnected).toBe(false);
    expect(visto.myScore).toBeGreaterThan(0);
    expect(gateway.roomByCode(session.code)).toBeDefined();
  });
});

describe('recolección de salas', () => {
  it('descarta un LOBBY abandonado y conserva uno con gente', async () => {
    const { host, session } = await createSession();
    const conGente = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: conGente.session.code, nickname: 'Dani' });
    await once(p, 'player:joined');

    host.close();
    await sleep(150);
    expect(gateway.roomCount).toBe(2);

    // 31 minutos después: la abandonada se va, la que tiene gente se queda.
    gateway.sweep(Date.now() + 31 * 60_000);
    expect(gateway.roomByCode(session.code)).toBeUndefined();
    expect(gateway.roomByCode(conGente.session.code)).toBeDefined();
  });

  it('el TTL absoluto se lleva incluso una sala con gente conectada', async () => {
    const { session } = await createSession();
    const p = connect();
    await once(p, 'connect');
    p.emit('player:join', { code: session.code, nickname: 'Dani' });
    await once(p, 'player:joined');

    gateway.sweep(Date.now() + 5 * 60 * 60 * 1000);
    expect(gateway.roomByCode(session.code)).toBeUndefined();
  });
});
