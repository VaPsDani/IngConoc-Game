# Salto del sapo — quiz tipo Kahoot con mini-juego de habilidad

El enunciado va en el proyector; cada alumno responde desde su celular saltando
con un sapo a uno de 4 nenúfares. El conocimiento decide **a dónde** saltas, la
habilidad decide **qué tan rápido** llegas.

Sin base de datos. Salas en memoria, respaldadas en disco para sobrevivir a un
reinicio. Docker + Caddy con TLS automático para el despliegue.

## Correr

**En producción** — un solo origen, HTTPS automático con Caddy:

```bash
cp .env.example .env    # rellena HOST_KEY y DOMAIN
docker compose up -d --build
```

Los pasos reales para la VM de OCI (firewall de dos capas, sslip.io, rollback) y
el modo contingencia con hotspot están en **[DEPLOY.md](DEPLOY.md)**. Lo que hay
que probar a mano en teléfonos de verdad antes de la clase, en
**[PREFLIGHT.md](PREFLIGHT.md)**.

**En desarrollo** — Vite en `:5173`, API en `:3001`:

```bash
pnpm install
HOST_KEY=una-clave-de-al-menos-8 pnpm dev
```

- **Proyector:** `http://<tu-ip>:5173/host`
- **Celulares:** `http://<tu-ip>:5173` (o el QR del lobby)

```bash
pnpm test        # 138 tests
pnpm typecheck   # los 3 paquetes
pnpm build
HOST_KEY=... pnpm loadtest   # 40 clientes simulados (necesita el API arriba)
```

Requiere **Node ≥ 22.18**: el API se ejecuta con `node src/main.ts`, sin bundler
ni `tsx`, aprovechando que Node ya quita los tipos de TypeScript.

## Estructura

```
apps/api          Express + Socket.IO. Salas en memoria.
  src/room.ts       Máquina de estados PURA. Sin sockets, sin timers, sin IO.
  src/gateway.ts    Traduce eventos <-> room. Timers y difusión.
  src/scoring.ts    Fórmula de puntaje. Solo servidor.
  src/quizzes.ts    Carga y valida los JSON al arrancar.
  data/*.json       Cuestionarios.
apps/web          Vite + React 19 + Tailwind 4.
  src/game/         El mini-juego del sapo (Paso 1). Canvas 2D puro.
  src/host/         Pantalla del proyector.
  src/player/       Pantalla del celular.
  src/net/socket.ts Conexión y reloj sincronizado.
packages/shared   Contratos de eventos, modelo del quiz, código de sala, reloj.
scripts/loadtest.ts
```

---

# Parte 1 — El mini-juego

## El invariante

> La dificultad de alcanzar una plataforma es idéntica para las 4 opciones, para
> todas las preguntas y para todos los cuestionarios.

La habilidad nunca decide **si** llegas. Cómo está garantizado:

- Las 4 plataformas comparten ancho, altura y separación. Equiespaciadas.
- Posicionarse en el riel es **gratis**: instantáneo, ilimitado.
- El salto es puramente vertical: no existe una variable `vx` en todo el módulo.
- Toda constante de dificultad vive en un único `PHYSICS` congelado.
- Cero `Math.random()` en la simulación (ni en los tests: PRNG con semilla).
- Fallar cuesta 800 ms y nada más. El tiempo es la única moneda.

## Constantes

Todas en [`apps/web/src/game/physics.ts`](apps/web/src/game/physics.ts).

| Constante | Valor | Qué significa |
|---|---|---|
| `LOGICAL_W` / `LOGICAL_H` | 400 × 700 | Mundo lógico fijo. Todo se escala con letterboxing; la barra de Safari no altera nada. |
| `GRAVITY` | 2200 px/s² | Sube ⇒ todos los saltos son más bajos. |
| `V_MIN` | 900 px/s | Con `power = 0`. Deliberadamente **insuficiente** (ápice 184 < 360). |
| `V_MAX` | 1600 px/s | Con `power = 1`. Deliberadamente **excesiva** (ápice 582 > 470): choca. |
| `CHARGE_PERIOD_MS` | 900 ms | El medidor va 0→1 y rebota. Sube ⇒ más fácil clavar el punto. |
| `PLATFORM_TOP_DY` | 360 px | Superficie del nenúfar sobre los pies del sapo. Piso de la ventana. |
| `BRANCH_DY` | 470 px | Rama espinosa. Techo de la ventana. |
| `PLATFORM_W` | 78 px | Cosmético: el salto es vertical, no se puede fallar de lado. |
| `RAIL_SLIDE_MS` | 300 ms | Animación del deslizamiento. Puramente visual. |
| `STUN_MS` | 800 ms | Costo de un fallo. La única penalización. |
| `COLUMNS` | 4 | Una por opción. |

