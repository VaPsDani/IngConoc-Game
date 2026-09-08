/**
 * room.ts — Maquina de estados de la sala. Sin sockets, sin timers, sin IO.
 *
 * Todo el tiempo entra por parametro (`now`), asi que los tests controlan el
 * reloj y no hay `setTimeout` que esperar. El gateway de Socket.IO es una capa
 * delgada encima: traduce eventos a llamadas de aqui y difunde el estado.
 *
 *   LOBBY -> QUESTION_ACTIVE -> REVEAL -> DISCUSSION -> (QUESTION_ACTIVE | FINAL)
 *
 * Transiciones invalidas se IGNORAN y se loguean. Que llegue un evento tarde
 * (host con doble clic, cliente reconectando con estado viejo) no puede tumbar
 * una sala con 40 personas dentro.
 */

import {
  correctOptionId,
  dedupeNickname,
  isValidNickname,
  sanitizeNickname,
  toPublic,
  type AnswerDistribution,
  type LeaderboardRow,
  type OptionId,
  type Phase,
  type PlayerErrorCode,
  type PlayerId,
  type PlayerResult,
  type PublicQuestion,
  type Question,
  type QuestionId,
  type Quiz,
  type RosterPlayer,
} from '@ingconoc/shared';
import { computePoints } from './scoring.ts';

/** Gracia para respuestas que salieron a tiempo pero llegaron tarde. */
export const ANSWER_GRACE_MS = 1500;

export const MAX_PLAYERS = 60;

export type AnswerRecord = {
  questionId: QuestionId;
  optionId: OptionId;
  correct: boolean;
  points: number;
  /** Medido con el reloj del SERVIDOR. Lo que reporte el cliente se ignora. */
  elapsedMs: number;
  /** Telemetria: lo que dijo el cliente. Solo aporta hasta 100 pts. */
  precision: number;
  /** Telemetria pura. No afecta el puntaje. */
  attempts: number;
  receivedAt: number;
  /** Si llego dentro de la gracia post-deadline. */
  late: boolean;
};

export type Player = {
  id: PlayerId;
  token: string;
  nickname: string;
  score: number;
  streak: number;
  bestStreak: number;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  answers: Map<QuestionId, AnswerRecord>;
};

export type Ok<T> = { ok: true } & T;
export type Fail = { ok: false; code: PlayerErrorCode | 'INVALID_TRANSITION'; message: string };
export type Result<T> = Ok<T> | Fail;

export type RoomLogger = (event: string, detail: Record<string, unknown>) => void;

const noopLogger: RoomLogger = () => {};

/** Ids opacos. `crypto` es global en Node 18+ y en el navegador. */
function newId(): string {
  return crypto.randomUUID();
}

export class Room {
  readonly sessionId: string;
  readonly code: string;
  readonly quiz: Quiz;
  readonly createdAt: number;
  /** Token del host, para que pueda reconectar sin perder la sala. */
  readonly hostToken: string;

  phase: Phase = 'LOBBY';
  questionIndex = -1;
  /** Timestamp ABSOLUTO del servidor. null fuera de QUESTION_ACTIVE. */
  deadlineAt: number | null = null;
  questionStartedAt: number | null = null;
  hostSocketId: string | null = null;

  readonly players = new Map<PlayerId, Player>();
  private readonly log: RoomLogger;

  constructor(quiz: Quiz, code: string, now: number, log: RoomLogger = noopLogger) {
    this.sessionId = newId();
    this.hostToken = newId();
    this.quiz = quiz;
    this.code = code;
    this.createdAt = now;
    this.log = log;
  }

  // --- Consultas -----------------------------------------------------------

  get totalQuestions(): number {
    return this.quiz.questions.length;
  }

  /** Pregunta actual en su forma PRIVADA. Nunca sale de esta clase. */
  private currentQuestion(): Question | null {
    if (this.questionIndex < 0 || this.questionIndex >= this.totalQuestions) return null;
    return this.quiz.questions[this.questionIndex];
  }

  /** Pregunta actual lista para el cable. Sin `isCorrect`, por construccion. */
  publicQuestion(): PublicQuestion | null {
    const q = this.currentQuestion();
    return q ? toPublic(q, this.questionIndex, this.totalQuestions) : null;
  }

  currentQuestionId(): QuestionId | null {
    return this.currentQuestion()?.id ?? null;
  }

  currentTimeLimitMs(): number {
    const q = this.currentQuestion();
    return q ? q.timeLimitSec * 1000 : 0;
  }

