FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY . .
RUN npm install
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 7860
ENV PORT=7860
CMD ["node", "apps/server/dist/index.js"]
