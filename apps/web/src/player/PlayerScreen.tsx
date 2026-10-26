/**
 * PlayerScreen.tsx — El celular del alumno. Portrait, una mano.
 *
 * El ENUNCIADO NO SE MUESTRA AQUI, a proposito: va en la pantalla grande. Si
 * estuviera en el celular, 40 personas mirarian hacia abajo toda la clase.
 * Aqui solo estan las 4 opciones, dentro del juego del sapo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClientClock,
  normalizeCode,
  NICKNAME_MAX,
  type Phase,
  type PlayerErrorCode,
  type PlayerResult,
  type PublicQuestion,
} from '@ingconoc/shared';
import FrogGame, { type FrogGameAnswer, type FrogGameOption } from '../game/FrogGame';
import { createSocket, playerStore, syncClock, type GameSocket } from '../net/socket';

type Status =
  | { kind: 'join' }
  | { kind: 'joining' }
  | { kind: 'in' }
  | { kind: 'kicked' }
  | { kind: 'fatal'; message: string };

type ServerState = {
  phase: Phase;
  question?: PublicQuestion;
  deadlineAt?: number;
  myScore: number;
  myRank: number;
  answered: boolean;
  totalPlayers: number;
  hostConnected: boolean;
  lastResult?: PlayerResult;
};

export default function PlayerScreen() {
  const socketRef = useRef<GameSocket | null>(null);
  /** Código con el que se pidió entrar, para guardarlo junto a la sesión. */
  const joinCodeRef = useRef<string | null>(null);
  const clockRef = useRef(new ClientClock());

  const [status, setStatus] = useState<Status>({ kind: 'join' });
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<ServerState | null>(null);
  const [result, setResult] = useState<PlayerResult | null>(null);
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.search).get('c')?.toUpperCase() ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [myNickname, setMyNickname] = useState<string | null>(null);
  /** elapsedMs medido por el SERVIDOR para la pregunta actual. */
  const [myElapsedMs, setMyElapsedMs] = useState<number | null>(null);

  // --- Socket: se monta una vez ------------------------------------------
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    const onConnect = () => {
      setConnected(true);
      // Reconexion: el servidor devuelve el estado completo, incluido si ya
      // respondio esta pregunta. Sin esto se pierde el puntaje acumulado.
      // Un QR de otra sala manda sobre la sesión vieja: sin esto, al empezar
      // una partida nueva el celular volvía a la sala terminada.
      const urlCode = normalizeCode(new URLSearchParams(window.location.search).get('c') ?? '');
      if (urlCode && playerStore.get()?.code !== urlCode) playerStore.clear();
      const saved = playerStore.get();
      if (saved) {
        socket.emit('player:resume', {
          sessionId: saved.sessionId,
          playerId: saved.playerId,
          token: saved.token,
        });
      }
      void syncClock(socket, clockRef.current);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', () => setConnected(false));

    socket.on('player:joined', (p) => {
      playerStore.set({ ...p, code: joinCodeRef.current ?? playerStore.get()?.code });
      setMyNickname(p.nickname);
      setStatus({ kind: 'in' });
      setError(null);
    });

    socket.on('player:state', (p) => {
      setState(p as ServerState);
      setStatus({ kind: 'in' });
      if (p.lastResult) setResult(p.lastResult);
      // Pregunta nueva: se limpia el resultado anterior.
      if (p.phase === 'QUESTION_ACTIVE' && !p.answered) {
        setResult(null);
        setMyElapsedMs(null);
      }
    });

    socket.on('player:answerAccepted', (a) => setMyElapsedMs(a.elapsedMs));
    // Solo llega en el reveal: hasta entonces el alumno no sabe si acerto.
    socket.on('player:result', (r) => setResult(r));

    socket.on('player:kicked', () => {
      playerStore.clear();
      setStatus({ kind: 'kicked' });
    });

    socket.on('player:error', (e) => {
      const code = e.code as PlayerErrorCode;
      // Un resume fallido no es fatal: la partida terminó o la sala se recicló.
      if (code === 'RESUME_FAILED' || code === 'ROOM_NOT_FOUND') {
        playerStore.clear();
        setStatus((s) => (s.kind === 'in' ? s : { kind: 'join' }));
      }
      if (code === 'ALREADY_ANSWERED' || code === 'ANSWER_TOO_LATE') {
        // Ruido esperable en el borde del deadline; no se le grita al alumno.
        return;
      }
      setError(e.message);
      setStatus((s) => (s.kind === 'joining' ? { kind: 'join' } : s));
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  const join = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const cleanCode = normalizeCode(code);
    if (cleanCode.length !== 6) {
      setError('El código tiene 6 caracteres');
      return;
    }
    if (nickname.trim().length === 0) {
      setError('Escribe tu apodo');
      return;
    }
    setError(null);
    setStatus({ kind: 'joining' });
    joinCodeRef.current = cleanCode;
    socket.emit('player:join', { code: cleanCode, nickname });
  }, [code, nickname]);

  const submitAnswer = useCallback((answer: FrogGameAnswer, question: PublicQuestion) => {
    const socket = socketRef.current;
    if (!socket) return;
    // El servidor mide el tiempo con SU reloj; aqui no se manda elapsedMs.
    socket.emit('player:answer', {
      questionId: question.id,
      optionId: answer.optionId,
      precision: answer.precision,
      attempts: answer.attempts,
    });
  }, []);

  // --- Pantallas ----------------------------------------------------------

  if (status.kind === 'kicked') {
    return (
      <Shell>
        <Card>
          <h1 className="text-2xl font-bold">Te sacaron de la sala</h1>
          <p className="mt-2 text-white/60">Habla con quien está proyectando.</p>
        </Card>
      </Shell>
    );
  }

  if (status.kind === 'join' || status.kind === 'joining') {
    return (
      <Shell>
        <Card>
          <h1 className="text-2xl font-bold">Salto del sapo</h1>
          <p className="mt-1 text-sm text-white/50">
            {connected ? 'Conectado' : 'Conectando…'}
          </p>

          <label className="mt-5 block text-left text-xs uppercase tracking-wider text-white/50">
            Código de sala
          </label>
          <input
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={6}
            placeholder="ABC123"
            className="mt-1 w-full rounded-xl bg-black/30 px-4 py-3 text-center font-mono text-2xl tracking-[0.3em] uppercase outline-none ring-1 ring-white/15 focus:ring-emerald-400"
          />

          <label className="mt-4 block text-left text-xs uppercase tracking-wider text-white/50">
            Tu apodo
          </label>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={NICKNAME_MAX}
            placeholder="Nombre"
            className="mt-1 w-full rounded-xl bg-black/30 px-4 py-3 text-center text-lg outline-none ring-1 ring-white/15 focus:ring-emerald-400"
          />

          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

          <button
            type="button"
            onClick={join}
            disabled={!connected || status.kind === 'joining'}
            className="mt-5 w-full rounded-xl bg-emerald-400 px-4 py-3 text-lg font-semibold text-emerald-950 disabled:opacity-40 active:scale-[0.98]"
          >
            {status.kind === 'joining' ? 'Entrando…' : 'Entrar'}
          </button>
        </Card>
      </Shell>
    );
  }

  if (status.kind === 'fatal') {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold">Algo salió mal</h1>
          <p className="mt-2 text-white/60">{status.message}</p>
        </Card>
      </Shell>
    );
  }

  // --- Ya está dentro ----------------------------------------------------
  const phase = state?.phase ?? 'LOBBY';

  return (
    <Shell>
      {!connected && (
        <div className="absolute inset-x-0 top-0 z-20 bg-amber-500/90 py-1 text-center text-xs font-semibold text-amber-950">
          Sin conexión — reconectando…
        </div>
      )}
      {connected && state && !state.hostConnected && (
        <div className="absolute inset-x-0 top-0 z-20 bg-sky-500/90 py-1 text-center text-xs font-semibold text-sky-950">
          Esperando al anfitrión… tu puntaje está a salvo
        </div>
      )}

      {phase === 'LOBBY' && (
        <Card>
          <p className="text-xs uppercase tracking-widest text-white/50">Estás dentro</p>
          <p className="mt-2 text-3xl font-bold text-emerald-300">{myNickname}</p>
          <p className="mt-4 text-white/60">Esperando a que empiece…</p>
          <p className="mt-1 text-sm text-white/40">
            {state?.totalPlayers ?? 1} en la sala
          </p>
        </Card>
      )}

      {phase === 'QUESTION_ACTIVE' && state?.question && !state.answered && (
        <QuestionScreen
          question={state.question}
          deadlineAt={state.deadlineAt}
          clock={clockRef.current}
          onAnswer={(a) => submitAnswer(a, state.question!)}
        />
      )}

      {phase === 'QUESTION_ACTIVE' && state?.answered && (
        <Card>
          <p className="text-xs uppercase tracking-widest text-white/50">Respondido</p>
          <p className="mt-3 text-5xl">✅</p>
          <p className="mt-3 text-white/70">Mira la pantalla grande.</p>
          {myElapsedMs !== null && (
            <p className="mt-2 font-mono text-2xl text-emerald-300">
              {(myElapsedMs / 1000).toFixed(2)} s
            </p>
          )}
          {/* No se dice si acertó: eso se revela para todos a la vez. */}
          <p className="mt-4 text-sm text-white/40">
            Puntaje: <span className="font-mono">{state.myScore}</span> · puesto{' '}
            <span className="font-mono">{state.myRank}</span>
          </p>
        </Card>
      )}

      {(phase === 'REVEAL' || phase === 'DISCUSSION') && (
        <ResultScreen result={result} state={state} />
      )}

      {phase === 'FINAL' && (
        <Card>
          <p className="text-xs uppercase tracking-widest text-white/50">Fin del juego</p>
          <p className="mt-3 text-6xl font-black text-emerald-300">#{state?.myRank ?? '—'}</p>
          <p className="mt-2 text-2xl font-bold">{state?.myScore ?? 0} pts</p>
          <p className="mt-4 text-white/50">{myNickname}</p>
          <p className="mt-4 text-sm text-white/40">El podio está en la pantalla grande.</p>
          <button
            type="button"
            onClick={() => {
              playerStore.clear();
              window.location.href = '/';
            }}
            className="mt-6 w-full rounded-xl bg-white/10 px-4 py-3 font-semibold ring-1 ring-white/20 active:scale-[0.98]"
          >
            Entrar a otra sala
          </button>
        </Card>
      )}
    </Shell>
  );
}

