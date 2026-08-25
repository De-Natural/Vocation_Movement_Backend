# ─── Build stage ───
FROM node:20-alpine AS build
WORKDIR /app

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

# Only production deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# Copy compiled output
COPY --from=build /app/dist ./dist

EXPOSE 4000
# Run migrations then start the API. Override command for the worker.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
