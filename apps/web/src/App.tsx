/**
 * App.tsx — Enrutado minimo por pathname. Sin react-router: son dos pantallas
 * y una dependencia menos que bajan 40 celulares.
 *
 *   /host  -> proyector
 *   /      -> celular del alumno
 */

import { lazy, Suspense } from 'react';
import PlayerScreen from './player/PlayerScreen';

// El proyector es un solo navegador: su pantalla (y `qrcode`) se cargan aparte
// para que el bundle que baja el celular no las incluya.
const HostScreen = lazy(() => import('./host/HostScreen'));

export default function App() {
  const isHost = window.location.pathname.replace(/\/+$/, '') === '/host';

  if (isHost) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-[100dvh] items-center justify-center bg-[#061a22] text-3xl text-white/50">
            Cargando…
          </div>
        }
      >
        <HostScreen />
      </Suspense>
    );
  }
  return <PlayerScreen />;
}
