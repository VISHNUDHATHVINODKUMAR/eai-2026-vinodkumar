FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY intake/src ./intake/src

CMD ["node", "--import", "tsx", "intake/src/server.js"]
