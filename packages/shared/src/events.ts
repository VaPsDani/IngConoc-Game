/**
 * events.ts — Contrato de eventos de Socket.IO. Unico lugar donde vive.
 *
 * Ambos extremos se tipan con estas interfaces:
 *   Server<ClientToServerEvents, ServerToClientEvents>
 *   Socket<ServerToClientEvents, ClientToServerEvents>
 *
 * Nota sobre `PublicQuestion`: es el unico tipo de pregunta que aparece en
 * `ServerToClientEvents`. Como lleva la marca de `toPublic()`, no se puede
 * emitir un `Question` crudo ni por accidente.
 */

import type { OptionId, PublicQuestion, QuestionId } from './quiz.ts';

export type Phase = 'LOBBY' | 'QUESTION_ACTIVE' | 'REVEAL' | 'DISCUSSION' | 'FINAL';

export type SessionId = string;
export type PlayerId = string;

/** Codigos de error que el servidor puede mandar al jugador. */
export type PlayerErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_ALREADY_STARTED'
  | 'BAD_NICKNAME'
  | 'RESUME_FAILED'
  | 'NOT_IN_ROOM'
  | 'ANSWER_TOO_LATE'
  | 'ALREADY_ANSWERED'
  | 'WRONG_QUESTION'
  | 'KICKED'
  | 'RATE_LIMITED';

export type RosterPlayer = {
  id: PlayerId;
  nickname: string;
  connected: boolean;
  score: number;
};

export type LeaderboardRow = {
  playerId: PlayerId;
  nickname: string;
  score: number;
  rank: number;
  streak: number;
};

/** Cuantos eligieron cada opcion. Se manda solo al host, en REVEAL. */
export type AnswerDistribution = {
  optionId: OptionId;
  count: number;
}[];

// ---------------------------------------------------------------------------
// Cliente -> Servidor
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  // --- Host ---
  'host:createSession': (p: { quizId: string }) => void;
  'host:startGame': () => void;
  /** Corta la pregunta antes de que venza el deadline. */
  'host:closeQuestion': () => void;
  'host:reveal': () => void;
  'host:nextQuestion': () => void;
  'host:endGame': () => void;
  /**
   * No estaba en el contrato original; lo exige el boton de expulsar del
   * roster (Tarea 8). Documentado en el reporte como anadido.
   */
  'host:kickPlayer': (p: { playerId: PlayerId }) => void;
  /** Reconexion del host (se guarda igual que la del jugador). */
  'host:resume': (p: { sessionId: SessionId; token: string }) => void;

  // --- Jugador ---
  'player:join': (p: { code: string; nickname: string }) => void;
  'player:resume': (p: { sessionId: SessionId; playerId: PlayerId; token: string }) => void;
  'player:answer': (p: {
    questionId: QuestionId;
    optionId: OptionId;
    /** Telemetria + hasta 100 pts. Falsificable a proposito acotado. */
    precision: number;
    /** Telemetria pura. NO resta puntos. */
    attempts: number;
  }) => void;
  'player:ping': (p: { t0: number }) => void;
}

// ---------------------------------------------------------------------------
// Servidor -> Cliente
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  // --- Host ---
  'host:sessionCreated': (p: {
    sessionId: SessionId;
    code: string;
    joinUrl: string;
    token: string;
    quizTitle: string;
    totalQuestions: number;
  }) => void;
  'host:roster': (p: { players: RosterPlayer[] }) => void;
  'host:answerProgress': (p: { answered: number; total: number }) => void;
  'host:questionState': (p: {
    phase: Phase;
    /** null en LOBBY y FINAL. */
    question: PublicQuestion | null;
    /** Timestamp ABSOLUTO del reloj del servidor. null si no aplica. */
    deadlineAt: number | null;
    answered: number;
    total: number;
  }) => void;
  'host:reveal': (p: {
    questionId: QuestionId;
    correctOptionId: OptionId;
    distribution: AnswerDistribution;
    /** Sin responder. Para que el host vea cuantos se quedaron fuera. */
    noAnswer: number;
    leaderboard: LeaderboardRow[];
  }) => void;
  'host:final': (p: {
    podium: LeaderboardRow[];
    fullLeaderboard: LeaderboardRow[];
  }) => void;
  'host:error': (p: { code: string; message: string }) => void;

  // --- Jugador ---
  'player:joined': (p: {
    sessionId: SessionId;
    playerId: PlayerId;
    token: string;
    nickname: string;
  }) => void;
  'player:state': (p: {
    phase: Phase;
    question?: PublicQuestion;
    /** Timestamp ABSOLUTO del reloj del servidor. */
    deadlineAt?: number;
    myScore: number;
    myRank: number;
    /**
     * Si ya respondio la pregunta actual. Necesario para que al reconectar
     * durante QUESTION_ACTIVE vea la pantalla de espera y no el juego.
     */
    answered: boolean;
    totalPlayers: number;
    /** Resultado de la pregunta anterior; presente en REVEAL y DISCUSSION. */
    lastResult?: PlayerResult;
  }) => void;
  /**
   * Acuse de recibo de una respuesta. NO dice si acerto: el alumno se entera
   * en el reveal, junto con toda la clase. Lleva el elapsedMs medido por el
   * SERVIDOR, que es lo unico que el cliente no puede saber por si mismo.
   *
   * Anadido al contrato original: sin el, la unica forma de confirmar una
   * respuesta era mandar el resultado, que filtraba la correcta antes de tiempo.
   */
  'player:answerAccepted': (p: { questionId: QuestionId; elapsedMs: number }) => void;
  /** Solo se emite en REVEAL, para todos a la vez. */
  'player:result': (p: PlayerResult) => void;
  'player:pong': (p: { t0: number; tServer: number }) => void;
  'player:error': (p: { code: PlayerErrorCode; message: string }) => void;
  'player:kicked': () => void;
}

export type PlayerResult = {
  questionId: QuestionId;
  /**
   * Si llego a responder. Sin esto el cliente no puede distinguir "falle" de
   * "se me acabo el tiempo", y a quien no respondio le decia 'Incorrecto'.
   */
  answered: boolean;
  correct: boolean;
  points: number;
  totalScore: number;
  rank: number;
  streak: number;
};

/** Lo que el jugador guarda en localStorage para poder reconectar. */
export type PlayerCredentials = {
  sessionId: SessionId;
  playerId: PlayerId;
  token: string;
  nickname: string;
};

export type HostCredentials = {
  sessionId: SessionId;
  token: string;
};
