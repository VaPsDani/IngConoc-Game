/**
 * gateway.ts — Capa delgada entre Socket.IO y la maquina de estados.
 *
 * Aqui NO hay reglas del juego: traduccion de eventos a llamadas de `Room`,
 * difusion del estado, timers, y todo el endurecimiento (clave de anfitrion,
 * limites por IP, validacion de payloads, caps y recoleccion de salas).
 * Lo que decide algo vive en room.ts / scoring.ts.
 */

import type { Server, Socket } from 'socket.io';
import {
  generateUniqueCode,
  normalizeCode,
  validateAnswer,
  validateCreateSession,
  validateHostRecover,
  validateJoin,
  validateKick,
  validatePing,
  validateResume,
  type ClientToServerEvents,
  type LeaderboardRow,
  type PlayerErrorCode,
  type Quiz,
  type ServerToClientEvents,
} from '@ingconoc/shared';
import { ANSWER_GRACE_MS, Room } from './room.ts';
import type { Config } from './config.ts';
import { clientIp, IpRateLimiter, type Action } from './ratelimit.ts';
import {
  deleteSnapshot,
  loadSnapshots,
  saveSnapshot,
  writeResults,
  type Paths,
} from './persistence.ts';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

type SocketData = {
  role: 'host' | 'player' | null;
  code: string | null;
  playerId: string | null;
  ip: string;
};

