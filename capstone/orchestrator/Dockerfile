FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY orchestrator/src ./orchestrator/src

CMD ["node", "--import", "tsx", "orchestrator/src/server.js"]

