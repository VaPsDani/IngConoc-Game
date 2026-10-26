/**
 * Tests de persistencia: snapshots y exportación de resultados.
 *
 * El round-trip completo es el que importa: guardar -> matar -> recargar -> la
 * sala revive con puntajes, rachas y respuestas intactos. Sin eso, un reinicio
 * del contenedor mata la partida de 40 personas.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quiz } from '@ingconoc/shared';
import { Room, toSnapshot, fromSnapshot, SNAPSHOT_VERSION } from './room.ts';
import {
  buildCsv,
  buildResults,
  ensureDirs,
  loadSnapshots,
  saveSnapshot,
  deleteSnapshot,
  writeResults,
  readResultsFile,
  type Paths,
} from './persistence.ts';

const QUIZ: Quiz = {
  id: 'test',
  title: 'Cuestionario de prueba',
  questions: [0, 1, 2].map((qi) => ({
    id: `q${qi}`,
    prompt: `¿Pregunta número ${qi + 1}, con "comillas" y, comas?`,
    timeLimitSec: 25,
    options: (['A', 'B', 'C', 'D'] as const).map((label, oi) => ({
      id: `q${qi}o${oi}`,
      label,
      text: `Opción ${label}`,
      color: '#7ee3a0',
      isCorrect: oi === 1,
    })),
  })),
};

const T0 = 1_700_000_000_000;
let dir: string;
let paths: Paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingconoc-'));
  paths = ensureDirs(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const quizzes = new Map([[QUIZ.id, QUIZ]]);

/** Sala con 3 jugadores y la primera pregunta ya respondida y revelada. */
function partidaEnCurso(): Room {
  const room = new Room(QUIZ, 'ABCDEF', T0);
  const ids: string[] = [];
  for (const nick of ['Dani', 'Mafe', 'Renzo']) {
    const r = room.addPlayer(nick, T0);
    if (!r.ok) throw new Error('no entró');
    ids.push(r.player.id);
  }
  room.startGame(T0);
  room.submitAnswer(ids[0], { questionId: 'q0', optionId: 'q0o1', precision: 0.9, attempts: 2 }, T0 + 3000);
  room.submitAnswer(ids[1], { questionId: 'q0', optionId: 'q0o1', precision: 0.5, attempts: 1 }, T0 + 8000);
  room.submitAnswer(ids[2], { questionId: 'q0', optionId: 'q0o3', precision: 0.2, attempts: 5 }, T0 + 12_000);
  room.closeQuestion(T0 + 13_000);
  return room;
}

