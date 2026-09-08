/**
 * gateway.ts — Capa delgada entre Socket.IO y la maquina de estados.
 *
 * Aqui NO hay reglas del juego: solo traduccion de eventos a llamadas de
 * `Room`, difusion del estado y los timers que la sala no puede tener porque
 * es pura. Todo lo que decide algo vive en room.ts / scoring.ts.
 */

import type { Server, Socket } from 'socket.io';
import {
  generateUniqueCode,
  normalizeCode,
  type ClientToServerEvents,
  type LeaderboardRow,
  type PlayerErrorCode,
  type Quiz,
  type ServerToClientEvents,
} from '@ingconoc/shared';
import { ANSWER_GRACE_MS, Room } from './room.ts';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Lo que el gateway cuelga de cada socket. */
type SocketData = {
  role: 'host' | 'player' | null;
  code: string | null;
  playerId: string | null;
  /** Token bucket contra clientes que inundan. */
  budget: number;
  budgetAt: number;
};

const ROOM_TTL_MS = 4 * 60 * 60 * 1000; // 4 h
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000; // 30 min sin nadie conectado
const SWEEP_EVERY_MS = 60_000;

/** ~20 eventos/s sostenidos por socket; de sobra para jugar. */
const RATE_BUDGET = 40;
const RATE_REFILL_PER_SEC = 20;

export function log(event: string, detail: Record<string, unknown> = {}): void {
  const line = Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  console.log(`[${new Date().toISOString()}] ${event} ${line}`);
}

export class Gateway {
  private readonly byCode = new Map<string, Room>();
  private readonly bySession = new Map<string, Room>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSeen = new Map<string, number>();
  private sweeper: NodeJS.Timeout | null = null;

  private readonly io: IOServer;
  private readonly quizzes: Map<string, Quiz>;
  private readonly publicWebUrl: string | null;

  // Campos explicitos, no parameter properties: Node ejecuta este TS quitando
  // tipos y las parameter properties necesitan generar codigo.
  constructor(io: IOServer, quizzes: Map<string, Quiz>, publicWebUrl: string | null = null) {
    this.io = io;
    this.quizzes = quizzes;
    this.publicWebUrl = publicWebUrl;
  }

  attach(): void {
    this.io.on('connection', (socket) => this.onConnection(socket));
    this.sweeper = setInterval(() => this.sweep(Date.now()), SWEEP_EVERY_MS);
    this.sweeper.unref?.();
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get roomCount(): number {
    return this.byCode.size;
  }

  // --- Utilidades de socket ------------------------------------------------

  private data(socket: IOSocket): SocketData {
    const d = socket.data as Partial<SocketData>;
    if (d.role === undefined) {
      Object.assign(socket.data, {
        role: null,
        code: null,
        playerId: null,
        budget: RATE_BUDGET,
        budgetAt: Date.now(),
      } satisfies SocketData);
    }
    return socket.data as SocketData;
  }

  /** Token bucket. Devuelve false si el socket se paso de vueltas. */
  private allow(socket: IOSocket): boolean {
    const d = this.data(socket);
    const now = Date.now();
    const refill = ((now - d.budgetAt) / 1000) * RATE_REFILL_PER_SEC;
    d.budget = Math.min(RATE_BUDGET, d.budget + refill);
    d.budgetAt = now;
    if (d.budget < 1) return false;
    d.budget -= 1;
    return true;
  }

  private roomOf(socket: IOSocket): Room | null {
    const code = this.data(socket).code;
    return code ? (this.byCode.get(code) ?? null) : null;
  }

  private playerError(socket: IOSocket, code: PlayerErrorCode, message: string): void {
    socket.emit('player:error', { code, message });
  }

  // --- Ciclo de vida de la sala -------------------------------------------

  private createRoom(quiz: Quiz): Room {
    const code = generateUniqueCode((c) => this.byCode.has(c));
    const room = new Room(quiz, code, Date.now(), (event, detail) => log(event, detail));
    this.byCode.set(code, room);
    this.bySession.set(room.sessionId, room);
    this.lastSeen.set(code, Date.now());
    log('room:created', { code, quiz: quiz.id });
    return room;
  }

  private destroyRoom(room: Room, reason: string): void {
    this.clearTimer(room);
    this.byCode.delete(room.code);
    this.bySession.delete(room.sessionId);
    this.lastSeen.delete(room.code);
    log('room:destroyed', { code: room.code, reason });
  }

  /** Recoge salas abandonadas. Sin esto, un servidor de 8 h se llena de basura. */
  private sweep(now: number): void {
    for (const room of [...this.byCode.values()]) {
      const anyoneConnected =
        room.hostSocketId !== null || [...room.players.values()].some((p) => p.connected);
      if (anyoneConnected) {
        this.lastSeen.set(room.code, now);
        continue;
      }
      const idleSince = this.lastSeen.get(room.code) ?? room.createdAt;
      if (now - room.createdAt > ROOM_TTL_MS || now - idleSince > EMPTY_ROOM_TTL_MS) {
        this.destroyRoom(room, 'abandonada');
      }
    }
  }

  // --- Timers de pregunta --------------------------------------------------

  private clearTimer(room: Room): void {
    const t = this.timers.get(room.code);
    if (t) {
      clearTimeout(t);
      this.timers.delete(room.code);
    }
  }

  /**
   * Cierra la pregunta sola cuando vence el deadline MAS la gracia, para que
   * las respuestas que salieron a tiempo pero llegaron tarde alcancen a entrar
   * en la distribucion que ve el host.
   */
  private armTimer(room: Room): void {
    this.clearTimer(room);
    if (room.phase !== 'QUESTION_ACTIVE' || room.deadlineAt === null) return;
    const delay = Math.max(0, room.deadlineAt + ANSWER_GRACE_MS - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(room.code);
      if (room.phase !== 'QUESTION_ACTIVE') return;
      const r = room.closeQuestion(Date.now());
      if (r.ok) {
        log('question:auto-closed', { code: room.code, q: room.questionIndex });
        this.broadcastState(room);
        this.emitReveal(room);
      }
    }, delay);
    t.unref?.();
    this.timers.set(room.code, t);
  }

