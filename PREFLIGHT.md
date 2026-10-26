# PREFLIGHT.md — lo que hay que probar a mano antes de la clase

Nada de esto lo cubren los 138 tests automáticos. Son cosas que solo se rompen
en un teléfono de verdad, sobre una red de verdad.

**Hazlo con 2–3 días de margen**, no la noche antes: si algo falla aquí, el
arreglo puede tardar.

Marca con `[x]` lo que vayas pasando. Si algo falla, anota **qué** falló, no
solo que falló.

---

## Antes de salir de casa

- [ ] `pnpm test` — 138 en verde (27 shared + 89 api + 22 física).
- [ ] `docker compose up -d --build` local, y `curl -k https://localhost/healthz`
      responde.
- [ ] Los checks post-deploy de `DEPLOY.md` A6, incluido el **handshake WSS**.
      Un `curl` al HTML no prueba nada del juego.
- [ ] `HOST_KEY` anotada en un sitio que no sea solo el `.env` de la VM.
- [ ] Batería del laptop del proyector, o cargador.
- [ ] Plan B leído (`DEPLOY.md`, Modo B) **antes** de necesitarlo.

---

## 1. Los dos navegadores que importan

No basta con probar en tu teléfono. Safari de iOS y Chrome de Android fallan en
cosas distintas: Safari con la barra de direcciones y el `100dvh`, Chrome con
los Pointer Events y el zoom.

### iPhone — Safari

- [ ] Carga `https://<dominio>` sin avisos de certificado.
- [ ] Entrar con código y apodo.
- [ ] **Jugar y aterrizar en un nenúfar.** Que responda no basta: tiene que
      aterrizar.
- [ ] Al mantener pulsado **no** aparece el menú de copiar/compartir.
- [ ] Al arrastrar por el canvas **no** hace scroll ni rebote la página.
- [ ] Doble toque **no** hace zoom.
- [ ] El canvas se ve nítido, no borroso (comprobación de `devicePixelRatio`).
- [ ] Al aparecer y desaparecer la barra de direcciones, el juego no salta ni
      cambia de dificultad.

### Android — Chrome

- [ ] Todo lo anterior.
- [ ] El teclado al escribir el apodo no rompe el layout.
- [ ] Al volver de segundo plano el juego sigue, no se queda congelado.

> **Si el sapo no aterriza para nadie**, no toques `PHYSICS` todavía: primero
> comprueba que el problema no es que la pantalla es más pequeña de lo previsto
> y el letterboxing deja el canvas diminuto.

---

## 2. Red hostil (lo que va a pasar de verdad)

Estas son las pruebas que de verdad separan "funciona" de "funciona en clase".

- [ ] **Bloquear la pantalla a mitad de pregunta** y desbloquear a los ~10 s.
      → Reconecta solo, conserva el puntaje, y si ya había respondido ve la
      pantalla de espera y **no** puede volver a jugar esa pregunta.

- [ ] **Modo avión 5 s** durante una pregunta, y quitarlo.
      → Aparece el aviso "Sin conexión — reconectando…", y se va solo al volver.
      El puntaje sigue ahí.

- [ ] **Modo avión 60 s** (más que el `connectionStateRecovery`).
      → Reconecta igual, por `player:resume`. Este es el camino que de verdad
      importa; el de 5 s lo resuelve Socket.IO solo.

- [ ] **Recargar la página** (tirar hacia abajo) a mitad de partida.
      → Vuelve a su estado exacto: misma fase, mismo puntaje, mismo puesto.

- [ ] **Cerrar la pestaña y volver a abrir la URL** a mitad de partida.
      → Igual que lo anterior (las credenciales están en `localStorage`).

- [ ] **Poner el teléfono en 4G en vez del WiFi** a mitad de partida.
      → Reconecta. Cambia la IP, y eso no debe romper nada.

---

## 3. El anfitrión

- [ ] Abrir `/host`, meter la `HOST_KEY`, ver el código y el QR.
- [ ] **Anotar la clave de recuperación** que sale en letra pequeña abajo.
      Que salga en letra pequeña es a propósito: la pantalla está proyectada.
- [ ] **Reclamar la sala desde un segundo dispositivo**: en el celular, ir a
      `/host/recover`, meter código + clave.
      → Toma el control. El primer dispositivo deja de mandar.
      → Los jugadores **no** pierden puntaje ni ven un error.
- [ ] Con el host caído (cierra la pestaña), los jugadores ven
      **"Esperando al anfitrión…"**, no un error.
