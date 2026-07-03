# ─── Stage 1: Builder ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# prisma.config.ts requires DATABASE_URL to be resolvable even for `generate`,
# which never actually connects to a database. A dummy value is fine here.
ENV DATABASE_URL="postgresql://postgres:Sovit%408917@localhost:5432/home_service_db"

RUN npx prisma generate
RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]