const SWEEP_EVERY_MS = 60_000;

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
  private sweeper: NodeJS.Timeout | null = null;

  private readonly io: IOServer;
  private readonly quizzes: Map<string, Quiz>;
  private readonly config: Config;
  private readonly paths: Paths | null;
  readonly limiter: IpRateLimiter;

  // Campos explicitos, no parameter properties: Node ejecuta este TS quitando
  // tipos y las parameter properties necesitan generar codigo.
  constructor(
    io: IOServer,
    quizzes: Map<string, Quiz>,
    config: Config,
    paths: Paths | null = null,
    limiter: IpRateLimiter = new IpRateLimiter(),
  ) {
    this.io = io;
    this.quizzes = quizzes;
    this.config = config;
    this.paths = paths;
    this.limiter = limiter;
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

  get playerCount(): number {
    let n = 0;
    for (const room of this.byCode.values()) n += room.players.size;
    return n;
  }

  roomByCode(code: string): Room | undefined {
    return this.byCode.get(code);
  }

  /** Recarga las salas del disco al arrancar. */
  restoreFromDisk(now: number = Date.now()): void {
    if (!this.paths) return;
    const report = loadSnapshots(this.paths, this.quizzes, {
      ttlMs: this.config.roomTtlMs,
      maxPlayers: this.config.maxPlayersPerRoom,
      now,
      log: (e, d) => log(e, d),
    });
    for (const room of report.restored) {
      if (this.byCode.size >= this.config.maxRooms) {
        log('snapshot:descartado', { code: room.code, reason: 'cap de salas' });
        continue;
      }
      this.byCode.set(room.code, room);
      this.bySession.set(room.sessionId, room);
      // Si volvio en QUESTION_ACTIVE con deadline vivo, hay que rearmar el timer.
      this.armTimer(room);
      log('snapshot:restaurado', {
        code: room.code,
        phase: room.phase,
        jugadores: room.players.size,
        q: room.questionIndex,
      });
    }
    for (const d of report.discarded) {
      log('snapshot:descartado', { file: d.file, reason: d.reason });
    }
  }

  // --- Utilidades de socket ------------------------------------------------

  private data(socket: IOSocket): SocketData {
    const d = socket.data as Partial<SocketData>;
    if (d.role === undefined) {
      Object.assign(socket.data, {
        role: null,
        code: null,
        playerId: null,
        ip: clientIp(socket.handshake, this.config.trustProxy),
      } satisfies SocketData);
    }
    return socket.data as SocketData;
  }

  /** Limite POR IP. El del Paso 2 se evadia abriendo mas sockets. */
  private allow(socket: IOSocket, action: Action): boolean {
    const ip = this.data(socket).ip;
    const ok = this.limiter.take(ip, action);
    if (!ok) log('ratelimit', { ip, action });
    return ok;
  }

  private roomOf(socket: IOSocket): Room | null {
    const code = this.data(socket).code;
    return code ? (this.byCode.get(code) ?? null) : null;
  }

  private playerError(socket: IOSocket, code: PlayerErrorCode, message: string): void {
    socket.emit('player:error', { code, message });
  }

  private persist(room: Room): void {
    if (!this.paths || !this.config.snapshotEnabled) return;
    try {
      saveSnapshot(this.paths, room, Date.now());
    } catch (err) {
      // Un disco lleno no puede tumbar la partida en curso.
      log('snapshot:error', { code: room.code, err: (err as Error).message });
    }
  }

  private exportResults(room: Room): void {
    if (!this.paths) return;
    try {
      writeResults(this.paths, room);
    } catch (err) {
      log('resultados:error', { code: room.code, err: (err as Error).message });
    }
  }

  // --- Ciclo de vida de la sala -------------------------------------------

  private createRoom(quiz: Quiz): Room | null {
    if (this.byCode.size >= this.config.maxRooms) return null;
    const code = generateUniqueCode((c) => this.byCode.has(c));
    const room = new Room(quiz, code, Date.now(), (event, detail) => log(event, detail), {
      maxPlayers: this.config.maxPlayersPerRoom,
    });
    this.byCode.set(code, room);
    this.bySession.set(room.sessionId, room);
    log('room:created', { code, quiz: quiz.id, salasVivas: this.byCode.size });
    this.persist(room);
    return room;
  }

  private destroyRoom(room: Room, reason: string): void {
    this.clearTimer(room);
    this.byCode.delete(room.code);
    this.bySession.delete(room.sessionId);
    if (this.paths) {
      try {
        deleteSnapshot(this.paths, room.code);
      } catch {
        /* el GC del disco no puede tumbar el proceso */
      }
    }
    log('room:destroyed', {
      code: room.code,
      reason,
      jugadores: room.players.size,
      fase: room.phase,
    });
  }

  /**
   * GC. Sin esto un servidor de 8 h se llena de salas muertas. Dos reglas:
   * TTL absoluto, y salas en LOBBY que nadie tocó (alguien abre /host, ve el
   * código y se va).
   */
  sweep(now: number): void {
    for (const room of [...this.byCode.values()]) {
      const anyoneConnected =
        room.hostSocketId !== null || [...room.players.values()].some((p) => p.connected);
      if (anyoneConnected) room.touch(now);

      if (now - room.createdAt > this.config.roomTtlMs) {
        this.destroyRoom(room, `TTL de ${Math.round(this.config.roomTtlMs / 60_000)} min`);
        continue;
      }
      if (
        room.phase === 'LOBBY' &&
        !anyoneConnected &&
        now - room.lastActivityAt > this.config.lobbyIdleTtlMs
      ) {
        this.destroyRoom(
          room,
          `LOBBY inactivo ${Math.round(this.config.lobbyIdleTtlMs / 60_000)} min`,
        );
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
   * Cierra la pregunta sola en deadline + gracia, para que las respuestas que
   * salieron a tiempo pero llegaron tarde entren en la distribucion.
   */
  private armTimer(room: Room): void {
    this.clearTimer(room);
    if (room.phase !== 'QUESTION_ACTIVE' || room.deadlineAt === null) return;
    const delay = Math.max(0, room.deadlineAt + ANSWER_GRACE_MS - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(room.code);
      if (room.phase !== 'QUESTION_ACTIVE') return;
      if (room.closeQuestion(Date.now()).ok) {
        log('question:auto-closed', { code: room.code, q: room.questionIndex });
        this.afterTransition(room);
      }
    }, delay);
    t.unref?.();
    this.timers.set(room.code, t);
  }

  /**
   * Todo lo que hay que hacer despues de mover la maquina de estados:
   * difundir, exportar si toca y persistir. Un solo sitio para no olvidarse.
   */
  private afterTransition(room: Room): void {
    room.touch(Date.now());
    this.broadcastState(room);
    if (room.phase === 'REVEAL') {
      this.emitReveal(room);
      // Se reescriben en cada reveal: si la clase se corta en la pregunta 3,
      // queda el material de las 3 primeras.
      this.exportResults(room);
    }
    if (room.phase === 'FINAL') {
      this.emitFinal(room);
      this.exportResults(room);
    }
    this.persist(room);
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
      ...(question ? { question } : {}),
      ...(room.deadlineAt !== null ? { deadlineAt: room.deadlineAt } : {}),
      myScore: player.score,
      myRank: room.rankOf(playerId),
      answered: room.hasAnsweredCurrent(playerId),
      totalPlayers: room.players.size,
      hostConnected: room.hostSocketId !== null,
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

  private sessionPayload(room: Room, socket: IOSocket) {
    const base =
      this.config.publicUrl ?? (socket.handshake.headers.origin as string | undefined) ?? '';
    return {
      sessionId: room.sessionId,
      code: room.code,
      joinUrl: `${base}/?c=${room.code}`,
      // Token de reconexion silenciosa de ESTE navegador.
      token: room.sessionId,
      // Clave de recuperacion desde otro dispositivo.
      hostToken: room.hostToken,
      quizTitle: room.quiz.title,
      totalQuestions: room.totalQuestions,
    };
  }

  /** Deja a este socket como anfitrion de la sala y le manda todo el estado. */
  private attachHost(socket: IOSocket, room: Room): void {
    const previous = this.hostSocket(room);
    if (previous && previous.id !== socket.id) {
      // Reclamada desde otro dispositivo: el anterior deja de mandar.
      previous.emit('host:error', {
        code: 'TAKEN_OVER',
        message: 'Otro dispositivo reclamó esta sala',
      });
    }
    room.hostSocketId = socket.id;
    const d = this.data(socket);
    d.role = 'host';
    d.code = room.code;
    room.touch(Date.now());

    socket.emit('host:sessionCreated', this.sessionPayload(room, socket));
    this.emitRoster(room);
    this.broadcastState(room);
    if (room.phase === 'REVEAL') this.emitReveal(room);
    if (room.phase === 'FINAL') this.emitFinal(room);
  }

  // --- Conexiones ----------------------------------------------------------

  private onConnection(socket: IOSocket): void {
    this.data(socket);

    // ---------------- Host ----------------

    socket.on('host:createSession', (payload) => {
      if (!this.allow(socket, 'create')) {
        socket.emit('host:error', { code: 'RATE_LIMITED', message: 'Demasiados intentos' });
        return;
      }
      const v = validateCreateSession(payload);
      if (!v.ok) {
        socket.emit('host:error', { code: 'BAD_PAYLOAD', message: `Campo inválido: ${v.field}` });
        return;
      }
      // La clave del anfitrion es lo que impide que cualquiera cree salas en
      // bucle hasta llenar la memoria. Sin ella no hay sesion.
      if (payload.hostKey !== this.config.hostKey) {
        log('host:key-rechazada', { ip: this.data(socket).ip });
        socket.emit('host:error', { code: 'BAD_HOST_KEY', message: 'Clave de anfitrión inválida' });
        return;
      }
      const quiz = this.quizzes.get(payload.quizId) ?? [...this.quizzes.values()][0];
      if (!quiz) {
        socket.emit('host:error', { code: 'NO_QUIZ', message: 'No hay cuestionarios cargados' });
        return;
      }
      const room = this.createRoom(quiz);
      if (!room) {
        socket.emit('host:error', {
          code: 'TOO_MANY_ROOMS',
          message: `Ya hay ${this.config.maxRooms} salas vivas en este servidor`,
        });
        return;
      }
      this.attachHost(socket, room);
    });

    socket.on('host:resume', (payload) => {
      if (!this.allow(socket, 'other')) return;
      if (typeof payload?.sessionId !== 'string' || payload.sessionId.length > 64) {
        socket.emit('host:error', { code: 'BAD_PAYLOAD', message: 'sessionId inválido' });
        return;
      }
      const room = this.bySession.get(payload.sessionId);
      if (!room || payload.token !== room.sessionId) {
        socket.emit('host:error', { code: 'RESUME_FAILED', message: 'Sesión no encontrada' });
        return;
      }
      this.attachHost(socket, room);
      log('host:resumed', { code: room.code });
    });

    /** Reclamar la sala desde otro dispositivo. Requiere código + clave. */
    socket.on('host:recover', (payload) => {
      if (!this.allow(socket, 'recover')) {
        socket.emit('host:error', { code: 'RATE_LIMITED', message: 'Demasiados intentos' });
        return;
      }
      const v = validateHostRecover(payload);
      if (!v.ok) {
        socket.emit('host:error', { code: 'BAD_PAYLOAD', message: `Campo inválido: ${v.field}` });
        return;
      }
      const room = this.byCode.get(normalizeCode(payload.code));
      const token = normalizeCode(payload.hostToken);
      if (!room || room.hostToken !== token) {
        // Mismo mensaje para sala inexistente y clave mala: no se filtra si el
        // código existe.
        log('host:recover-fallido', { ip: this.data(socket).ip });
        socket.emit('host:error', {
          code: 'RECOVER_FAILED',
          message: 'Código o clave de recuperación incorrectos',
        });
        return;
      }
      this.attachHost(socket, room);
      log('host:recovered', { code: room.code, ip: this.data(socket).ip });
    });

    const hostAction = (action: (room: Room) => void) => () => {
      if (!this.allow(socket, 'other')) return;
      const room = this.roomOf(socket);
      if (!room || this.data(socket).role !== 'host') return;
      if (room.hostSocketId !== socket.id) return; // solo el anfitrión actual manda
      action(room);
    };

    socket.on(
      'host:startGame',
      hostAction((room) => {
        if (!room.startGame(Date.now()).ok) return;
        this.armTimer(room);
        this.afterTransition(room);
      }),
    );

    socket.on(
      'host:closeQuestion',
      hostAction((room) => {
        if (!room.closeQuestion(Date.now()).ok) return;
        this.clearTimer(room);
        this.afterTransition(room);
      }),
    );

    socket.on(
      'host:reveal',
      hostAction((room) => {
        if (!room.reveal(Date.now()).ok) return;
        this.clearTimer(room);
        this.afterTransition(room);
      }),
    );

    socket.on(
      'host:nextQuestion',
      hostAction((room) => {
        if (!room.nextQuestion(Date.now()).ok) return;
        if (room.phase === 'QUESTION_ACTIVE') this.armTimer(room);
        this.afterTransition(room);
      }),
    );

    socket.on(
      'host:endGame',
      hostAction((room) => {
        if (!room.endGame().ok) return;
        this.clearTimer(room);
        this.afterTransition(room);
      }),
    );

    socket.on('host:kickPlayer', (payload) => {
      if (!this.allow(socket, 'other')) return;
      if (!validateKick(payload).ok) return;
      const room = this.roomOf(socket);
      if (!room || this.data(socket).role !== 'host' || room.hostSocketId !== socket.id) return;
      const player = room.players.get(payload.playerId);
      if (!room.kickPlayer(payload.playerId).ok) return;
      if (player?.socketId) {
        const s = this.io.sockets.sockets.get(player.socketId) as IOSocket | undefined;
        s?.emit('player:kicked');
        if (s) {
          const sd = this.data(s);
          sd.code = null;
          sd.playerId = null;
          sd.role = null;
        }
      }
      this.emitRoster(room);
      this.emitProgress(room);
      this.afterTransition(room);
    });

    // ---------------- Jugador ----------------

    socket.on('player:join', (payload) => {
      if (!this.allow(socket, 'join')) {
        this.playerError(socket, 'RATE_LIMITED', 'Demasiados intentos, espera unos segundos');
        return;
      }
      const v = validateJoin(payload);
      if (!v.ok) {
        this.playerError(socket, 'BAD_NICKNAME', `Campo inválido: ${v.field}`);
        return;
      }
      const room = this.byCode.get(normalizeCode(payload.code));
      if (!room) {
        this.playerError(socket, 'ROOM_NOT_FOUND', 'No existe esa sala');
        return;
      }
      const r = room.addPlayer(payload.nickname, Date.now());
      if (!r.ok) {
        this.playerError(socket, r.code as PlayerErrorCode, r.message);
        return;
      }
      const d = this.data(socket);
      d.role = 'player';
      d.code = room.code;
      d.playerId = r.player.id;
      room.setConnected(r.player.id, true, socket.id);
      room.touch(Date.now());

      socket.emit('player:joined', {
        sessionId: room.sessionId,
        playerId: r.player.id,
        token: r.player.token,
        nickname: r.player.nickname,
      });
      this.emitPlayerState(room, r.player.id);
      this.emitRoster(room);
      this.emitProgress(room);
      this.persist(room);
    });

    socket.on('player:resume', (payload) => {
      if (!this.allow(socket, 'join')) {
        this.playerError(socket, 'RATE_LIMITED', 'Demasiados intentos');
        return;
      }
      const v = validateResume(payload);
      if (!v.ok) {
        this.playerError(socket, 'RESUME_FAILED', `Campo inválido: ${v.field}`);
        return;
      }
      const room = this.bySession.get(payload.sessionId);
      if (!room) {
        this.playerError(socket, 'ROOM_NOT_FOUND', 'Esa partida ya terminó');
        return;
      }
      const r = room.resumePlayer(payload.playerId, payload.token);
      if (!r.ok) {
        this.playerError(socket, 'RESUME_FAILED', r.message);
        return;
      }
      const d = this.data(socket);
      d.role = 'player';
      d.code = room.code;
      d.playerId = payload.playerId;
      room.setConnected(payload.playerId, true, socket.id);

      socket.emit('player:joined', {
        sessionId: room.sessionId,
        playerId: r.player.id,
        token: r.player.token,
        nickname: r.player.nickname,
      });
      this.emitPlayerState(room, payload.playerId);
      this.emitRoster(room);
    });

    socket.on('player:answer', (payload) => {
      if (!this.allow(socket, 'answer')) {
        this.playerError(socket, 'RATE_LIMITED', 'Demasiados eventos');
        return;
      }
      if (!validateAnswer(payload).ok) {
        this.playerError(socket, 'WRONG_QUESTION', 'Respuesta mal formada');
        return;
      }
      const room = this.roomOf(socket);
      const playerId = this.data(socket).playerId;
      if (!room || !playerId) {
        this.playerError(socket, 'NOT_IN_ROOM', 'No estás en una sala');
        return;
      }
      const r = room.submitAnswer(playerId, payload, Date.now());
      if (!r.ok) {
        this.playerError(socket, r.code as PlayerErrorCode, r.message);
        return;
      }
      // Acuse SIN correctitud: el alumno se entera en el reveal, con la clase.
      socket.emit('player:answerAccepted', {
        questionId: r.record.questionId,
        elapsedMs: r.record.elapsedMs,
      });
      room.touch(Date.now());
      this.emitProgress(room);
      this.emitPlayerState(room, playerId);
      this.persist(room);

      if (room.answeredCount() >= room.players.size && room.players.size > 0) {
        if (room.closeQuestion(Date.now()).ok) {
          this.clearTimer(room);
          log('question:all-answered', { code: room.code, q: room.questionIndex });
          this.afterTransition(room);
        }
      }
    });

    socket.on('player:ping', (payload) => {
      if (!this.allow(socket, 'ping')) return;
      if (!validatePing(payload).ok) return;
      socket.emit('player:pong', { t0: payload.t0, tServer: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      const d = this.data(socket);
      const room = this.roomOf(socket);
      if (!room) return;
      if (d.role === 'host' && room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        log('host:disconnected', { code: room.code, reason });
        // La sala sigue viva. Los jugadores ven "esperando al anfitrión".
        this.broadcastState(room);
        return;
      }
      if (d.role === 'player' && d.playerId) {
        room.setConnected(d.playerId, false, null);
        log('player:disconnected', { code: room.code, playerId: d.playerId, reason });
        this.emitRoster(room);
      }
    });
  }
}
