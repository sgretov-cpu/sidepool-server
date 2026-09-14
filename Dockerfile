FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# Persisted virtual-wallet data lives here. On most free hosting tiers this
# disk is ephemeral (wiped on redeploy/restart) — see README for notes on
# attaching a persistent volume or swapping in a real database.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
