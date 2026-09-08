/**
 * HostScreen.tsx — La pantalla del proyector. Texto grande, alto contraste.
 *
 * Se lee desde el fondo del salon, asi que todo lo importante (codigo, opciones,
 * countdown) va en tamanos que se ven a 10 metros.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientClock,
  type AnswerDistribution,
  type LeaderboardRow,
  type OptionId,
  type Phase,
  type PublicQuestion,
  type QuestionId,
  type RosterPlayer,
} from '@ingconoc/shared';
import { createSocket, hostStore, syncClock, type GameSocket } from '../net/socket';

type Session = {
  sessionId: string;
  code: string;
  joinUrl: string;
  quizTitle: string;
  totalQuestions: number;
};

type HostAction =
  | 'host:startGame'
  | 'host:closeQuestion'
  | 'host:reveal'
  | 'host:nextQuestion'
  | 'host:endGame';

type Reveal = {
  questionId: QuestionId;
  correctOptionId: OptionId;
  distribution: AnswerDistribution;
  noAnswer: number;
  leaderboard: LeaderboardRow[];
};

export default function HostScreen() {
  const socketRef = useRef<GameSocket | null>(null);
  const clockRef = useRef(new ClientClock());

  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [phase, setPhase] = useState<Phase>('LOBBY');
  const [question, setQuestion] = useState<PublicQuestion | null>(null);
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [progress, setProgress] = useState({ answered: 0, total: 0 });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [final, setFinal] = useState<{ podium: LeaderboardRow[]; full: LeaderboardRow[] } | null>(
    null,
  );

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      const saved = hostStore.get();
      // El host tambien reconecta: si se cae el navegador del proyector, la
      // sala sigue viva en el servidor con todos los puntajes.
      if (saved) socket.emit('host:resume', saved);
      else socket.emit('host:createSession', { quizId: 'ic-demo' });
      void syncClock(socket, clockRef.current);
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('host:sessionCreated', (p) => {
      hostStore.set({ sessionId: p.sessionId, token: p.token });
      setSession({
        sessionId: p.sessionId,
        code: p.code,
        joinUrl: p.joinUrl,
        quizTitle: p.quizTitle,
        totalQuestions: p.totalQuestions,
      });
    });

    socket.on('host:error', () => {
      // Sesion vieja que ya no existe: se pide una nueva.
      hostStore.clear();
      socket.emit('host:createSession', { quizId: 'ic-demo' });
    });

    socket.on('host:roster', (p) => setRoster(p.players));
    socket.on('host:answerProgress', (p) => setProgress(p));
    socket.on('host:questionState', (p) => {
      setPhase(p.phase);
      setQuestion(p.question);
      setDeadlineAt(p.deadlineAt);
      setProgress({ answered: p.answered, total: p.total });
      if (p.phase === 'QUESTION_ACTIVE') setReveal(null);
    });
    socket.on('host:reveal', (p) => setReveal(p));
    socket.on('host:final', (p) => setFinal({ podium: p.podium, full: p.fullLeaderboard }));

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  /** Los controles del host son todos eventos sin payload. */
  const emit = useCallback((event: HostAction) => {
    socketRef.current?.emit(event);
  }, []);

  const newSession = useCallback(() => {
    hostStore.clear();
    setFinal(null);
    setReveal(null);
    setRoster([]);
    setPhase('LOBBY');
    socketRef.current?.emit('host:createSession', { quizId: 'ic-demo' });
  }, []);

  return (
    <main className="min-h-[100dvh] w-full bg-[#061a22] text-white">
      {!connected && (
        <div className="bg-amber-500 py-2 text-center text-lg font-bold text-amber-950">
          Sin conexión con el servidor — reconectando…
        </div>
      )}

      {!session && (
        <Centered>
          <p className="text-3xl text-white/60">Creando sala…</p>
        </Centered>
      )}

      {session && phase === 'LOBBY' && (
        <Lobby session={session} roster={roster} onStart={() => emit('host:startGame')} onKick={(id) => socketRef.current?.emit('host:kickPlayer', { playerId: id })} />
      )}

      {session && phase === 'QUESTION_ACTIVE' && question && (
        <ActiveQuestion
          question={question}
          deadlineAt={deadlineAt}
          clock={clockRef.current}
          progress={progress}
          onClose={() => emit('host:closeQuestion')}
        />
      )}

      {session && (phase === 'REVEAL' || phase === 'DISCUSSION') && question && (
        <RevealView
          question={question}
          reveal={reveal}
          phase={phase}
          onNext={() => emit('host:nextQuestion')}
          onEnd={() => emit('host:endGame')}
        />
      )}

      {session && phase === 'FINAL' && <FinalView final={final} onNew={newSession} />}
    </main>
  );
}