describe('round-trip de snapshot', () => {
  it('guardar → matar → recargar: la sala revive completa', () => {
    const original = partidaEnCurso();
    const puntajes = [...original.players.values()].map((p) => ({
      nick: p.nickname,
      score: p.score,
      streak: p.streak,
    }));
    expect(puntajes.some((p) => p.score > 0)).toBe(true);

    saveSnapshot(paths, original, T0 + 14_000);

    // El proceso muere aquí. Arranca uno nuevo y recarga del disco.
    const report = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 20_000,
    });

    expect(report.discarded).toEqual([]);
    expect(report.restored).toHaveLength(1);
    const revivida = report.restored[0];

    expect(revivida.code).toBe('ABCDEF');
    expect(revivida.sessionId).toBe(original.sessionId);
    expect(revivida.hostToken).toBe(original.hostToken);
    expect(revivida.phase).toBe('REVEAL');
    expect(revivida.questionIndex).toBe(0);
    expect(revivida.players.size).toBe(3);

    const revividos = [...revivida.players.values()].map((p) => ({
      nick: p.nickname,
      score: p.score,
      streak: p.streak,
    }));
    expect(revividos).toEqual(puntajes);

    // Las respuestas siguen ahí: nadie puede responder dos veces.
    for (const p of revivida.players.values()) {
      expect(p.answers.get('q0')).toBeDefined();
    }
    // Y la tabla se reconstruye igual.
    expect(revivida.leaderboard().map((r) => r.nickname)).toEqual(
      original.leaderboard().map((r) => r.nickname),
    );
  });

  it('la partida continúa después de revivir', () => {
    const original = partidaEnCurso();
    saveSnapshot(paths, original, T0 + 14_000);
    const { restored } = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 20_000,
    });
    const room = restored[0];

    room.nextQuestion(T0 + 22_000); // -> pregunta 2
    expect(room.phase).toBe('QUESTION_ACTIVE');
    expect(room.questionIndex).toBe(1);

    const dani = [...room.players.values()].find((p) => p.nickname === 'Dani')!;
    const antes = dani.score;
    const r = room.submitAnswer(
      dani.id,
      { questionId: 'q1', optionId: 'q1o1', precision: 1, attempts: 1 },
      T0 + 23_000,
    );
    expect(r.ok).toBe(true);
    expect(dani.score).toBeGreaterThan(antes);
    // La racha sobrevivió al reinicio: segundo acierto seguido.
    if (r.ok) expect(r.result.streak).toBe(2);
  });

  it('una pregunta cuyo deadline venció durante la caída se cierra, no revive imposible', () => {
    const room = new Room(QUIZ, 'ABCDEF', T0);
    room.addPlayer('Dani', T0);
    room.startGame(T0); // deadline = T0 + 25 s
    saveSnapshot(paths, room, T0 + 1000);

    // El proceso estuvo caído 2 minutos.
    const { restored } = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 120_000,
    });
    expect(restored[0].phase).toBe('REVEAL');
    expect(restored[0].deadlineAt).toBeNull();
  });

  it('descarta snapshots caducados, corruptos, de otra versión y de quiz inexistente', () => {
    const room = partidaEnCurso();

    saveSnapshot(paths, room, T0);
    writeFileSync(join(paths.sessions, 'BBBBBB.json'), '{ esto no es json', 'utf8');
    writeFileSync(
      join(paths.sessions, 'CCCCCC.json'),
      JSON.stringify({ ...toSnapshot(room, T0), code: 'CCCCCC', version: 999 }),
      'utf8',
    );
    writeFileSync(
      join(paths.sessions, 'DDDDDD.json'),
      JSON.stringify({ ...toSnapshot(room, T0), code: 'DDDDDD', quizId: 'ya-no-existe' }),
      'utf8',
    );

    // TTL de 1 hora, snapshots de hace 5 horas.
    const report = loadSnapshots(paths, quizzes, {
      ttlMs: 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 5 * 60 * 60 * 1000,
    });

    expect(report.restored).toHaveLength(0);
    expect(report.discarded).toHaveLength(4);
    const razones = report.discarded.map((d) => d.reason).join(' | ');
    expect(razones).toMatch(/TTL/);
    expect(razones).toMatch(/ilegible/);
  });

  it('un snapshot corrupto no impide recargar los demás', () => {
    const buena = partidaEnCurso();
    saveSnapshot(paths, buena, T0);
    writeFileSync(join(paths.sessions, 'BBBBBB.json'), 'no soy json', 'utf8');

    const report = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 1000,
    });
    expect(report.restored).toHaveLength(1);
    expect(report.discarded).toHaveLength(1);
  });

  it('deleteSnapshot borra el fichero', () => {
    const room = partidaEnCurso();
    saveSnapshot(paths, room, T0);
    deleteSnapshot(paths, room.code);
    const report = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 1000,
    });
    expect(report.restored).toHaveLength(0);
  });

  it('no escribe fuera del directorio con un código con path traversal', () => {
    const room = new Room(QUIZ, '../../x' as string, T0);
    saveSnapshot(paths, room, T0);
    const report = loadSnapshots(paths, quizzes, {
      ttlMs: 4 * 60 * 60 * 1000,
      maxPlayers: 60,
      now: T0 + 1000,
    });
    expect(report.restored).toHaveLength(0);
    expect(report.discarded).toHaveLength(0);
  });

  it('el snapshot NO guarda sockets ni conexiones', () => {
    const room = partidaEnCurso();
    const snap = toSnapshot(room, T0);
    const wire = JSON.stringify(snap);
    expect(wire).not.toContain('socketId');
    expect(wire).not.toContain('connected');
    expect(snap.version).toBe(SNAPSHOT_VERSION);
  });

  it('fromSnapshot devuelve el motivo en vez de lanzar', () => {
    expect(fromSnapshot(null, quizzes, { maxPlayers: 60, now: T0 })).toEqual({
      ok: false,
      reason: 'no es un objeto',
    });
    const r = fromSnapshot({ version: 42 }, quizzes, { maxPlayers: 60, now: T0 });
    expect(r.ok).toBe(false);
  });
});