  // --- Difusion ------------------------------------------------------------

  private hostSocket(room: Room): IOSocket | null {
    if (!room.hostSocketId) return null;
    return (this.io.sockets.sockets.get(room.hostSocketId) as IOSocket) ?? null;
  }

  private emitRoster(room: Room): void {
    this.hostSocket(room)?.emit('host:roster', { players: room.roster() });
  }

  private emitProgress(room: Room): void {
    this.hostSocket(room)?.emit('host:answerProgress', {
      answered: room.answeredCount(),
      total: room.players.size,
    });
  }

  /** Estado a todos: el host ve el agregado, cada jugador ve el suyo. */
  private broadcastState(room: Room): void {
    this.hostSocket(room)?.emit('host:questionState', {
      phase: room.phase,
      question: room.publicQuestion(),
      deadlineAt: room.deadlineAt,
      answered: room.answeredCount(),
      total: room.players.size,
    });
    for (const player of room.players.values()) {
      this.emitPlayerState(room, player.id);
    }
  }

  private emitPlayerState(room: Room, playerId: string): void {
    const player = room.players.get(playerId);
    if (!player?.socketId) return;
    const socket = this.io.sockets.sockets.get(player.socketId) as IOSocket | undefined;
    if (!socket) return;

    const question = room.publicQuestion();
    const lastResult = room.resultFor(playerId);

    socket.emit('player:state', {
      phase: room.phase,
      // El enunciado va en la pantalla grande; al celular solo le hace falta
      // la pregunta para pintar las 4 opciones del juego.
      ...(question ? { question } : {}),
      ...(room.deadlineAt !== null ? { deadlineAt: room.deadlineAt } : {}),
      myScore: player.score,
      myRank: room.rankOf(playerId),
      answered: room.hasAnsweredCurrent(playerId),
      totalPlayers: room.players.size,
      ...(room.phase === 'REVEAL' || room.phase === 'DISCUSSION'
        ? lastResult
          ? { lastResult }
          : {}
        : {}),
    });
  }