Fuera de `PHYSICS` porque no son física: `FIXED_DT = 1/120 s`.

## La ventana de `power`

```
ápice(power) = lerp(V_MIN, V_MAX, power)² / (2 · GRAVITY)

power_min = (√(2·2200·360) − 900) / 700 = 0.512244
power_max = (√(2·2200·470) − 900) / 700 = 0.768649
```

| | valor |
|---|---|
| ventana | `[0.512244, 0.768649]` |
| ancho | **25.64 % del medidor** |
| centro | `0.640446` |
| en tiempo de hold | 461 ms → 692 ms, **231 ms de margen** |

`precision = 1 − |power − 0.640446| / 0.128203`, clamp 0..1.

**El medidor no dibuja la ventana.** A propósito: la referencia visual son el
nenúfar y las espinas, dibujados exactamente donde la física los evalúa.

## Tocar la dificultad global

Un solo lugar: el objeto `PHYSICS`. Para hacerlo **más fácil**:

1. **Ensanchar la ventana:** subir `BRANCH_DY` (470 → 500 da 27.2 %).
2. **Ralentizar el medidor:** subir `CHARGE_PERIOD_MS` (900 → 1200).
3. **Abaratar el fallo:** bajar `STUN_MS`.

Reglas al tocarlo:

- Mantén `apex(0) < PLATFORM_TOP_DY < BRANCH_DY < apex(1)`.
- Corre `pnpm test` después. Si cambias la ventana a propósito, actualiza esos
  tres números y **no** toques los asserts de equidad.
- Nunca hagas que `platformTopFor()` o `branchFor()` dependan de su argumento.
  Ese argumento existe solo para que el test demuestre que no lo usan.

---

# Parte 2 — La sala multijugador

## Máquina de estados

```
LOBBY → QUESTION_ACTIVE → REVEAL → DISCUSSION → (QUESTION_ACTIVE | FINAL)
```

El contrato listaba 5 eventos de host para 4 aristas, así que hubo que decidir.
El mapeo implementado ([`room.ts`](apps/api/src/room.ts)):

| evento | desde | hacia |
|---|---|---|
| `host:startGame` | LOBBY | QUESTION_ACTIVE(0) |
| `host:closeQuestion` | QUESTION_ACTIVE | REVEAL |
| *(deadline + gracia)* | QUESTION_ACTIVE | REVEAL |
| *(respondieron todos)* | QUESTION_ACTIVE | REVEAL |
| `host:reveal` | QUESTION_ACTIVE | REVEAL (atajo) |
| | REVEAL | REVEAL (idempotente) |
| `host:nextQuestion` | REVEAL | DISCUSSION |
| | DISCUSSION | QUESTION_ACTIVE(n+1) \| FINAL |
| `host:endGame` | cualquiera | FINAL |

En la práctica el host tiene un solo botón que avanza: **Discutir** →
**Siguiente**. `DISCUSSION` no tiene timeout: dura hasta que se pulse siguiente.

Las transiciones inválidas se **ignoran y se loguean**. Un doble clic del host o
un evento que llega tarde no puede tumbar una sala con 40 personas dentro.

## Código de sala

6 caracteres de un alfabeto de 31 símbolos que **excluye O, 0, I, 1 y L**: se
dictan en voz alta y se leen desde el fondo del salón. Colisión → regenerar.

## Reloj y deadlines

- Al entrar, el cliente hace **3 rondas de ping** y se queda con la **mediana**
  del offset. La mediana, no el promedio: en un WiFi cargado basta un paquete
  retrasado para arruinar una media.
- Todos los deadlines viajan como **timestamp absoluto del servidor**. El
  cliente los traduce con su offset. Nunca se mandan duraciones relativas.
- El `elapsedMs` lo mide el **servidor** al recibir `player:answer`. El cliente
  ni siquiera puede reportarlo: no está en el contrato.
- **Gracia de 1500 ms** después del deadline: se aceptan, pero con `elapsedMs`
  clampeado al límite, así que la latencia no regala ni quita puntos. Más tarde
  que eso, `ANSWER_TOO_LATE`.
