/**
 * App.tsx — Enrutado mínimo por pathname. Sin react-router: son tres pantallas
 * y una dependencia menos que bajan 40 celulares.
 *
 *   /host          proyector
 *   /host/recover  reclamar la sala desde otro dispositivo
 *   /              celular del alumno
 *
 * El fallback SPA de Express devuelve index.html para todas, así que recargar
 * en cualquiera de ellas funciona.
 */

import { lazy, Suspense } from 'react';
import PlayerScreen from './player/PlayerScreen';

// El proyector es un solo navegador: su pantalla (y `qrcode`) se cargan aparte
// para que el bundle que baja el celular no las incluya.
const HostScreen = lazy(() => import('./host/HostScreen'));
const HostRecover = lazy(() => import('./host/HostRecover'));

function Loading() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#061a22] text-3xl text-white/50">
      Cargando…
    </div>
  );
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '');

  if (path === '/host/recover') {
    return (
      <Suspense fallback={<Loading />}>
        <HostRecover />
      </Suspense>
    );
  }
  if (path === '/host') {
    return (
      <Suspense fallback={<Loading />}>
        <HostScreen />
      </Suspense>
    );
  }
  return <PlayerScreen />;
}
