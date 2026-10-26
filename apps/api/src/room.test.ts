/**
 * Tests de la maquina de estados. Sin sockets y sin esperar timers: el tiempo
 * entra por parametro, asi que 40 minutos de partida se simulan en 1 ms.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Quiz } from '@ingconoc/shared';
import { ANSWER_GRACE_MS, MAX_PLAYERS, Room } from './room.ts';
import {
  computePoints,
  MAX_POINTS_PER_QUESTION,
  speedFactor,
  streakMultiplier,
} from './scoring.ts';

const COLORS = ['#7ee3a0', '#ffce5c', '#8ec9ff', '#ff9ec4'] as const;
const LABELS = ['A', 'B', 'C', 'D'] as const;

function makeQuiz(nQuestions = 3, timeLimitSec = 20): Quiz {
  return {
    id: 'test',
    title: 'Test',
    questions: Array.from({ length: nQuestions }, (_, qi) => ({
      id: `q${qi}`,
      prompt: `Pregunta ${qi}`,
      timeLimitSec,
      options: LABELS.map((label, oi) => ({
        id: `q${qi}o${oi}`,
        label,
        text: `Opción ${label}`,
        color: COLORS[oi],
        // La correcta es siempre la B, para que los tests sean legibles.
        isCorrect: oi === 1,
      })),
    })),
  };
}

const T0 = 1_700_000_000_000;

describe('maquina de estados', () => {
  let room: Room;
  let logs: { event: string; detail: Record<string, unknown> }[];

  beforeEach(() => {
    logs = [];
    room = new Room(makeQuiz(), 'ABCDEF', T0, (event, detail) => logs.push({ event, detail }));
  });

  it('arranca en LOBBY sin pregunta activa', () => {
    expect(room.phase).toBe('LOBBY');
    expect(room.questionIndex).toBe(-1);
    expect(room.deadlineAt).toBeNull();
    expect(room.publicQuestion()).toBeNull();
  });

  it('recorre el ciclo completo LOBBY -> ... -> FINAL', () => {
    room.addPlayer('Dani', T0);
    expect(room.startGame(T0).ok).toBe(true);
    expect(room.phase).toBe('QUESTION_ACTIVE');
    expect(room.questionIndex).toBe(0);
    expect(room.deadlineAt).toBe(T0 + 20_000);

    expect(room.closeQuestion(T0 + 5000).ok).toBe(true);
    expect(room.phase).toBe('REVEAL');

    // "Siguiente" desde la respuesta va directo a la próxima pregunta.
    expect(room.nextQuestion(T0 + 60_000).ok).toBe(true);
    expect(room.phase).toBe('QUESTION_ACTIVE');
    expect(room.questionIndex).toBe(1);
    expect(room.deadlineAt).toBe(T0 + 80_000);
  });

  it('REVEAL no vence nunca: ahí se explica la respuesta', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    room.closeQuestion(T0 + 1000);
    expect(room.phase).toBe('REVEAL');
    // Diez minutos despues sigue igual.
    expect(room.isExpired(T0 + 600_000)).toBe(false);
    expect(room.phase).toBe('REVEAL');
  });

  it('un DISCUSSION de un snapshot viejo también avanza', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    room.closeQuestion(T0 + 1000);
    room.phase = 'DISCUSSION';
    expect(room.nextQuestion(T0 + 2000).ok).toBe(true);
    expect(room.questionIndex).toBe(1);
  });

  it('la ultima pregunta lleva a FINAL', () => {
    const r = new Room(makeQuiz(1), 'ABCDEF', T0);
    r.addPlayer('Dani', T0);
    r.startGame(T0);
    r.closeQuestion(T0 + 1000);
    r.nextQuestion(T0 + 2000); // no quedan preguntas -> FINAL
    expect(r.phase).toBe('FINAL');
    expect(r.deadlineAt).toBeNull();
  });

  it('endGame corta desde cualquier fase', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    expect(room.endGame().ok).toBe(true);
    expect(room.phase).toBe('FINAL');
  });

  it('reveal es un atajo desde QUESTION_ACTIVE y es idempotente en REVEAL', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    expect(room.reveal(T0 + 1000).ok).toBe(true);
    expect(room.phase).toBe('REVEAL');
    expect(room.reveal(T0 + 1100).ok).toBe(true);
    expect(room.phase).toBe('REVEAL');
  });

  it('ignora y loguea transiciones invalidas en vez de crashear', () => {
    // El host hace doble clic o llega un evento tarde.
    expect(room.closeQuestion(T0).ok).toBe(false);
    expect(room.nextQuestion(T0).ok).toBe(false);
    expect(room.reveal(T0).ok).toBe(false);
    expect(room.phase).toBe('LOBBY');

    const ignored = logs.filter((l) => l.event === 'transition:ignored');
    expect(ignored.length).toBe(3);
    expect(ignored[0].detail.phase).toBe('LOBBY');
  });

  it('no arranca sin jugadores ni sin preguntas', () => {
    expect(room.startGame(T0).ok).toBe(false);
    room.addPlayer('Dani', T0);
    expect(room.startGame(T0).ok).toBe(true);

    const vacio = new Room({ id: 'x', title: 'x', questions: [] }, 'ABCDEF', T0);
    vacio.addPlayer('Dani', T0);
    expect(vacio.startGame(T0).ok).toBe(false);
  });

  it('doble startGame no reinicia la pregunta', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    const deadline = room.deadlineAt;
    expect(room.startGame(T0 + 5000).ok).toBe(false);
    expect(room.deadlineAt).toBe(deadline);
  });
});

describe('jugadores', () => {
  let room: Room;
  beforeEach(() => {
    room = new Room(makeQuiz(), 'ABCDEF', T0);
  });

  it('deduplica apodos', () => {
    const a = room.addPlayer('Dani', T0);
    const b = room.addPlayer('Dani', T0 + 1);
    expect(a.ok && a.player.nickname).toBe('Dani');
    expect(b.ok && b.player.nickname).toBe('Dani (2)');
  });

  it('sanea apodos y rechaza los vacios', () => {
    const r = room.addPlayer('   ', T0);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('BAD_NICKNAME');
    const largo = room.addPlayer('x'.repeat(40), T0);
    expect(largo.ok && [...largo.player.nickname].length).toBe(16);
  });

  it('no deja entrar con la partida empezada', () => {
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    const r = room.addPlayer('Tarde', T0 + 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('GAME_ALREADY_STARTED');
  });

  it('respeta el limite de la sala', () => {
    for (let i = 0; i < MAX_PLAYERS; i++) room.addPlayer(`P${i}`, T0 + i);
    const r = room.addPlayer('UnoMas', T0);
    expect(!r.ok && r.code).toBe('ROOM_FULL');
  });

  it('resume solo con el token correcto', () => {
    const add = room.addPlayer('Dani', T0);
    if (!add.ok) throw new Error('no entro');
    const { id, token } = add.player;

    expect(room.resumePlayer(id, token).ok).toBe(true);
    expect(room.resumePlayer(id, 'token-robado').ok).toBe(false);
    expect(room.resumePlayer('otro-id', token).ok).toBe(false);
  });

  it('resume conserva el puntaje acumulado', () => {
    const add = room.addPlayer('Dani', T0);
    if (!add.ok) throw new Error('no entro');
    room.startGame(T0);
    room.submitAnswer(add.player.id, mkAnswer('q0', 'q0o1'), T0 + 1000);
    const score = add.player.score;
    expect(score).toBeGreaterThan(0);

    room.setConnected(add.player.id, false, null);
    const back = room.resumePlayer(add.player.id, add.player.token);
    expect(back.ok && back.player.score).toBe(score);
    expect(back.ok && back.player.connected).toBe(true);
  });

  it('expulsar saca al jugador de la tabla', () => {
    const a = room.addPlayer('Dani', T0);
    room.addPlayer('Otro', T0 + 1);
    if (!a.ok) throw new Error('no entro');
    expect(room.kickPlayer(a.player.id).ok).toBe(true);
    expect(room.players.size).toBe(1);
    expect(room.leaderboard().some((r) => r.playerId === a.player.id)).toBe(false);
    expect(room.kickPlayer(a.player.id).ok).toBe(false);
  });
});

function mkAnswer(questionId: string, optionId: string, precision = 1, attempts = 1) {
  return { questionId, optionId, precision, attempts };
}

describe('respuestas y deadlines', () => {
  let room: Room;
  let pid: string;

  beforeEach(() => {
    room = new Room(makeQuiz(2, 20), 'ABCDEF', T0);
    const add = room.addPlayer('Dani', T0);
    if (!add.ok) throw new Error('no entro');
    pid = add.player.id;
    room.startGame(T0);
  });

  it('acepta una respuesta correcta y puntua', () => {
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 2000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.correct).toBe(true);
    expect(r.result.streak).toBe(1);
    expect(r.record.elapsedMs).toBe(2000);
    expect(r.result.points).toBeGreaterThan(0);
  });

  it('una respuesta por pregunta: la segunda se rechaza', () => {
    room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 1000);
    const dos = room.submitAnswer(pid, mkAnswer('q0', 'q0o2'), T0 + 2000);
    expect(dos.ok).toBe(false);
    expect(!dos.ok && dos.code).toBe('ALREADY_ANSWERED');
  });

  it('rechaza respuestas de otra pregunta', () => {
    const r = room.submitAnswer(pid, mkAnswer('q1', 'q1o1'), T0 + 1000);
    expect(!r.ok && r.code).toBe('WRONG_QUESTION');
  });

  it('rechaza una opcion que no existe', () => {
    const r = room.submitAnswer(pid, mkAnswer('q0', 'inventada'), T0 + 1000);
    expect(!r.ok && r.code).toBe('WRONG_QUESTION');
  });

  it('acepta dentro de la gracia y clampea el elapsedMs al limite', () => {
    const justo = T0 + 20_000 + ANSWER_GRACE_MS - 1;
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), justo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.late).toBe(true);
    // Clampeado: la gracia no regala tiempo extra.
    expect(r.record.elapsedMs).toBe(20_000);
    // speed = 0 -> puntaje base con precision completa.
    expect(r.result.points).toBe(800);
  });

  it('rechaza pasada la gracia', () => {
    const tarde = T0 + 20_000 + ANSWER_GRACE_MS + 1;
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), tarde);
    expect(!r.ok && r.code).toBe('ANSWER_TOO_LATE');
  });

  it('tras cerrar antes de tiempo ya no acepta', () => {
    room.closeQuestion(T0 + 3000);
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 3100);
    expect(!r.ok && r.code).toBe('ANSWER_TOO_LATE');
  });

  it('el elapsedMs del servidor ignora lo que diga el cliente', () => {
    // El cliente no manda elapsedMs: el contrato no lo tiene. Se mide aqui.
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 7531);
    expect(r.ok && r.record.elapsedMs).toBe(7531);
  });

  it('isExpired respeta la gracia', () => {
    expect(room.isExpired(T0 + 20_000)).toBe(false);
    expect(room.isExpired(T0 + 20_000 + ANSWER_GRACE_MS)).toBe(false);
    expect(room.isExpired(T0 + 20_000 + ANSWER_GRACE_MS + 1)).toBe(true);
  });

  it('la respuesta incorrecta corta la racha y da 0', () => {
    room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 1000);
    room.closeQuestion(T0 + 2000);
    room.nextQuestion(T0 + 2100);
    const r = room.submitAnswer(pid, mkAnswer('q1', 'q1o3'), T0 + 3000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.correct).toBe(false);
    expect(r.result.points).toBe(0);
    expect(r.result.streak).toBe(0);
  });

  it('attempts NO resta puntos', () => {
    const uno = new Room(makeQuiz(1), 'AAAAAA', T0);
    const a = uno.addPlayer('A', T0);
    const b = uno.addPlayer('B', T0);
    if (!a.ok || !b.ok) throw new Error('no entraron');
    uno.startGame(T0);
    const r1 = uno.submitAnswer(a.player.id, mkAnswer('q0', 'q0o1', 1, 1), T0 + 5000);
    const r9 = uno.submitAnswer(b.player.id, mkAnswer('q0', 'q0o1', 1, 9), T0 + 5000);
    expect(r1.ok && r9.ok).toBe(true);
    if (!r1.ok || !r9.ok) return;
    expect(r9.result.points).toBe(r1.result.points);
    // Pero si queda guardado como telemetria.
    expect(r9.record.attempts).toBe(9);
  });

  it('precision se clampea y pesa poco', () => {
    const uno = new Room(makeQuiz(1), 'AAAAAA', T0);
    const a = uno.addPlayer('A', T0);
    const b = uno.addPlayer('B', T0);
    if (!a.ok || !b.ok) throw new Error('no entraron');
    uno.startGame(T0);
    // Un tramposo manda precision 999.
    const tramposo = uno.submitAnswer(a.player.id, mkAnswer('q0', 'q0o1', 999), T0 + 5000);
    const honesto = uno.submitAnswer(b.player.id, mkAnswer('q0', 'q0o1', 1), T0 + 5000);
    expect(tramposo.ok && honesto.ok).toBe(true);
    if (!tramposo.ok || !honesto.ok) return;
    // Clampeado a 1: mentir no le da nada por encima del honesto.
    expect(tramposo.result.points).toBe(honesto.result.points);
    // Y el techo de precision son 100 pts sobre ~1000.
    const cero = new Room(makeQuiz(1), 'BBBBBB', T0);
    const c = cero.addPlayer('C', T0);
    if (!c.ok) throw new Error('no entro');
    cero.startGame(T0);
    const sinPrec = cero.submitAnswer(c.player.id, mkAnswer('q0', 'q0o1', 0), T0 + 5000);
    expect(sinPrec.ok && honesto.result.points - sinPrec.result.points).toBe(100);
  });

  it('precision NaN no rompe el puntaje', () => {
    const r = room.submitAnswer(pid, mkAnswer('q0', 'q0o1', Number.NaN), T0 + 1000);
    expect(r.ok && Number.isFinite(r.result.points)).toBe(true);
  });

  it('hasAnsweredCurrent distingue quien ya respondio', () => {
    expect(room.hasAnsweredCurrent(pid)).toBe(false);
    room.submitAnswer(pid, mkAnswer('q0', 'q0o1'), T0 + 1000);
    expect(room.hasAnsweredCurrent(pid)).toBe(true);
  });
});

describe('racha', () => {
  it('multiplica hasta 1.5 y se corta al fallar', () => {
    const room = new Room(makeQuiz(8, 20), 'ABCDEF', T0);
    const add = room.addPlayer('Dani', T0);
    if (!add.ok) throw new Error('no entro');
    const pid = add.player.id;
    room.startGame(T0);

    // Reloj corrido a mano: cada pregunta se responde 1 s despues de abrirse.
    let t = T0;
    const streaks: number[] = [];
    for (let i = 0; i < 7; i++) {
      const correcta = i !== 4; // falla a proposito en la quinta
      t += 1000;
      const r = room.submitAnswer(pid, mkAnswer(`q${i}`, correcta ? `q${i}o1` : `q${i}o3`), t);
      expect(r.ok).toBe(true);
      if (r.ok) streaks.push(r.result.streak);
      t += 1000;
      room.closeQuestion(t); // -> REVEAL
      t += 1000;
      t += 1000;
      room.nextQuestion(t); // -> siguiente pregunta
    }
    expect(streaks).toEqual([1, 2, 3, 4, 0, 1, 2]);
    expect(add.player.bestStreak).toBe(4);
  });
});

describe('distribucion y tabla', () => {
  it('cuenta cada opcion y los que no respondieron', () => {
    const room = new Room(makeQuiz(1), 'ABCDEF', T0);
    const ps = ['A', 'B', 'C', 'D', 'E'].map((n) => {
      const r = room.addPlayer(n, T0);
      if (!r.ok) throw new Error('no entro');
      return r.player;
    });
    room.startGame(T0);
    room.submitAnswer(ps[0].id, mkAnswer('q0', 'q0o1'), T0 + 1000);
    room.submitAnswer(ps[1].id, mkAnswer('q0', 'q0o1'), T0 + 1100);
    room.submitAnswer(ps[2].id, mkAnswer('q0', 'q0o0'), T0 + 1200);
    room.submitAnswer(ps[3].id, mkAnswer('q0', 'q0o3'), T0 + 1300);
    // ps[4] no responde.

    const { distribution, noAnswer } = room.distribution();
    expect(distribution).toEqual([
      { optionId: 'q0o0', count: 1 },
      { optionId: 'q0o1', count: 2 },
      { optionId: 'q0o2', count: 0 },
      { optionId: 'q0o3', count: 1 },
    ]);
    expect(noAnswer).toBe(1);
    expect(room.answeredCount()).toBe(4);
    expect(room.correctOptionIdForCurrent()).toBe('q0o1');
  });

  it('ordena por puntaje y desempata por tiempo', () => {
    const room = new Room(makeQuiz(1), 'ABCDEF', T0);
    const lento = room.addPlayer('Lento', T0);
    const rapido = room.addPlayer('Rapido', T0);
    if (!lento.ok || !rapido.ok) throw new Error('no entraron');
    room.startGame(T0);
    room.submitAnswer(lento.player.id, mkAnswer('q0', 'q0o1'), T0 + 9000);
    room.submitAnswer(rapido.player.id, mkAnswer('q0', 'q0o1'), T0 + 1000);

    const lb = room.leaderboard();
    expect(lb[0].nickname).toBe('Rapido');
    expect(lb[0].rank).toBe(1);
    expect(lb[1].rank).toBe(2);
  });

  it('los empatados comparten puesto', () => {
    const room = new Room(makeQuiz(1), 'ABCDEF', T0);
    for (const n of ['A', 'B', 'C']) room.addPlayer(n, T0);
    room.startGame(T0);
    // Nadie responde: todos con 0.
    const lb = room.leaderboard();
    expect(lb.map((r) => r.rank)).toEqual([1, 1, 1]);
  });
});

describe('la pregunta que sale al cable', () => {
  it('nunca lleva isCorrect', () => {
    const room = new Room(makeQuiz(1), 'ABCDEF', T0);
    room.addPlayer('Dani', T0);
    room.startGame(T0);
    const wire = JSON.stringify(room.publicQuestion());
    expect(wire).not.toContain('isCorrect');
    expect(wire).toContain('Opción A');
  });
});

describe('formula de puntaje', () => {
  it('speedFactor va de 1 a 0 y se clampea', () => {
    expect(speedFactor(0, 20_000)).toBe(1);
    expect(speedFactor(10_000, 20_000)).toBe(0.5);
    expect(speedFactor(20_000, 20_000)).toBe(0);
    expect(speedFactor(99_000, 20_000)).toBe(0);
    expect(speedFactor(1000, 0)).toBe(0);
  });

  it('el multiplicador de racha topa en 1.5', () => {
    expect(streakMultiplier(1)).toBe(1);
    expect(streakMultiplier(2)).toBeCloseTo(1.1, 10);
    expect(streakMultiplier(6)).toBe(1.5);
    expect(streakMultiplier(50)).toBe(1.5);
    expect(streakMultiplier(0)).toBe(1);
  });

  it('coincide con la formula del contrato', () => {
    // instantanea, precision 1, racha 1 -> (700 + 300 + 100) * 1 = 1100
    expect(computePoints({ elapsedMs: 0, timeLimitMs: 20_000, precision: 1, streak: 1 })).toBe(1100);
    // a mitad de tiempo, sin precision, racha 3 -> (700 + 150) * 1.2 = 1020
    expect(computePoints({ elapsedMs: 10_000, timeLimitMs: 20_000, precision: 0, streak: 3 })).toBe(
      1020,
    );
    // al limite, precision 0.5, racha 6+ -> (700 + 50) * 1.5 = 1125
    expect(computePoints({ elapsedMs: 20_000, timeLimitMs: 20_000, precision: 0.5, streak: 9 })).toBe(
      1125,
    );
  });

  it('el techo por pregunta es 1650', () => {
    expect(MAX_POINTS_PER_QUESTION).toBe(1650);
  });
});
