# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# Option pour installer la lib Pronote depuis npm ou git (ex: github:user/repo#tag)
ARG PAWNOTE_PKG=

# Dépendances
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && if [ -n "$PAWNOTE_PKG" ]; then npm install --omit=dev "$PAWNOTE_PKG"; fi

# Code
COPY index.js ./

# Dossier de données (état des événements)
RUN mkdir -p /data && chown -R node:node /data /app
ENV STATE_PATH=/data/event-state.json
ENV REFRESH_MINUTES=15

USER node
EXPOSE 3000
CMD ["node", "index.js"]
