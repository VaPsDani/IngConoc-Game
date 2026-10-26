# DEPLOY.md — poner esto en producción
### A0. Antes de nada: ¿están libres el 80 y el 443?

En esa VM ya corre un servidor de Minecraft. Minecraft usa 25565, así que en
principio no estorba, pero compruébalo en vez de suponerlo:

```bash
sudo ss -tulpn | grep -E ':(80|443)\s'
```

Si no imprime nada, están libres. Si algo los ocupa (otro Caddy, nginx, Apache),
decide: o lo paras, o pones este servicio en otros puertos y usas un proxy que
ya exista. **Caddy no puede emitir certificados sin el 80 y el 443.**

```bash
# Si hubiera un nginx viejo estorbando:
sudo systemctl stop nginx && sudo systemctl disable nginx
```

### A1. Abrir 80/443 en LOS DOS sitios

Este es el paso donde todo el mundo pierde una hora. En OCI hay **dos** capas de
firewall y hay que abrir las dos. Abrir solo una da exactamente el mismo
síntoma: timeout, sin mensaje de error.

**Capa 1 — Security List / NSG de la subred** (consola web de OCI):

> Networking → Virtual Cloud Networks → tu VCN → Subnets → tu subred →
> Security Lists → Default Security List → **Add Ingress Rules**

| Stateless | Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|---|
| No | `0.0.0.0/0` | TCP | `80` |
| No | `0.0.0.0/0` | TCP | `443` |

Si usas Network Security Groups en vez de Security Lists, la regla es la misma
pero en el NSG que tenga adjuntada la VNIC de la instancia.

**Capa 2 — iptables local de la VM.** Las imágenes de Oracle Linux y Ubuntu de
OCI vienen con una cadena INPUT que **rechaza todo menos el 22**. La regla que
bloquea está al final, así que hay que **insertar** antes de ella, no añadir:

```bash
# Mira primero dónde está la regla de REJECT, numerada:
sudo iptables -L INPUT --line-numbers -n
```

Verás algo así, con el REJECT en la línea 6:

```
6    REJECT     all  --  0.0.0.0/0   0.0.0.0/0   reject-with icmp-host-prohibited
```

Inserta las tuyas **en la posición 6**, justo antes:

```bash
sudo iptables -I INPUT 6 -p tcp --dport 80 -m state --state NEW -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -m state --state NEW -j ACCEPT
# HTTP/3 va por UDP. Si no lo quieres, no publiques 443/udp en compose.
sudo iptables -I INPUT 6 -p udp --dport 443 -m state --state NEW -j ACCEPT
```

Compruébalo y **guárdalo**, o se pierde al reiniciar:

```bash
sudo iptables -L INPUT --line-numbers -n | head -12

# Ubuntu / Debian
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save

# Oracle Linux / RHEL, si usa firewalld en vez de iptables directo:
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

> Si el número de línea del REJECT no es 6 en tu VM, usa el que te diga
> `--line-numbers`. Insertar en la posición equivocada (después del REJECT) deja
> la regla inservible y parece que no hiciste nada.

### A2. Docker

```bash
# Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # cierra sesión y vuelve a entrar
```

### A3. Traer el código y configurar

```bash
git clone <tu-repo> ingconoc-game && cd ingconoc-game
git checkout v0.3-deploy      # o el tag que corresponda

cp .env.example .env
```

Edita `.env`:

```bash
# Genera una clave larga de verdad. Sin esto el proceso no arranca.
node -e "console.log(crypto.randomUUID())"
# o, si no tienes node en la VM:
head -c 32 /dev/urandom | base64
```

```ini
HOST_KEY=<lo que salió arriba>
DOMAIN=<ver A4>
```

### A4. TLS sin dominio propio: sslip.io

`sslip.io` resuelve cualquier IP codificada en el nombre. Si tu VM es
`140.238.176.12`, el dominio es:

```
140-238-176-12.sslip.io
```

(guiones en vez de puntos; también funciona `140.238.176.12.sslip.io`).

Compruébalo **antes** de arrancar Caddy, porque si el DNS no resuelve, Let's
Encrypt falla y consume uno de los 5 intentos semanales:

```bash
dig +short 140-238-176-12.sslip.io    # debe devolver 140.238.176.12
```

En `.env`:

```ini
DOMAIN=140-238-176-12.sslip.io
```

El `Caddyfile` del repo ya sirve para este caso sin tocar nada: toma el dominio
de la variable. El bloque relevante es:

```caddy
{$DOMAIN} {
	encode zstd gzip
	reverse_proxy app:3001 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		transport http {
			read_timeout 300s
			write_timeout 300s
		}
	}
}
```

**Con un dominio real** no cambia el `Caddyfile`: solo apunta un registro A a la
IP de la VM y pon `DOMAIN=quiz.midominio.com` en `.env`. Espera a que
`dig +short quiz.midominio.com` devuelva tu IP antes de arrancar.

> **Limitación de sslip.io:** Let's Encrypt tiene un tope de 50 certificados por
> semana y *dominio registrado*, y `sslip.io` lo comparte entre todo el mundo.
> Suele funcionar, pero si un día te rechaza la emisión, ese es el motivo. Para
> algo que va a usarse en una clase con nota, un dominio propio de 2 USD/año es
> la opción tranquila.

### A5. Arrancar

```bash
docker compose up -d --build
```

La primera vez, Caddy tarda 10–30 s en conseguir el certificado. Míralo:

```bash
docker compose logs -f caddy
```

Busca `certificate obtained successfully`. Si ves `could not get certificate`,
casi siempre es el puerto 80 cerrado (vuelve a A1) o el DNS que no resuelve
(A4).

### A6. Comprobación post-deploy

Los cuatro checks. **Hazlos desde fuera de la VM**, desde tu laptop, no por SSH
dentro de la máquina: media de los fallos de firewall solo se ven desde fuera.

```bash
D=140-238-176-12.sslip.io