  /** Jugadores que ya respondieron la pregunta actual. */
  answeredCount(): number {
    const qid = this.currentQuestionId();
    if (!qid) return 0;
    let n = 0;
    for (const p of this.players.values()) if (p.answers.has(qid)) n++;
    return n;
  }

  roster(): RosterPlayer[] {
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, nickname: p.nickname, connected: p.connected, score: p.score }));
  }

  /**
   * Tabla ordenada. Empates: mas puntaje, luego menos tiempo acumulado, luego
   * apodo. Los empatados comparten puesto (1, 2, 2, 4).
   */
  leaderboard(): LeaderboardRow[] {
    const totalElapsed = (p: Player) =>
      [...p.answers.values()].reduce((acc, a) => acc + a.elapsedMs, 0);

    const sorted = [...this.players.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = totalElapsed(a);
      const tb = totalElapsed(b);
      if (ta !== tb) return ta - tb;
      return a.nickname.localeCompare(b.nickname);
    });

    const rows: LeaderboardRow[] = [];
    let lastScore: number | null = null;
    let lastRank = 0;
    sorted.forEach((p, i) => {
      const rank = p.score === lastScore ? lastRank : i + 1;
      lastScore = p.score;
      lastRank = rank;
      rows.push({
        playerId: p.id,
        nickname: p.nickname,
        score: p.score,
        rank,
        streak: p.streak,
      });
    });
    return rows;
  }

  rankOf(playerId: PlayerId): number {
    return this.leaderboard().find((r) => r.playerId === playerId)?.rank ?? 0;
  }

  /** Distribucion de respuestas de la pregunta actual, para el host. */
  distribution(): { distribution: AnswerDistribution; noAnswer: number } {
    const q = this.currentQuestion();
    if (!q) return { distribution: [], noAnswer: 0 };
    const counts = new Map<OptionId, number>(q.options.map((o) => [o.id, 0]));
    let answered = 0;
    for (const p of this.players.values()) {
      const a = p.answers.get(q.id);
      if (!a) continue;
      answered++;
      counts.set(a.optionId, (counts.get(a.optionId) ?? 0) + 1);
    }
    return {
      distribution: q.options.map((o) => ({ optionId: o.id, count: counts.get(o.id) ?? 0 })),
      noAnswer: this.players.size - answered,
    };
  }

  correctOptionIdForCurrent(): OptionId | null {
    const q = this.currentQuestion();
    return q ? correctOptionId(q) : null;
  }

  /** El resultado del jugador para la pregunta actual, si respondio. */
  resultFor(playerId: PlayerId): PlayerResult | undefined {
    const qid = this.currentQuestionId();
    const p = this.players.get(playerId);
    if (!qid || !p) return undefined;
    const a = p.answers.get(qid);
    if (!a) return undefined;
    return {
      questionId: a.questionId,
      answered: true,
      correct: a.correct,
      points: a.points,
      totalScore: p.score,
      rank: this.rankOf(playerId),
      streak: p.streak,
    };
  }

  hasAnsweredCurrent(playerId: PlayerId): boolean {
    const qid = this.currentQuestionId();
    if (!qid) return false;
    return this.players.get(playerId)?.answers.has(qid) ?? false;
  }

  // --- Jugadores -----------------------------------------------------------

  addPlayer(rawNickname: string, now: number): Result<{ player: Player }> {
    if (this.phase !== 'LOBBY') {
      return this.reject('GAME_ALREADY_STARTED', 'La partida ya empezó', { rawNickname });
    }
    if (this.players.size >= MAX_PLAYERS) {
      return this.reject('ROOM_FULL', 'La sala está llena', { size: this.players.size });
    }
    const clean = sanitizeNickname(rawNickname);
    if (!isValidNickname(clean)) {
      return this.reject('BAD_NICKNAME', 'Apodo vacío o inválido', { rawNickname });
    }
    const taken = new Set([...this.players.values()].map((p) => p.nickname));
    const nickname = dedupeNickname(clean, taken);

    const player: Player = {
      id: newId(),
      token: newId(),
      nickname,
      score: 0,
      streak: 0,
      bestStreak: 0,
      connected: true,
      socketId: null,
      joinedAt: now,
      answers: new Map(),
    };
    this.players.set(player.id, player);
    this.log('player:joined', { code: this.code, playerId: player.id, nickname });
    return { ok: true, player };
  }

  /**
   * Reconexion. Es la diferencia entre perder el WiFi 5 s y perder la partida.
   */
  resumePlayer(playerId: PlayerId, token: string): Result<{ player: Player }> {
    const player = this.players.get(playerId);
    if (!player || player.token !== token) {
      return this.reject('RESUME_FAILED', 'No se pudo restaurar la sesión', { playerId });
    }
    player.connected = true;
    this.log('player:resumed', { code: this.code, playerId, nickname: player.nickname });
    return { ok: true, player };
  }

  setConnected(playerId: PlayerId, connected: boolean, socketId: string | null): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    p.socketId = socketId;
  }

  /** Expulsar. El puntaje se va con el jugador: no queda en la tabla. */
  kickPlayer(playerId: PlayerId): Result<{ player: Player }> {
    const player = this.players.get(playerId);
    if (!player) {
      return this.reject('NOT_IN_ROOM', 'Ese jugador no está en la sala', { playerId });
    }
    this.players.delete(playerId);
    this.log('player:kicked', { code: this.code, playerId, nickname: player.nickname });
    return { ok: true, player };
  }

  // --- Respuestas ----------------------------------------------------------

  /**
   * Una respuesta por pregunta, terminal. El `elapsedMs` lo mide el servidor.
   *
   * Se acepta si la pregunta sigue activa y `now <= deadline + ANSWER_GRACE_MS`.
   * Dentro de la gracia el `elapsedMs` se clampea al limite, para que la
   * latencia de la red no regale ni quite puntos.
   */
  submitAnswer(
    playerId: PlayerId,
    input: { questionId: QuestionId; optionId: OptionId; precision: number; attempts: number },
    now: number,
  ): Result<{ result: PlayerResult; record: AnswerRecord }> {
    const player = this.players.get(playerId);
    if (!player) return this.reject('NOT_IN_ROOM', 'No estás en la sala', { playerId });

    const q = this.currentQuestion();
    if (this.phase !== 'QUESTION_ACTIVE' || !q || this.deadlineAt === null) {
      return this.reject('ANSWER_TOO_LATE', 'La pregunta ya cerró', {
        playerId,
        phase: this.phase,
      });
    }
    if (input.questionId !== q.id) {
      return this.reject('WRONG_QUESTION', 'Respuesta de otra pregunta', {
        playerId,
        got: input.questionId,
        expected: q.id,
      });
    }
    if (player.answers.has(q.id)) {
      return this.reject('ALREADY_ANSWERED', 'Ya respondiste esta pregunta', { playerId });
    }
    if (now > this.deadlineAt + ANSWER_GRACE_MS) {
      return this.reject('ANSWER_TOO_LATE', 'Llegó fuera de la ventana de gracia', {
        playerId,
        lateBy: now - this.deadlineAt,
      });
    }
    if (!q.options.some((o) => o.id === input.optionId)) {
      return this.reject('WRONG_QUESTION', 'Esa opción no existe', {
        playerId,
        optionId: input.optionId,
      });
    }

    const timeLimitMs = q.timeLimitSec * 1000;
    const startedAt = this.questionStartedAt ?? now;
    const late = now > this.deadlineAt;
    // Clamp: la gracia no puede dar mas tiempo del que tenia la pregunta.
    const elapsedMs = Math.min(Math.max(now - startedAt, 0), timeLimitMs);

    const correct = correctOptionId(q) === input.optionId;
    const nextStreak = correct ? player.streak + 1 : 0;
    const points = correct
      ? computePoints({ elapsedMs, timeLimitMs, precision: input.precision, streak: nextStreak })
      : 0;

    player.streak = nextStreak;
    player.bestStreak = Math.max(player.bestStreak, nextStreak);
    player.score += points;

    const record: AnswerRecord = {
      questionId: q.id,
      optionId: input.optionId,
      correct,
      points,
      elapsedMs,
      precision: input.precision,
      attempts: input.attempts,
      receivedAt: now,
      late,
    };
    player.answers.set(q.id, record);

    return {
      ok: true,
      record,
      result: {
        questionId: q.id,
        answered: true,
        correct,
        points,
        totalScore: player.score,
        rank: this.rankOf(playerId),
        streak: player.streak,
      },
    };
  }

  // --- Transiciones --------------------------------------------------------

  /**
   * MAPEO DE EVENTOS A TRANSICIONES
   *
   * El contrato listaba 5 eventos de host pero la maquina solo tiene 4 aristas,
   * asi que hubo que decidir. Elegido:
   *
   *   startGame      LOBBY                  -> QUESTION_ACTIVE(0)
   *   closeQuestion  QUESTION_ACTIVE        -> REVEAL        (corta antes de tiempo)
   *   [deadline]     QUESTION_ACTIVE        -> REVEAL        (lo dispara el gateway)
   *   reveal         QUESTION_ACTIVE        -> REVEAL        (atajo, = closeQuestion)
   *                  REVEAL                 -> REVEAL        (idempotente, reenvia)
   *   nextQuestion   REVEAL                 -> DISCUSSION
   *                  DISCUSSION             -> QUESTION_ACTIVE(n+1) | FINAL
   *   endGame        cualquiera menos FINAL -> FINAL
   *
   * Es decir: el host tiene un solo boton "siguiente" que avanza REVEAL ->
   * DISCUSSION -> siguiente pregunta. DISCUSSION no tiene timeout.
   */

  startGame(now: number): Result<{ phase: Phase }> {
    if (this.phase !== 'LOBBY') return this.invalid('startGame');
    if (this.totalQuestions === 0) return this.invalid('startGame:sin-preguntas');
    if (this.players.size === 0) return this.invalid('startGame:sin-jugadores');
    this.questionIndex = 0;
    this.openCurrentQuestion(now);
    return { ok: true, phase: this.phase };
  }

  closeQuestion(now: number): Result<{ phase: Phase }> {
    if (this.phase !== 'QUESTION_ACTIVE') return this.invalid('closeQuestion');
    // Cerrar antes de tiempo mueve el deadline a ahora: la gracia se mide
    // desde el corte real, no desde el limite original.
    this.deadlineAt = Math.min(this.deadlineAt ?? now, now);
    this.phase = 'REVEAL';
    this.log('phase', { code: this.code, phase: this.phase, q: this.questionIndex });
    return { ok: true, phase: this.phase };
  }

  reveal(now: number): Result<{ phase: Phase }> {
    if (this.phase === 'QUESTION_ACTIVE') return this.closeQuestion(now);
    if (this.phase === 'REVEAL') return { ok: true, phase: this.phase };
    return this.invalid('reveal');
  }

  nextQuestion(now: number): Result<{ phase: Phase }> {
    if (this.phase === 'REVEAL') {
      this.phase = 'DISCUSSION';
      this.deadlineAt = null;
      this.log('phase', { code: this.code, phase: this.phase, q: this.questionIndex });
      return { ok: true, phase: this.phase };
    }
    if (this.phase === 'DISCUSSION') {
      if (this.questionIndex + 1 >= this.totalQuestions) {
        this.phase = 'FINAL';
        this.deadlineAt = null;
        this.questionStartedAt = null;
        this.log('phase', { code: this.code, phase: this.phase });
        return { ok: true, phase: this.phase };
      }
      this.questionIndex += 1;
      this.openCurrentQuestion(now);
      return { ok: true, phase: this.phase };
    }
    return this.invalid('nextQuestion');
  }

  endGame(): Result<{ phase: Phase }> {
    if (this.phase === 'FINAL') return this.invalid('endGame');
    this.phase = 'FINAL';
    this.deadlineAt = null;
    this.questionStartedAt = null;
    this.log('phase', { code: this.code, phase: this.phase });
    return { ok: true, phase: this.phase };
  }

  /** ¿Venció el deadline, con gracia incluida? Lo consulta el gateway. */
  isExpired(now: number): boolean {
    return (
      this.phase === 'QUESTION_ACTIVE' &&
      this.deadlineAt !== null &&
      now > this.deadlineAt + ANSWER_GRACE_MS
    );
  }

  private openCurrentQuestion(now: number): void {
    const q = this.currentQuestion();
    if (!q) throw new Error('openCurrentQuestion sin pregunta');
    this.phase = 'QUESTION_ACTIVE';
    this.questionStartedAt = now;
    this.deadlineAt = now + q.timeLimitSec * 1000;
    this.log('phase', {
      code: this.code,
      phase: this.phase,
      q: this.questionIndex,
      deadlineAt: this.deadlineAt,
    });
  }

  private invalid(action: string): Fail {
    this.log('transition:ignored', { code: this.code, action, phase: this.phase });
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `"${action}" no es válido en ${this.phase}`,
    };
  }

  private reject(
    code: PlayerErrorCode,
    message: string,
    detail: Record<string, unknown>,
  ): Fail {
    this.log('rejected', { code, ...detail });
    return { ok: false, code, message };
  }
}
