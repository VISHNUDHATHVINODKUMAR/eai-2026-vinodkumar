FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY notifier/src ./notifier/src

CMD ["node", "notifier/src/server.js"]