  private emitReveal(room: Room): void {
    const correctOptionId = room.correctOptionIdForCurrent();
    const questionId = room.currentQuestionId();
    if (!correctOptionId || !questionId) return;
    const { distribution, noAnswer } = room.distribution();

    this.hostSocket(room)?.emit('host:reveal', {
      questionId,
      correctOptionId,
      distribution,
      noAnswer,
      leaderboard: room.leaderboard().slice(0, 5),
    });

    // A cada jugador, su resultado. Quien no respondio recibe 0 y racha rota.
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      const socket = this.io.sockets.sockets.get(player.socketId) as IOSocket | undefined;
      if (!socket) continue;
      const result = room.resultFor(player.id);
      socket.emit('player:result', {
        questionId,
        answered: result !== undefined,
        correct: result?.correct ?? false,
        points: result?.points ?? 0,
        totalScore: player.score,
        rank: room.rankOf(player.id),
        streak: player.streak,
      });
    }
  }

  private emitFinal(room: Room): void {
    const full: LeaderboardRow[] = room.leaderboard();
    this.hostSocket(room)?.emit('host:final', {
      podium: full.slice(0, 3),
      fullLeaderboard: full,
    });
  }

  // --- Conexiones ----------------------------------------------------------

  private onConnection(socket: IOSocket): void {
    this.data(socket);

    // ---------------- Host ----------------

    socket.on('host:createSession', ({ quizId }) => {
      if (!this.allow(socket)) return;
      const quiz = this.quizzes.get(quizId) ?? [...this.quizzes.values()][0];
      if (!quiz) {
        socket.emit('host:error', { code: 'NO_QUIZ', message: 'No hay cuestionarios cargados' });
        return;
      }
      const room = this.createRoom(quiz);
      room.hostSocketId = socket.id;
      const d = this.data(socket);
      d.role = 'host';
      d.code = room.code;

      const base = this.publicWebUrl ?? (socket.handshake.headers.origin as string) ?? '';
      socket.emit('host:sessionCreated', {
        sessionId: room.sessionId,
        code: room.code,
        joinUrl: `${base}/?c=${room.code}`,
        token: room.hostToken,
        quizTitle: room.quiz.title,
        totalQuestions: room.totalQuestions,
      });
      this.emitRoster(room);
      this.broadcastState(room);
    });

    socket.on('host:resume', ({ sessionId, token }) => {
      if (!this.allow(socket)) return;
      const room = this.bySession.get(sessionId);
      if (!room || room.hostToken !== token) {
        socket.emit('host:error', { code: 'RESUME_FAILED', message: 'Sesión no encontrada' });
        return;
      }
      room.hostSocketId = socket.id;
      const d = this.data(socket);
      d.role = 'host';
      d.code = room.code;
      const base = this.publicWebUrl ?? (socket.handshake.headers.origin as string) ?? '';
      socket.emit('host:sessionCreated', {
        sessionId: room.sessionId,
        code: room.code,
        joinUrl: `${base}/?c=${room.code}`,
        token: room.hostToken,
        quizTitle: room.quiz.title,
        totalQuestions: room.totalQuestions,
      });
      this.emitRoster(room);
      this.broadcastState(room);
      if (room.phase === 'REVEAL') this.emitReveal(room);
      if (room.phase === 'FINAL') this.emitFinal(room);
      log('host:resumed', { code: room.code });
    });

    const hostAction = (action: (room: Room) => void) => () => {
      if (!this.allow(socket)) return;
      const room = this.roomOf(socket);
      if (!room || this.data(socket).role !== 'host') return;
      if (room.hostSocketId !== socket.id) return; // solo el host manda
      action(room);
    };

    socket.on(
      'host:startGame',
      hostAction((room) => {
        const r = room.startGame(Date.now());
        if (!r.ok) return;
        this.armTimer(room);
        this.broadcastState(room);
      }),
    );

    socket.on(
      'host:closeQuestion',
      hostAction((room) => {
        const r = room.closeQuestion(Date.now());
        if (!r.ok) return;
        this.clearTimer(room);
        this.broadcastState(room);
        this.emitReveal(room);
      }),
    );

    socket.on(
      'host:reveal',
      hostAction((room) => {
        const r = room.reveal(Date.now());
        if (!r.ok) return;
        this.clearTimer(room);
        this.broadcastState(room);
        this.emitReveal(room);
      }),
    );

    socket.on(
      'host:nextQuestion',
      hostAction((room) => {
        const r = room.nextQuestion(Date.now());
        if (!r.ok) return;
        if (room.phase === 'QUESTION_ACTIVE') this.armTimer(room);
        this.broadcastState(room);
        if (room.phase === 'FINAL') this.emitFinal(room);
      }),
    );

    socket.on(
      'host:endGame',
      hostAction((room) => {
        const r = room.endGame();
        if (!r.ok) return;
        this.clearTimer(room);
        this.broadcastState(room);
        this.emitFinal(room);
      }),
    );

    socket.on('host:kickPlayer', ({ playerId }) => {
      if (!this.allow(socket)) return;
      const room = this.roomOf(socket);
      if (!room || this.data(socket).role !== 'host' || room.hostSocketId !== socket.id) return;
      const player = room.players.get(playerId);
      const r = room.kickPlayer(playerId);
      if (!r.ok) return;
      if (player?.socketId) {
        const s = this.io.sockets.sockets.get(player.socketId) as IOSocket | undefined;
        s?.emit('player:kicked');
        const sd = s ? this.data(s) : null;
        if (sd) {
          sd.code = null;
          sd.playerId = null;
          sd.role = null;
        }
      }
      this.emitRoster(room);
      this.emitProgress(room);
      this.broadcastState(room);
    });

    // ---------------- Jugador ----------------

    socket.on('player:join', ({ code, nickname }) => {
      if (!this.allow(socket)) return;
      const room = this.byCode.get(normalizeCode(code ?? ''));
      if (!room) {
        this.playerError(socket, 'ROOM_NOT_FOUND', 'No existe esa sala');
        return;
      }
      const r = room.addPlayer(nickname ?? '', Date.now());
      if (!r.ok) {
        this.playerError(socket, r.code as PlayerErrorCode, r.message);
        return;
      }
      const d = this.data(socket);
      d.role = 'player';
      d.code = room.code;
      d.playerId = r.player.id;
      room.setConnected(r.player.id, true, socket.id);

      socket.emit('player:joined', {
        sessionId: room.sessionId,
        playerId: r.player.id,
        token: r.player.token,
        nickname: r.player.nickname,
      });
      this.emitPlayerState(room, r.player.id);
      this.emitRoster(room);
      this.emitProgress(room);
    });

    socket.on('player:resume', ({ sessionId, playerId, token }) => {
      if (!this.allow(socket)) return;
      const room = this.bySession.get(sessionId);
      if (!room) {
        this.playerError(socket, 'ROOM_NOT_FOUND', 'Esa partida ya terminó');
        return;
      }
      const r = room.resumePlayer(playerId, token);
      if (!r.ok) {
        this.playerError(socket, 'RESUME_FAILED', r.message);
        return;
      }
      const d = this.data(socket);
      d.role = 'player';
      d.code = room.code;
      d.playerId = playerId;
      room.setConnected(playerId, true, socket.id);

      socket.emit('player:joined', {
        sessionId: room.sessionId,
        playerId: r.player.id,
        token: r.player.token,
        nickname: r.player.nickname,
      });
      // Estado COMPLETO: fase, pregunta, deadline, puntaje, puesto y si ya
      // respondio. Con esto el cliente se repinta exactamente donde estaba.
      this.emitPlayerState(room, playerId);
      this.emitRoster(room);
    });

    socket.on('player:answer', (payload) => {
      if (!this.allow(socket)) {
        this.playerError(socket, 'RATE_LIMITED', 'Demasiados eventos');
        return;
      }
      const room = this.roomOf(socket);
      const playerId = this.data(socket).playerId;
      if (!room || !playerId) {
        this.playerError(socket, 'NOT_IN_ROOM', 'No estás en una sala');
        return;
      }
      // El reloj es el del SERVIDOR. El cliente no manda tiempo.
      const r = room.submitAnswer(playerId, payload, Date.now());
      if (!r.ok) {
        this.playerError(socket, r.code as PlayerErrorCode, r.message);
        return;
      }
      // NO se manda player:result aqui: revelaria si acerto antes que al
      // resto de la clase. Solo el acuse con el tiempo del servidor.
      socket.emit('player:answerAccepted', {
        questionId: r.record.questionId,
        elapsedMs: r.record.elapsedMs,
      });
      this.emitProgress(room);
      this.emitPlayerState(room, playerId);

      // Si ya respondieron todos, no tiene sentido esperar al reloj.
      if (room.answeredCount() >= room.players.size && room.players.size > 0) {
        const closed = room.closeQuestion(Date.now());
        if (closed.ok) {
          this.clearTimer(room);
          log('question:all-answered', { code: room.code, q: room.questionIndex });
          this.broadcastState(room);
          this.emitReveal(room);
        }
      }
    });

    socket.on('player:ping', ({ t0 }) => {
      // El ping no consume presupuesto completo: son 3 al entrar y alguno mas.
      if (!this.allow(socket)) return;
      socket.emit('player:pong', { t0, tServer: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      const d = this.data(socket);
      const room = this.roomOf(socket);
      if (!room) return;
      if (d.role === 'host' && room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        log('host:disconnected', { code: room.code, reason });
        return;
      }
      if (d.role === 'player' && d.playerId) {
        // NO se borra al jugador: conserva puntaje y puede reconectar.
        room.setConnected(d.playerId, false, null);
        log('player:disconnected', { code: room.code, playerId: d.playerId, reason });
        this.emitRoster(room);
      }
    });
  }
}
