# syntax=docker/dockerfile:1
# Contexto de construcción: raíz del repositorio (ver infra/compose.yaml)

# 1) Panel administrativo (React + Vite) → archivos estáticos
FROM node:24.22.1-alpine3.24 AS panel
WORKDIR /app/apps/admin-panel
COPY apps/admin-panel/package.json apps/admin-panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/admin-panel/ ./
RUN npm run build

# 2) API
FROM node:24.22.1-alpine3.24 AS build
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-alpine3.24
ENV NODE_ENV=production PANEL_DIR=/app/apps/admin-panel/dist
WORKDIR /app/apps/api
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY apps/api/package.json ./
COPY database /app/database
COPY --from=panel /app/apps/admin-panel/dist /app/apps/admin-panel/dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