- El cierre automático dispara en `deadline + gracia`, para que las respuestas
  que salieron a tiempo alcancen a entrar en la distribución que ve el host.

## Puntaje

Solo en el servidor ([`scoring.ts`](apps/api/src/scoring.ts)):

```ts
speed  = clamp(1 - elapsedMs / timeLimitMs, 0, 1)
mult   = min(1 + 0.1 * (streak - 1), 1.5)
points = round((700 + 300 * speed + 100 * clamp(precision, 0, 1)) * mult)
```

Techo por pregunta: **1650**. Incorrecta o sin responder: 0 y racha a 0.

- **`attempts` NO resta.** Cada intento fallido ya se pagó con 800 ms de stun, y
  el tiempo ya entra por `speed`. Restarlo otra vez sería cobrar dos veces lo
  mismo y convertiría la habilidad en algo que decide **si** puntúas, rompiendo
  el invariante del Paso 1. Se guarda solo como telemetría.
- **`precision` es falsificable**, la reporta el cliente. Por eso vale como
  máximo 100 de ~1200 puntos (8 %) y va clampeada a `[0,1]`. Mentir da menos
  ventaja que responder medio segundo antes.

## Reconexión

El jugador guarda `{sessionId, playerId, token}` en `localStorage`. Al
reconectar manda `player:resume` y el servidor devuelve el estado completo:
fase, pregunta, deadline, puntaje, puesto y **si ya respondió** — con eso el
celular pinta la pantalla de espera y no le deja jugar de nuevo.

El host también reconecta con su propio token: si se cae el navegador del
proyector, la sala sigue viva con todos los puntajes.

Una respuesta por pregunta. `onAnswer` es terminal.

## La frontera pública/privada

Lo que viaja al celular **nunca** lleva `isCorrect`. Garantizado por dos vías:

1. **Runtime:** `toPublic()` construye el objeto campo por campo. No copia, no
   hace spread, no borra. Un campo nuevo en `QuizOption` no se filtra solo.
2. **Compilación:** `PublicQuestion` lleva una marca con un `unique symbol` que
   solo `toPublic()` puede poner. Sin ella, TypeScript no deja pasar un
   `Question` donde se espera un `PublicQuestion` — que es exactamente el
   accidente que el chequeo de propiedades sobrantes **no** detecta.

Además, `player:result` (que sí dice si acertaste) se emite **solo en REVEAL**,
para toda la clase a la vez. Al responder solo llega `player:answerAccepted`,
con el tiempo del servidor y nada más.

## Cuestionario

`apps/api/data/*.json`. El validador corre **al arrancar** y el proceso no
levanta si algo está mal: exactamente 4 opciones, labels A-D por posición,
exactamente 1 correcta, colores hex, ids únicos, `timeLimitSec` en [5, 180].
Mejor no arrancar que revelar la respuesta equivocada delante de la clase.

---

# Parte 3 — Producción

## Un solo origen

Express sirve el build de `apps/web` **y** Socket.IO en el mismo puerto. Eso
elimina CORS por completo, hace que WSS herede el TLS de Caddy, y deja una sola
URL para el QR. Fallback SPA: `/host` y `/host/recover` devuelven `index.html`,
así que recargar en cualquier ruta funciona.

En dev sigue habiendo dos orígenes (Vite en `:5173`), y ahí sí se permite CORS.
El cliente decide con `import.meta.env.DEV`.

## Endurecimiento

Los tres vectores que quedaron abiertos en el Paso 2, cerrados y con test:

| Vector | Defensa | Test |
|---|---|---|
| Bucle de `host:createSession` hasta llenar la memoria | `HOST_KEY` obligatoria por entorno + cap de 3 salas por proceso | `hardening.test.ts` |
| Rate limit evadible abriendo más sockets | Token bucket **por IP** y por acción | `hardening.test.ts` |
| Payloads sin acotar | `maxHttpBufferSize: 8192` + validación de longitud y forma de cada campo | `hardening.test.ts` |

Los cubos por IP están calibrados para que **40 alumnos detrás del mismo NAT**
de la universidad quepan sin rozar el límite (`join` 120 de ráfaga, `answer` 120)
mientras `create` y `recover` quedan en 5 — esos son de una sola persona.

`X-Forwarded-For` solo se cree si `TRUST_PROXY=1`. Sin proxy de confianza la
cabecera la escribe el atacante, y creerla sería regalar la evasión.