describe('exportación de resultados', () => {
  it('una fila por jugador y pregunta, incluidas las no respondidas', () => {
    const room = partidaEnCurso();
    const results = buildResults(room);
    // 3 jugadores x 1 pregunta jugada.
    expect(results.rows).toHaveLength(3);
    expect(results.totalPlayers).toBe(3);

    const dani = results.rows.find((r) => r.nickname === 'Dani')!;
    expect(dani.questionIndex).toBe(1);
    expect(dani.isCorrect).toBe(true);
    expect(dani.elapsedMs).toBe(3000);
    expect(dani.attempts).toBe(2);
    expect(dani.points).toBeGreaterThan(0);
    expect(dani.runningTotal).toBe(dani.points);

    const renzo = results.rows.find((r) => r.nickname === 'Renzo')!;
    expect(renzo.isCorrect).toBe(false);
    expect(renzo.points).toBe(0);
    expect(renzo.attempts).toBe(5);
  });

  it('quien no responde aparece con la fila marcada, no ausente', () => {
    const room = new Room(QUIZ, 'ABCDEF', T0);
    const a = room.addPlayer('Responde', T0);
    room.addPlayer('Calla', T0);
    if (!a.ok) throw new Error('no entró');
    room.startGame(T0);
    room.submitAnswer(a.player.id, { questionId: 'q0', optionId: 'q0o1', precision: 1, attempts: 1 }, T0 + 1000);
    room.closeQuestion(T0 + 2000);

    const rows = buildResults(room).rows;
    const calla = rows.find((r) => r.nickname === 'Calla')!;
    expect(calla.optionChosen).toBe('(sin responder)');
    expect(calla.isCorrect).toBe('');
    expect(calla.elapsedMs).toBe('');
    expect(calla.points).toBe(0);
  });

  it('el agregado por pregunta es el material didáctico', () => {
    const room = partidaEnCurso();
    const agg = buildResults(room).perQuestion;
    expect(agg).toHaveLength(1);
    const q = agg[0];

    expect(q.questionIndex).toBe(1);
    expect(q.correctOptionId).toBe('q0o1');
    expect(q.answered).toBe(3);
    expect(q.noAnswer).toBe(0);
    expect(q.correctCount).toBe(2);
    expect(q.accuracy).toBeCloseTo(2 / 3, 3);
    // Mediana de 3000, 8000, 12000.
    expect(q.medianElapsedMs).toBe(8000);
    // Mediana de attempts 2, 1, 5.
    expect(q.medianAttempts).toBe(2);
    expect(q.distribution.find((d) => d.optionId === 'q0o1')!.count).toBe(2);
    expect(q.distribution.find((d) => d.optionId === 'q0o3')!.count).toBe(1);
    expect(q.distribution.find((d) => d.optionId === 'q0o0')!.count).toBe(0);
  });

  it('el CSV escapa comillas y comas del enunciado', () => {
    const csv = buildCsv(buildResults(partidaEnCurso()));
    // El BOM va pegado al principio de la primera línea; se descuenta.
    const lineas = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lineas[0]).toBe(
      'nickname,questionIndex,questionText,optionChosen,isCorrect,elapsedMs,attempts,precision,points,runningTotal',
    );
    expect(lineas).toHaveLength(4); // cabecera + 3 filas
    // El enunciado lleva comillas y comas: va entrecomillado y con "" dobles.
    expect(csv).toContain('"¿Pregunta número 1, con ""comillas"" y, comas?"');
    // BOM para que Excel no destroce los acentos.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('writeResults deja json y csv legibles en disco', () => {
    const room = partidaEnCurso();
    const results = writeResults(paths, room);
    expect(results).not.toBeNull();

    const json = readResultsFile(paths, 'ABCDEF', 'json');
    const csv = readResultsFile(paths, 'ABCDEF', 'csv');
    expect(json).not.toBeNull();
    expect(csv).not.toBeNull();

    const parsed = JSON.parse(json!);
    expect(parsed.code).toBe('ABCDEF');
    expect(parsed.quizTitle).toBe('Cuestionario de prueba');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.perQuestion).toHaveLength(1);
    expect(parsed.leaderboard[0].score).toBeGreaterThan(0);
    // El export NUNCA lleva tokens de nadie.
    expect(json).not.toContain(room.hostToken);
    for (const p of room.players.values()) expect(json).not.toContain(p.token);
  });

  it('readResultsFile no se sale del directorio', () => {
    expect(readResultsFile(paths, '../../etc/passwd', 'json')).toBeNull();
    expect(readResultsFile(paths, 'NOEXISTE', 'json')).toBeNull();
  });

  it('exporta solo hasta donde llegó la partida', () => {
    const room = partidaEnCurso(); // 3 preguntas en el quiz, 1 jugada
    expect(buildResults(room).perQuestion).toHaveLength(1);
    room.nextQuestion(T0 + 14_000);
    expect(buildResults(room).perQuestion).toHaveLength(2);
  });
});
