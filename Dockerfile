# ─── Build stage ───
FROM node:20-alpine AS build
WORKDIR /app

# Prisma needs OpenSSL present to detect the engine; node:20-alpine ships none.
# libc6-compat is recommended for the linux-musl query engine.
RUN apk add --no-cache openssl libc6-compat

# Install deps (including dev) for build
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Generate Prisma client + compile TS
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ─── Runtime stage ───
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same OpenSSL runtime dependency as the build stage — the query engine is
# loaded here, so it must be present in the final image too.
RUN apk add --no-cache openssl libc6-compat

# Only production deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# Copy compiled output
COPY --from=build /app/dist ./dist

EXPOSE 4000
# Run migrations then start the API. Override command for the worker.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
