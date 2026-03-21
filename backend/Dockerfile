FROM node:20-alpine AS deps
WORKDIR /app
# better-sqlite3 native module deps — must be present during npm install
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .
COPY src/ ./src/
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/flujo.db
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
USER node
CMD ["node","src/server.js"]