// --- Lobby -------------------------------------------------------------------

function Lobby({
  session,
  roster,
  onStart,
  onKick,
}: {
  session: Session;
  roster: RosterPlayer[];
  onStart: () => void;
  onKick: (id: string) => void;
}) {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Import dinamico: `qrcode` solo lo baja el proyector, no los 40 celulares.
    void import('qrcode').then((mod) =>
      mod.default
        .toDataURL(session.joinUrl, { width: 420, margin: 1, color: { dark: '#061a22', light: '#ffffff' } })
        .then((url) => alive && setQr(url))
        .catch(() => alive && setQr(null)),
    );
    return () => {
      alive = false;
    };
  }, [session.joinUrl]);

  return (
    <div className="flex min-h-[100dvh] flex-col p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold text-white/80">{session.quizTitle}</h1>
        <span className="text-xl text-white/40">{session.totalQuestions} preguntas</span>
      </header>

      <div className="mt-6 grid flex-1 grid-cols-1 gap-8 lg:grid-cols-[1fr_1fr]">
        <div className="flex flex-col items-center justify-center">
          <p className="text-2xl uppercase tracking-[0.3em] text-white/50">Código</p>
          <p className="mt-2 font-mono text-[9rem] leading-none font-black tracking-[0.08em] text-emerald-300">
            {session.code}
          </p>
          <p className="mt-6 text-2xl text-white/60">{session.joinUrl}</p>
          {qr && (
            <img
              src={qr}
              alt={`Código QR para entrar a la sala ${session.code}`}
              className="mt-6 w-64 rounded-2xl bg-white p-3"
            />
          )}
        </div>

        <div className="flex flex-col">
          <div className="flex items-baseline justify-between">
            <h2 className="text-3xl font-bold">En la sala</h2>
            <span className="text-5xl font-black text-emerald-300">{roster.length}</span>
          </div>
          <ul className="mt-4 flex flex-1 flex-wrap content-start gap-3 overflow-y-auto">
            {roster.map((p) => (
              <li
                key={p.id}
                className={`group flex items-center gap-2 rounded-full px-4 py-2 text-2xl ring-1 ${
                  p.connected ? 'bg-white/10 ring-white/15' : 'bg-white/5 text-white/40 ring-white/10'
                }`}
              >
                {p.nickname}
                <button
                  type="button"
                  onClick={() => onKick(p.id)}
                  title={`Expulsar a ${p.nickname}`}
                  aria-label={`Expulsar a ${p.nickname}`}
                  className="rounded-full px-2 text-lg text-white/25 hover:bg-rose-500 hover:text-white"
                >
                  ✕
                </button>
              </li>
            ))}
            {roster.length === 0 && (
              <li className="text-2xl text-white/30">Esperando a que entren…</li>
            )}
          </ul>
          <button
            type="button"
            onClick={onStart}
            disabled={roster.length === 0}
            className="mt-6 rounded-2xl bg-emerald-400 px-8 py-6 text-4xl font-black text-emerald-950 disabled:opacity-30"
          >
            Empezar
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Pregunta activa ---------------------------------------------------------

function ActiveQuestion({
  question,
  deadlineAt,
  clock,
  progress,
  onClose,
}: {
  question: PublicQuestion;
  deadlineAt: number | null;
  clock: ClientClock;
  progress: { answered: number; total: number };
  onClose: () => void;
}) {
  const [leftMs, setLeftMs] = useState(() =>
    deadlineAt ? Math.max(0, deadlineAt - clock.now()) : question.timeLimitMs,
  );

  useEffect(() => {
    if (!deadlineAt) return;
    // Se recalcula contra el reloj del servidor, no se decrementa un contador:
    // asi no deriva aunque el navegador del proyector pierda frames.
    const id = setInterval(() => setLeftMs(Math.max(0, deadlineAt - clock.now())), 100);
    return () => clearInterval(id);
  }, [deadlineAt, clock]);

  const frac = question.timeLimitMs > 0 ? leftMs / question.timeLimitMs : 0;
  const seconds = Math.ceil(leftMs / 1000);

  return (
    <div className="flex min-h-[100dvh] flex-col p-8">
      <div className="flex items-center justify-between text-2xl text-white/50">
        <span>
          Pregunta {question.index + 1} de {question.total}
        </span>
        <span>
          <span className="text-emerald-300 font-bold">{progress.answered}</span> de{' '}
          {progress.total} respondieron
        </span>
      </div>

      <div className="mt-3 h-4 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            frac > 0.35 ? 'bg-emerald-400' : frac > 0.15 ? 'bg-amber-400' : 'bg-rose-500'
          }`}
          style={{ width: `${Math.max(0, frac * 100)}%` }}
        />
      </div>

      <h1 className="mt-8 text-balance text-center text-6xl font-bold leading-tight">
        {question.prompt}
      </h1>

      <div className="mt-auto grid grid-cols-2 gap-6 pt-8">
        {question.options.map((o) => (
          <div
            key={o.id}
            className="flex items-center gap-5 rounded-3xl p-6 text-4xl font-semibold text-[#06222b]"
            style={{ backgroundColor: o.color }}
          >
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-black/20 text-5xl font-black">
              {o.label}
            </span>
            <span className="text-balance">{o.text}</span>
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <span className="font-mono text-8xl font-black tabular-nums">{seconds}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-2xl bg-white/10 px-8 py-5 text-3xl font-bold ring-1 ring-white/20 hover:bg-white/20"
        >
          Cerrar ahora
        </button>
      </div>
    </div>
  );
}

// --- Reveal / Discusión ------------------------------------------------------

function RevealView({
  question,
  reveal,
  phase,
  onNext,
  onEnd,
}: {
  question: PublicQuestion;
  reveal: Reveal | null;
  phase: Phase;
  onNext: () => void;
  onEnd: () => void;
}) {
  const total = reveal
    ? reveal.distribution.reduce((a, d) => a + d.count, 0) + reveal.noAnswer
    : 0;
  const max = reveal ? Math.max(1, ...reveal.distribution.map((d) => d.count)) : 1;

  return (
    <div className="flex min-h-[100dvh] flex-col p-8">
      <div className="flex items-center justify-between text-2xl text-white/50">
        <span>
          Pregunta {question.index + 1} de {question.total}
        </span>
        <span className="uppercase tracking-widest">
          {phase === 'DISCUSSION' ? 'Discusión' : 'Respuesta'}
        </span>
      </div>

      <h1 className="mt-4 text-balance text-center text-5xl font-bold leading-tight">
        {question.prompt}
      </h1>

      <div className="mt-8 grid flex-1 grid-cols-1 gap-8 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          {question.options.map((o) => {
            const count = reveal?.distribution.find((d) => d.optionId === o.id)?.count ?? 0;
            const isCorrect = reveal?.correctOptionId === o.id;
            return (
              <div key={o.id} className="flex items-center gap-4">
                <span
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-3xl font-black text-[#06222b]"
                  style={{ backgroundColor: o.color }}
                >
                  {o.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <span
                      className={`truncate text-3xl ${isCorrect ? 'font-bold text-emerald-300' : 'text-white/70'}`}
                    >
                      {o.text} {isCorrect && '✓'}
                    </span>
                    <span className="shrink-0 font-mono text-3xl tabular-nums">{count}</span>
                  </div>
                  <div className="mt-1 h-6 w-full overflow-hidden rounded-lg bg-white/10">
                    <div
                      className="h-full rounded-lg transition-[width] duration-500"
                      style={{
                        width: `${(count / max) * 100}%`,
                        backgroundColor: isCorrect ? '#34d399' : o.color,
                        opacity: isCorrect ? 1 : 0.5,
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
          {reveal && reveal.noAnswer > 0 && (
            <p className="pt-2 text-2xl text-white/40">
              {reveal.noAnswer} sin responder · {total} en la sala
            </p>
          )}
        </div>

        <div>
          <h2 className="text-3xl font-bold text-white/80">Top 5</h2>
          <ol className="mt-4 space-y-2">
            {(reveal?.leaderboard ?? []).map((r) => (
              <li
                key={r.playerId}
                className="flex items-baseline justify-between rounded-xl bg-white/5 px-4 py-3 text-3xl"
              >
                <span className="truncate">
                  <span className="mr-3 font-mono text-white/40">{r.rank}</span>
                  {r.nickname}
                </span>
                <span className="font-mono tabular-nums text-emerald-300">{r.score}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-8 flex gap-4">
        <button
          type="button"
          onClick={onNext}
          className="flex-1 rounded-2xl bg-emerald-400 px-8 py-6 text-4xl font-black text-emerald-950"
        >
          {phase === 'REVEAL' ? 'Discutir' : 'Siguiente'}
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="rounded-2xl bg-white/10 px-8 py-6 text-2xl font-bold ring-1 ring-white/20"
        >
          Terminar
        </button>
      </div>
    </div>
  );
}

// --- Final -------------------------------------------------------------------

function FinalView({
  final,
  onNew,
}: {
  final: { podium: LeaderboardRow[]; full: LeaderboardRow[] } | null;
  onNew: () => void;
}) {
  const podium = final?.podium ?? [];
  // Orden visual del podio: 2 - 1 - 3.
  const order = [podium[1], podium[0], podium[2]];
  const heights = ['h-40', 'h-56', 'h-32'];
  const medals = ['🥈', '🥇', '🥉'];

  return (
    <div className="flex min-h-[100dvh] flex-col p-8">
      <h1 className="text-center text-6xl font-black text-emerald-300">Podio</h1>

      <div className="mt-10 flex items-end justify-center gap-6">
        {order.map((row, i) =>
          row ? (
            <div key={row.playerId} className="flex w-56 flex-col items-center">
              <span className="text-6xl">{medals[i]}</span>
              <span className="mt-2 max-w-full truncate text-3xl font-bold">{row.nickname}</span>
              <span className="font-mono text-4xl text-emerald-300">{row.score}</span>
              <div
                className={`mt-3 w-full rounded-t-2xl bg-gradient-to-t from-emerald-900 to-emerald-500 ${heights[i]}`}
              />
            </div>
          ) : (
            <div key={`empty-${i}`} className="w-56" />
          ),
        )}
      </div>

      <div className="mt-10 flex-1 overflow-y-auto">
        <table className="w-full text-2xl">
          <thead className="text-white/40">
            <tr>
              <th className="w-20 py-2 text-left">#</th>
              <th className="py-2 text-left">Jugador</th>
              <th className="py-2 text-right">Racha</th>
              <th className="w-40 py-2 text-right">Puntos</th>
            </tr>
          </thead>
          <tbody>
            {(final?.full ?? []).map((r) => (
              <tr key={r.playerId} className="border-t border-white/10">
                <td className="py-2 font-mono text-white/50">{r.rank}</td>
                <td className="py-2">{r.nickname}</td>
                <td className="py-2 text-right text-white/50">{r.streak > 0 ? r.streak : '—'}</td>
                <td className="py-2 text-right font-mono tabular-nums text-emerald-300">
                  {r.score}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={onNew}
        className="mt-6 rounded-2xl bg-white/10 px-8 py-5 text-3xl font-bold ring-1 ring-white/20"
      >
        Nueva sala
      </button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[100dvh] items-center justify-center">{children}</div>;
}