// --- Sub-pantallas -----------------------------------------------------------

function QuestionScreen({
  question,
  deadlineAt,
  clock,
  onAnswer,
}: {
  question: PublicQuestion;
  deadlineAt?: number;
  clock: ClientClock;
  onAnswer: (a: FrogGameAnswer) => void;
}) {
  const options: FrogGameOption[] = useMemo(
    () =>
      question.options.map((o) => ({
        id: o.id,
        label: o.label,
        text: o.text,
        color: o.color,
      })),
    [question],
  );

  // El padre calcula la ventana al montar; el countdown real lo lleva el
  // deadline absoluto del servidor, que FrogGame usa para pintar la barra.
  const timeLimitMs = useMemo(
    () => (deadlineAt ? Math.max(0, deadlineAt - clock.now()) : question.timeLimitMs),
    // Solo al montar / cambiar de pregunta: si se recalcula cada render, la
    // barra saltaria.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [question.id],
  );

  const clockNow = useCallback(() => clock.now(), [clock]);

  return (
    <div className="h-full w-full">
      <FrogGame
        key={question.id}
        options={options}
        timeLimitMs={timeLimitMs}
        deadlineAt={deadlineAt}
        clockNow={clockNow}
        onAnswer={onAnswer}
        onTimeout={() => {
          /* red de seguridad: el servidor ya cerró por su cuenta */
        }}
      />
    </div>
  );
}

