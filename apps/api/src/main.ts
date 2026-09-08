/**
 * main.ts — Arranque del servidor. Express + Socket.IO, salas en memoria.
 *
 * Corre con `node src/main.ts`: Node 22.18+ ejecuta TypeScript directamente
 * quitando los tipos, asi que no hace falta ni bundler ni `tsx`.
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@ingconoc/shared';
import { Gateway, log } from './gateway.ts';
import { loadQuizzes } from './quizzes.ts';

const PORT = Number(process.env.PORT ?? 3001);
const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL ?? null;

// Si un cuestionario esta mal, esto lanza y el proceso no levanta. A proposito.
const quizzes = loadQuizzes();
log('quizzes:loaded', {
  count: quizzes.size,
  ids: [...quizzes.keys()].join(','),
});

const app = express();

app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    rooms: gateway.roomCount,
    rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
    heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
  });
});

app.get('/api/quizzes', (_req, res) => {
  res.json(
    [...quizzes.values()].map((q) => ({
      id: q.id,
      title: q.title,
      questions: q.questions.length,
    })),
  );
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // WiFi de universidad: la LAN entera es de confianza y el origen del host
  // cambia con la IP. No hay nada que proteger que no proteja ya el token.
  cors: { origin: true, credentials: false },
  // Un celular que se va al fondo y vuelve no debe perder la sesion enseguida.
  pingInterval: 20_000,
  pingTimeout: 25_000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 60_000,
    skipMiddlewares: true,
  },
});

const gateway = new Gateway(io, quizzes, PUBLIC_WEB_URL);
gateway.attach();

httpServer.listen(PORT, '0.0.0.0', () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);
  log('api:listening', { port: PORT, lan: addrs.join(' ') });
});

function shutdown(signal: string): void {
  log('api:shutdown', { signal });
  gateway.close();
  io.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
