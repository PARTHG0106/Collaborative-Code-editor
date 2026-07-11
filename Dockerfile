FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/typescript-config/package.json ./packages/typescript-config/
RUN npm install
COPY . .
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 7860
ENV PORT=7860
CMD ["node", "apps/server/dist/index.js"]
