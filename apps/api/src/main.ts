/**
 * main.ts — Arranque. Express sirve la web Y Socket.IO en el MISMO origen.
 *
 * Un solo origen elimina CORS por completo, hace que WSS herede el TLS de
 * Caddy y deja una sola URL para el QR. En dev, Vite sigue en :5173 y el
 * cliente apunta a :3001; en produccion todo sale del mismo sitio.
 *
 * Corre con `node src/main.ts`: Node 22.18+ ejecuta TypeScript directamente
 * quitando los tipos, asi que no hace falta ni bundler ni `tsx`.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from 'socket.io';
import { normalizeCode, type ClientToServerEvents, type ServerToClientEvents } from '@ingconoc/shared';
import { loadConfig } from './config.ts';
import { Gateway, log } from './gateway.ts';
import { loadQuizzes } from './quizzes.ts';
import { ensureDirs, readResultsFile } from './persistence.ts';

// Si falta HOST_KEY o un cuestionario está mal, esto lanza y el proceso no
// levanta. A propósito: mejor no arrancar que arrancar inseguro o mintiendo.
const config = loadConfig();
const quizzes = loadQuizzes();
const paths = ensureDirs(config.dataDir);

log('quizzes:loaded', { count: quizzes.size, ids: [...quizzes.keys()].join(',') });
log('config', {
  port: config.port,
  maxRooms: config.maxRooms,
  maxPlayersPerRoom: config.maxPlayersPerRoom,
  dataDir: config.dataDir,
  webDist: config.webDist ?? '(ninguno: modo dev)',
  trustProxy: config.trustProxy,
  snapshot: config.snapshotEnabled,
});

const app = express();
app.disable('x-powered-by');
// Detrás de Caddy la IP real viene en X-Forwarded-For.
if (config.trustProxy) app.set('trust proxy', 1);

/**
 * Cabeceras de seguridad a mano (helmet no está permitido como dep nueva).
 * La CSP es permisiva a propósito: el juego usa canvas, blobs para la descarga
 * de resultados y data: URIs para el QR. Lo que sí cierra es el origen de los
 * scripts, que es por donde entraría un XSS.
 */
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Vite inyecta estilos en línea; Tailwind los genera.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      // El QR se genera en el cliente como data: URI.
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // WSS al propio origen. En dev también ws: para el HMR de Vite.
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
});

app.use(express.json({ limit: '8kb' }));

// --- Salud ------------------------------------------------------------------

app.get('/healthz', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: gateway.roomCount,
    players: gateway.playerCount,
    rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
    heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
  });
});

// Alias del Paso 2, para no romper nada que ya apunte ahí.
app.get('/health', (_req, res) => res.redirect(308, '/healthz'));

app.get('/api/quizzes', (_req, res) => {
  res.json(
    [...quizzes.values()].map((q) => ({ id: q.id, title: q.title, questions: q.questions.length })),
  );
});

// --- Descarga de resultados -------------------------------------------------

/**
 * POST y no GET: la clave de recuperación va en el CUERPO, nunca en la URL.
 * Una URL con el token acabaría en el historial, en los logs de Caddy y en el
 * Referer. El cliente arma un Blob con la respuesta y dispara la descarga.
 */
function resultsHandler(ext: 'json' | 'csv') {
  return (req: Request, res: Response): void => {
    const code = normalizeCode(String(req.params.code ?? ''));
    const hostToken = normalizeCode(String((req.body as { hostToken?: unknown })?.hostToken ?? ''));
    const room = gateway.roomByCode(code);

    if (!room || room.hostToken !== hostToken) {
      res.status(403).json({ error: 'Código o clave de recuperación incorrectos' });
      return;
    }
    const content = readResultsFile(paths, code, ext);
    if (content === null) {
      res.status(404).json({ error: 'Todavía no hay resultados para esa sala' });
      return;
    }
    res.setHeader(
      'Content-Type',
      ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${code}.${ext}"`);
    res.send(content);
  };
}

app.post('/api/results/:code.json', resultsHandler('json'));
app.post('/api/results/:code.csv', resultsHandler('csv'));

// --- Web estática, mismo origen --------------------------------------------

if (config.webDist && existsSync(config.webDist)) {
  // Los assets llevan hash en el nombre: se pueden cachear para siempre.
  app.use(
    express.static(config.webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${'assets'}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Fallback SPA: /host, /host/recover y cualquier ruta del cliente devuelven
  // index.html. Se excluye /api y /socket.io para no tragarse el backend.
  app.get(/^\/(?!api\/|socket\.io\/|healthz).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(config.webDist!, 'index.html'));
  });
  log('web:served', { dist: config.webDist });
}

// --- Socket.IO en el mismo servidor HTTP ------------------------------------

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // Mismo origen en producción, así que no hace falta CORS. En dev el cliente
  // vive en :5173, y ahí sí se permite.
  ...(config.webDist ? {} : { cors: { origin: true, credentials: false } }),
  // 8 KB: ningún payload legítimo pasa de unos cientos de bytes. Corta de raíz
  // el envío de basura en volumen.
  maxHttpBufferSize: 8192,
  pingInterval: 20_000,
  pingTimeout: 25_000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 60_000,
    skipMiddlewares: true,
  },
});

const gateway = new Gateway(io, quizzes, config, paths);
gateway.attach();
gateway.restoreFromDisk();

httpServer.listen(config.port, '0.0.0.0', () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${config.port}`);
  log('api:listening', { port: config.port, lan: addrs.join(' ') });
});

function shutdown(signal: string): void {
  log('api:shutdown', { signal });
  gateway.close();
  io.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