Cabeceras de seguridad a mano (sin `helmet`): `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` y una CSP que cierra
`script-src` a `'self'`, que es por donde entraría un XSS.

## Recuperación del host

La clave de recuperación son 6 caracteres del mismo alfabeto sin ambigüedades.
Se muestra **una sola vez en el lobby, en letra pequeña y tras un clic**: esa
pantalla está proyectada delante de 40 personas.

Con código + clave, `/host/recover` devuelve el control desde cualquier
dispositivo. **La clave nunca va en la URL**: viaja en el cuerpo del evento, y
la descarga de resultados usa POST por lo mismo — una URL con el token acabaría
en el historial, en los logs de Caddy y en el `Referer`.

Si el host se cae, la sala **sigue viva**: los jugadores ven "Esperando al
anfitrión…", no un error, y nadie pierde puntaje.

## Snapshots

El estado de cada sala se escribe a `/data/sessions/<code>.json` en cada
transición de la máquina de estados, de forma atómica (fichero temporal +
rename). Al arrancar se recargan; los caducados, corruptos o de otra versión se
descartan con su motivo en el log, sin impedir el arranque.

Verificado en vivo: matando el proceso en seco a mitad de partida y
rearrancándolo, la sala vuelve con sus 40 jugadores, puntajes y rachas.

Una pregunta cuyo deadline venció durante la caída se reabre en `REVEAL`, no
activa: devolverla con 0 s sería una pregunta imposible.

## Exportación de resultados

Al cerrar cada REVEAL se reescriben `/data/results/<code>.json` y `.csv`. Si la
clase se corta en la pregunta 3, queda el material de las 3 primeras.

El CSV lleva una fila por jugador y pregunta, **incluidas las no respondidas**
(si solo salieran las respondidas, no se podría distinguir "falló" de "no
llegó"). Lleva BOM para que Excel no destroce los acentos.

El JSON añade el agregado por pregunta —distribución, porcentaje de acierto,
mediana de tiempo y de intentos—, que es el material didáctico: dice qué tema
falló la clase. Hay un ejemplo real de una partida de 40 en
[`examples/`](examples/).

Botones de descarga en la pantalla final del host.

---

## Tests — 138

```
packages/shared   27   frontera pública/privada, validador, código, apodos, reloj
apps/api          89   máquina de estados (39), integración por socket real (10),
                       endurecimiento (24) y persistencia (16)
apps/web          22   física del sapo (intactos desde el Paso 1)
```

El test de equidad del Paso 1 sigue pasando sin tocarse:

```
[equidad] experto  (target=centro, sigma=0.06)  n=2000  A=91.85% B=91.85% C=91.85% D=91.85%  spread=0.0000 pp
[equidad] promedio (target=centro, sigma=0.12)  n=2000  A=60.60% B=60.60% C=60.60% D=60.60%  spread=0.0000 pp
[equidad] novato   (target=0.50,   sigma=0.25)  n=2000  A=27.00% B=27.00% C=27.00% D=27.00%  spread=0.0000 pp
[ventana] power valido = [0.512244, 0.768649]  ancho=25.64%  centro=0.640446
```

## Prueba de carga

`pnpm loadtest` abre 40 clientes reales de `socket.io-client` contra una sala,
juega el cuestionario completo y responde en momentos aleatorios (PRNG con
semilla). 10 % nunca responde, 10 % responde pasada la gracia.

```
conexiones exitosas       40/40
entraron a la sala        40 (fallos: 0)
respuestas enviadas       168
respuestas aceptadas      160
respuestas rechazadas     8   (ANSWER_TOO_LATE, los tardíos a propósito)
latencia answer->ack      p50 1 ms · p95 3 ms · max 9 ms · n=160
ping RTT                  p50 3 ms · p95 32 ms
memoria servidor          rss 76.2 -> 86.4 MB · heap 15.9 -> 22.2 MB
jugadores en la tabla     40
```

**Estos números son de localhost.** No dicen nada del WiFi de la universidad;
solo dicen que el servidor no es el cuello de botella. La red sí lo será.

## Bundle

```
index.js        258.50 kB │ gzip 82.36 kB   <- lo que baja el celular
index.css        20.18 kB │ gzip  4.57 kB
HostScreen.js    11.16 kB │ gzip  3.46 kB   <- solo el proyector
qrcode.js        25.84 kB │ gzip 10.14 kB   <- solo el proyector
```

La pantalla del host y `qrcode` se cargan con `import()` dinámico, así que los
40 celulares no los descargan.