# 1. Salud de la app a través del proxy.
curl -s https://$D/healthz
# {"ok":true,"uptime":42,"rooms":0,"players":0,...}

# 2. Certificado válido y emitido por Let's Encrypt.
echo | openssl s_client -connect $D:443 -servername $D 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
# issuer= ... Let's Encrypt ...   notAfter=<~90 días>

# 3. La web se sirve de verdad (no solo un 200 vacío).
curl -s https://$D/ | grep -o '<title>.*</title>'
# <title>Salto del sapo</title>

# 4. Fallback SPA: /host debe devolver el index, no un 404.
curl -s -o /dev/null -w '%{http_code}\n' https://$D/host
# 200
```

**El check que de verdad importa: un handshake WSS real.** Un `curl` al HTML no
prueba nada sobre WebSockets, y los WebSockets son el 100 % del juego. Un proxy
mal configurado sirve la web perfectamente y rompe el socket.

```bash
# Desde tu laptop, con node instalado:
npx -y socket.io-client@4 --version >/dev/null 2>&1  # solo para cachearlo
node -e '
const { io } = require("socket.io-client");
const url = "https://140-238-176-12.sslip.io";
const s = io(url, { transports: ["websocket"], reconnection: false, timeout: 10000 });
const t0 = Date.now();
s.on("connect", () => {
  console.log("WSS conectado en", Date.now() - t0, "ms, transporte:", s.io.engine.transport.name);
  s.emit("player:ping", { t0: Date.now() });
});
s.on("player:pong", (p) => {
  console.log("pong OK, reloj del servidor:", new Date(p.tServer).toISOString());
  process.exit(0);
});
s.on("connect_error", (e) => { console.error("FALLÓ:", e.message); process.exit(1); });
setTimeout(() => { console.error("FALLÓ: sin respuesta"); process.exit(1); }, 15000);
'
```

Tiene que imprimir `transporte: websocket`. Si dice `polling`, el proxy no está
pasando el upgrade y el juego irá a tirones toda la clase.

Y la prueba de carga real, contra producción:

```bash
node scripts/loadtest.ts --url https://140-238-176-12.sslip.io --players 40
```

> El loadtest crea una sala, así que necesita `HOST_KEY`. Pásala por entorno:
> `HOST_KEY=... node scripts/loadtest.ts --url https://...`

### A7. Operación

```bash
# Logs en vivo (la app loguea cada transición de fase y cada rechazo)
docker compose logs -f app

# Solo lo interesante
docker compose logs -f app | grep -E "room:|phase|ratelimit|host:key-rechazada"

# Estado
docker compose ps
curl -s https://$D/healthz

# Resultados exportados (viven en el volumen, no en el contenedor)
docker compose exec app ls -la /data/results
docker compose cp app:/data/results ./resultados-clase

# Actualizar a una versión nueva
git fetch --tags && git checkout v0.4-loquesea
docker compose up -d --build

# Rollback al tag anterior
git checkout v0.3-deploy
docker compose up -d --build
```

**Sobre el rollback y los datos:** el volumen `game-data` no se toca al
reconstruir, así que los snapshots y resultados sobreviven. Si una versión nueva
cambia el formato del snapshot, `SNAPSHOT_VERSION` no coincidirá y las salas
viejas se descartan con un log — no revientan el arranque.

**Reinicio en caliente durante la clase:** `docker compose restart app` tarda
unos 10 s y las salas vuelven del snapshot. Los celulares reconectan solos. No
es gratis, pero no pierdes la partida.