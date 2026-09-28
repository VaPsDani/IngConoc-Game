# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Etapa 1: build. Instala TODO el workspace y compila la web.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Corepack trae pnpm sin instalarlo a mano.
RUN corepack enable

# Primero solo los manifiestos: si no cambian, Docker reutiliza la capa de
# dependencias aunque cambie todo el codigo.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json      apps/api/package.json
COPY apps/web/package.json      apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# La web se compila a estatico; el API se ejecuta como TypeScript directamente
# (Node 24 le quita los tipos), asi que no necesita build.
RUN pnpm --filter @ingconoc/web build

# Dependencias de PRODUCCION del API, desplegadas sin symlinks para poder
# copiarlas tal cual a la imagen final.
RUN pnpm --filter @ingconoc/api deploy --prod --legacy /deploy-api

# ---------------------------------------------------------------------------
# Etapa 2: runtime. Solo lo que hace falta para correr.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `node` ya existe en la imagen oficial (uid 1000). Usuario NO root.
COPY --from=build --chown=node:node /deploy-api/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/src        ./apps/api/src
COPY --from=build --chown=node:node /app/apps/api/data       ./apps/api/data
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/packages/shared     ./packages/shared
COPY --from=build --chown=node:node /app/apps/web/dist       ./apps/web/dist

# Node no quita tipos de .ts bajo node_modules, y `pnpm deploy` copia ahi
# @ingconoc/shared. Se reapunta el symlink al fuente fuera de node_modules.
RUN ln -sfn /app/packages/shared node_modules/@ingconoc/shared

# Volumen de datos: snapshots y resultados exportados.
RUN mkdir -p /data && chown -R node:node /data

USER node

ENV PORT=3001 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist \
    TRUST_PROXY=1

EXPOSE 3001

# Healthcheck: si /healthz deja de responder, compose reinicia el contenedor.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/main.ts"]
