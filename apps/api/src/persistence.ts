/**
 * persistence.ts — Snapshots de sala y exportacion de resultados.
 *
 * SNAPSHOTS: sin esto, un reinicio del contenedor mata la partida de 40
 * personas. No se busca perfeccion transaccional: se escribe en cada transicion
 * de la maquina de estados y se recarga al arrancar. Convertir una catastrofe
 * en un parpadeo de 10 s ya justifica el trabajo.
 *
 * La escritura es atomica (fichero temporal + rename) porque un reinicio
 * justo a mitad de un write dejaria un JSON truncado, que es peor que no tener
 * snapshot.
 *
 * RESULTADOS: se reescriben al cerrar cada REVEAL, asi que si la clase se corta
 * a la pregunta 3 igual queda el material de las 3 primeras.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Quiz } from '@ingconoc/shared';
import { fromSnapshot, toSnapshot, type Room, type RoomLogger } from './room.ts';

export type Paths = { sessions: string; results: string };

export function ensureDirs(dataDir: string): Paths {
  const paths = { sessions: join(dataDir, 'sessions'), results: join(dataDir, 'results') };
  mkdirSync(paths.sessions, { recursive: true });
  mkdirSync(paths.results, { recursive: true });
  return paths;
}

/** Solo codigos de sala: nada que pueda salirse del directorio. */
function safeCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function saveSnapshot(paths: Paths, room: Room, now: number): void {
  if (!safeCode(room.code)) return;
  writeAtomic(
    join(paths.sessions, `${room.code}.json`),
    JSON.stringify(toSnapshot(room, now)),
  );
}

export function deleteSnapshot(paths: Paths, code: string): void {
  if (!safeCode(code)) return;
  rmSync(join(paths.sessions, `${code}.json`), { force: true });
}

export type LoadReport = {
  restored: Room[];
  discarded: { file: string; reason: string }[];
};

/**
 * Recarga las salas del disco. Un snapshot corrupto o caducado se descarta con
 * su motivo; nunca impide arrancar.
 */
