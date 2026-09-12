/**
 * HostRecover.tsx — Reclamar una sala desde otro dispositivo.
 *
 * Caso real: se muere el navegador del proyector a mitad de clase, o el laptop
 * se queda sin batería. La sala sigue viva en el servidor con los puntajes de
 * los 40; esto devuelve el control desde un celular.
 *
 * La clave NUNCA va en la URL: solo en el cuerpo del evento. Una URL con el
 * token acabaría en el historial del navegador y en los logs del proxy.
 */

import { useEffect, useRef, useState } from 'react';
import { normalizeCode } from '@ingconoc/shared';
import { createSocket, hostStore, type GameSocket } from '../net/socket';

export default function HostRecover() {
  const socketRef = useRef<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('host:sessionCreated', (p) => {
      // Se guardan las credenciales y se vuelve al panel normal, que hará
      // host:resume con ellas.
      hostStore.set({
        sessionId: p.sessionId,
        token: p.token,
        hostToken: p.hostToken,
        code: p.code,
      });
      window.location.href = '/host';
    });

    socket.on('host:error', (e) => {
      setSending(false);
      setError(e.message);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, []);

  const submit = () => {
    const c = normalizeCode(code);
    const t = normalizeCode(token);
    if (c.length !== 6 || t.length !== 6) {
      setError('El código y la clave tienen 6 caracteres cada uno');
      return;
    }
    setError(null);
    setSending(true);
    socketRef.current?.emit('host:recover', { code: c, hostToken: t });
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#061a22] p-6 text-white">
      <div className="w-full max-w-md rounded-2xl bg-[#0f3543] p-8 ring-1 ring-white/10">
        <h1 className="text-3xl font-bold">Reclamar sala</h1>
        <p className="mt-2 text-white/60">
          {connected ? 'Conectado al servidor.' : 'Conectando…'} Introduce el código de la sala y la
          clave de recuperación que viste en el lobby.
        </p>

        <label className="mt-6 block text-sm uppercase tracking-wider text-white/50">
          Código de sala
        </label>
        <input
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={6}
          placeholder="ABC234"
          className="mt-1 w-full rounded-xl bg-black/30 px-4 py-4 text-center font-mono text-3xl uppercase tracking-[0.3em] outline-none ring-1 ring-white/15 focus:ring-emerald-400"
        />

        <label className="mt-5 block text-sm uppercase tracking-wider text-white/50">
          Clave de recuperación
        </label>
        <input
          value={token}
          onChange={(e) => setToken(normalizeCode(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={6}
          placeholder="XYZ789"
          className="mt-1 w-full rounded-xl bg-black/30 px-4 py-4 text-center font-mono text-3xl uppercase tracking-[0.3em] outline-none ring-1 ring-white/15 focus:ring-emerald-400"
        />

        {error && <p className="mt-4 text-rose-300">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={!connected || sending}
          className="mt-6 w-full rounded-xl bg-emerald-400 px-6 py-4 text-2xl font-bold text-emerald-950 disabled:opacity-40"
        >
          {sending ? 'Reclamando…' : 'Reclamar el control'}
        </button>

        <p className="mt-4 text-sm text-white/40">
          Al reclamarla, el dispositivo anterior deja de mandar. Nadie pierde puntaje.
        </p>
      </div>
    </main>
  );
}