function ResultScreen({
  result,
  state,
}: {
  result: PlayerResult | null;
  state: ServerState | null;
}) {
  if (!result || !result.answered) {
    return (
      <Card>
        <p className="text-5xl">⌛</p>
        <p className="mt-3 text-xl font-bold">No respondiste a tiempo</p>
        <p className="mt-2 text-white/60">0 puntos. La racha se reinicia.</p>
        <p className="mt-4 text-sm text-white/40">
          Puntaje: <span className="font-mono">{state?.myScore ?? 0}</span>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p className="text-6xl">{result.correct ? '🎉' : '❌'}</p>
      <p className={`mt-3 text-2xl font-bold ${result.correct ? 'text-emerald-300' : 'text-rose-300'}`}>
        {result.correct ? '¡Correcto!' : 'Incorrecto'}
      </p>
      <p className="mt-2 text-4xl font-black">
        {result.points > 0 ? `+${result.points}` : '0'}
      </p>
      <dl className="mt-5 space-y-2 text-xl text-white/80">
        <Row label="total" value={String(result.totalScore)} />
        <Row label="puesto" value={`#${result.rank}`} />
        <Row label="racha" value={result.streak > 0 ? `${result.streak} 🔥` : '—'} />
      </dl>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="font-mono text-2xl font-bold text-white">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#061a22] text-white">
      {children}
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-xs rounded-2xl bg-[#0f3543] p-6 text-center shadow-2xl ring-1 ring-white/10">
        {children}
      </div>
    </div>
  );
}