export function loadSnapshots(
  paths: Paths,
  quizzes: Map<string, Quiz>,
  opts: { ttlMs: number; maxPlayers: number; now: number; log?: RoomLogger },
): LoadReport {
  const report: LoadReport = { restored: [], discarded: [] };

  let files: string[];
  try {
    files = readdirSync(paths.sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return report;
  }

  for (const file of files) {
    const full = join(paths.sessions, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      report.discarded.push({ file, reason: `JSON ilegible: ${(err as Error).message}` });
      rmSync(full, { force: true });
      continue;
    }

    const savedAt = (raw as { savedAt?: unknown }).savedAt;
    if (typeof savedAt === 'number' && opts.now - savedAt > opts.ttlMs) {
      report.discarded.push({ file, reason: 'más viejo que el TTL' });
      rmSync(full, { force: true });
      continue;
    }

    const restored = fromSnapshot(raw, quizzes, {
      maxPlayers: opts.maxPlayers,
      now: opts.now,
      ...(opts.log ? { log: opts.log } : {}),
    });
    if (!restored.ok) {
      report.discarded.push({ file, reason: restored.reason });
      rmSync(full, { force: true });
      continue;
    }
    report.restored.push(restored.room);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Resultados exportados
// ---------------------------------------------------------------------------

export type PerQuestionAggregate = {
  questionIndex: number;
  questionId: string;
  questionText: string;
  correctOptionId: string;
  correctOptionText: string;
  /** Cuantos eligieron cada opcion. */
  distribution: { optionId: string; label: string; text: string; count: number }[];
  noAnswer: number;
  answered: number;
  correctCount: number;
  /** 0..1 sobre los que respondieron. */
  accuracy: number;
  medianElapsedMs: number | null;
  medianAttempts: number | null;
};

export type ResultsExport = {
  code: string;
  quizId: string;
  quizTitle: string;
  generatedAt: string;
  totalPlayers: number;
  rows: ResultRow[];
  perQuestion: PerQuestionAggregate[];
  leaderboard: { rank: number; nickname: string; score: number; bestStreak: number }[];
};

export type ResultRow = {
  nickname: string;
  questionIndex: number;
  questionText: string;
  optionChosen: string;
  isCorrect: boolean | '';
  elapsedMs: number | '';
  attempts: number | '';
  precision: number | '';
  points: number;
  runningTotal: number;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Una fila por jugador y pregunta, INCLUYENDO las que no respondio: si solo
 * salieran las respondidas, no se podria distinguir "falló" de "no llegó".
 */
export function buildResults(room: Room): ResultsExport {
  const questions = room.quiz.questions;
  // Solo hasta donde llegó la partida.
  const played = room.phase === 'FINAL' ? questions.length : room.questionIndex + 1;

  const players = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const rows: ResultRow[] = [];

  for (const p of players) {
    let runningTotal = 0;
    for (let qi = 0; qi < played; qi++) {
      const q = questions[qi];
      const a = p.answers.get(q.id);
      runningTotal += a?.points ?? 0;
      const chosen = a ? q.options.find((o) => o.id === a.optionId) : undefined;
      rows.push({
        nickname: p.nickname,
        questionIndex: qi + 1,
        questionText: q.prompt,
        optionChosen: chosen ? `${chosen.label}. ${chosen.text}` : '(sin responder)',
        isCorrect: a ? a.correct : '',
        elapsedMs: a ? a.elapsedMs : '',
        attempts: a ? a.attempts : '',
        precision: a ? Number(a.precision.toFixed(4)) : '',
        points: a?.points ?? 0,
        runningTotal,
      });
    }
  }

  const perQuestion: PerQuestionAggregate[] = [];
  for (let qi = 0; qi < played; qi++) {
    const q = questions[qi];
    const correct = q.options.find((o) => o.isCorrect)!;
    const answers = players.map((p) => p.answers.get(q.id)).filter((a) => a !== undefined);
    const counts = new Map(q.options.map((o) => [o.id, 0]));
    for (const a of answers) counts.set(a.optionId, (counts.get(a.optionId) ?? 0) + 1);
    const correctCount = answers.filter((a) => a.correct).length;

    perQuestion.push({
      questionIndex: qi + 1,
      questionId: q.id,
      questionText: q.prompt,
      correctOptionId: correct.id,
      correctOptionText: `${correct.label}. ${correct.text}`,
      distribution: q.options.map((o) => ({
        optionId: o.id,
        label: o.label,
        text: o.text,
        count: counts.get(o.id) ?? 0,
      })),
      noAnswer: players.length - answers.length,
      answered: answers.length,
      correctCount,
      accuracy: answers.length > 0 ? Number((correctCount / answers.length).toFixed(4)) : 0,
      medianElapsedMs: median(answers.map((a) => a.elapsedMs)),
      medianAttempts: median(answers.map((a) => a.attempts)),
    });
  }

  return {
    code: room.code,
    quizId: room.quiz.id,
    quizTitle: room.quiz.title,
    generatedAt: new Date().toISOString(),
    totalPlayers: players.length,
    rows,
    perQuestion,
    leaderboard: room.leaderboard().map((r) => ({
      rank: r.rank,
      nickname: r.nickname,
      score: r.score,
      bestStreak: room.players.get(r.playerId)?.bestStreak ?? 0,
    })),
  };
}

/** Escapa un campo CSV. Excel abre esto sin pelear si lleva BOM. */
function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(results: ResultsExport): string {
  const header = [
    'nickname',
    'questionIndex',
    'questionText',
    'optionChosen',
    'isCorrect',
    'elapsedMs',
    'attempts',
    'precision',
    'points',
    'runningTotal',
  ];
  const lines = [header.join(',')];
  for (const r of results.rows) {
    lines.push(
      [
        csvCell(r.nickname),
        r.questionIndex,
        csvCell(r.questionText),
        csvCell(r.optionChosen),
        r.isCorrect === '' ? '' : r.isCorrect,
        r.elapsedMs,
        r.attempts,
        r.precision,
        r.points,
        r.runningTotal,
      ].join(','),
    );
  }
  // BOM para que Excel en Windows no destroce los acentos.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function writeResults(paths: Paths, room: Room): ResultsExport | null {
  if (!safeCode(room.code)) return null;
  const results = buildResults(room);
  writeAtomic(join(paths.results, `${room.code}.json`), JSON.stringify(results, null, 2));
  writeAtomic(join(paths.results, `${room.code}.csv`), buildCsv(results));
  return results;
}

export function readResultsFile(paths: Paths, code: string, ext: 'json' | 'csv'): string | null {
  if (!safeCode(code)) return null;
  try {
    return readFileSync(join(paths.results, `${code}.${ext}`), 'utf8');
  } catch {
    return null;
  }
}
