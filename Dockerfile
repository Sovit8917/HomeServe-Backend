# ─── Stage 1: Builder ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# prisma.config.ts requires DATABASE_URL to be resolvable even for `generate`,
# which never actually connects to a database. A dummy value is fine here.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/db?schema=public"

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

EXPOSE 3000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]