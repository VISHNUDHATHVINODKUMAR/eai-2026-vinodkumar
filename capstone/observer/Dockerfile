FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY observer/src ./observer/src

CMD ["node", "observer/src/server.js"]