- [ ] Expulsar a alguien desde el roster. → Su celular dice que lo sacaron.
- [ ] Botón "Cerrar ahora" corta la pregunta antes de tiempo.
- [ ] En la pantalla final, **descargar el CSV y el JSON**. Ábrelos: el CSV debe
      abrirse en Excel con los acentos bien.

---

## 4. El salón físico

Esto no se puede probar desde el escritorio.

- [ ] **Escanear el QR desde la última fila.** Si no se escanea, no sirve de
      nada que funcione.
- [ ] **Leer el código de sala desde la última fila.** Por eso el alfabeto no
      tiene O/0/I/1/L, pero compruébalo con tus ojos y ese proyector.
- [ ] Dictar el código en voz alta y que alguien lo escriba bien a la primera.
- [ ] Ver el enunciado y las 4 opciones desde el fondo. Si no se leen, baja el
      número de palabras de las preguntas, no el tamaño de letra.
- [ ] Comprobar que el proyector no recorta los bordes (los botones del host
      están abajo del todo).

---

## 5. Playtest humano — el que decide si hay que calibrar

**Con 5–8 personas reales**, no contigo solo. Tú ya sabes jugar; ellos no.

Para cada persona, en su primera pregunta, anota:

| Persona | Intentos hasta aterrizar | Tiempo hasta aterrizar (s) | ¿Entendió sin explicación? |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |

El dato exacto sale del CSV exportado: columnas `attempts` y `elapsedMs`. No lo
estimes a ojo, descárgalo.

```bash
# p95 de tiempo hasta aterrizar, desde el CSV
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("<code>.json","utf8"));
const t=j.rows.filter(r=>r.elapsedMs!=="").map(r=>r.elapsedMs).sort((a,b)=>a-b);
const a=j.rows.filter(r=>r.attempts!=="").map(r=>r.attempts).sort((a,b)=>a-b);
const p=(arr,q)=>arr[Math.min(arr.length-1,Math.ceil(q*arr.length)-1)];
console.log("tiempo  p50", p(t,.5), "ms   p95", p(t,.95), "ms");
console.log("intentos p50", p(a,.5), "     p95", p(a,.95), "   max", a[a.length-1]);
'
```

### Criterio de calibración — y solo este

**No se toca la física salvo que se cumpla uno de estos dos:**

- alguien necesitó **más de 5 intentos** para aterrizar, **o**
- el **p95 de tiempo hasta aterrizar supera 6 s**.

Si se cumple, el **único** cambio permitido es ensanchar la ventana subiendo
`BRANCH_DY` en `apps/web/src/game/physics.ts`:

| `BRANCH_DY` | Ventana de `power` |
|---|---|
| 470 (actual) | 25.64 % |
| 500 | 27.2 % |
| 530 | 33.4 % |

Sube **un escalón cada vez** y vuelve a medir. Después:

- [ ] `pnpm test` — los 22 tests de física siguen pasando.
- [ ] El test de equidad sigue dando **spread = 0.0000 pp** en las 4 columnas.
      Si no, algo más se rompió; revierte.
- [ ] Actualiza los tres números de la ventana en el README y en el propio test.

**Ninguna otra constante se toca.** `GRAVITY`, `V_MIN`, `V_MAX`,
`PLATFORM_TOP_DY`, `CHARGE_PERIOD_MS` y `STUN_MS` se quedan como están. Y los
límites de tiempo por pregunta ya están en 25–30 s, que es lo que absorbe los
reintentos sin tocar nada del juego.

---

## 6. Ensayo general

- [ ] Partida completa de 5 preguntas con 3+ personas reales, de principio a
      podio, sin intervenir.
- [ ] Reiniciar el contenedor **a mitad de partida** (`docker compose restart
      app`) y comprobar que la sala vuelve y nadie pierde puntos. Tarda ~10 s.
- [ ] Descargar el CSV al final y abrirlo.
- [ ] Cronometrar cuánto tarda la clase entera en entrar. Si pasa de 3 minutos,
      el cuello es el QR o el dictado del código, no el servidor.

---

## Si algo se rompe en clase

1. **Un celular no entra** → que use el QR en vez de teclear. Si sigue,
   que recargue; casi siempre es la URL mal escrita.
2. **Varios se desconectan a la vez** → es la red. Sigue: reconectan solos y no
   pierden puntaje. No reinicies nada.
3. **Se muere el proyector** → `/host/recover` desde tu celular con el código y
   la clave de recuperación.
4. **Se muere el servidor** → `docker compose restart app`. Vuelve en ~10 s con
   las salas del snapshot.
5. **Nada de lo anterior funciona** → Modo B de `DEPLOY.md`, o haz la pregunta a
   mano a mano alzada. No pierdas la clase peleando con la red.
