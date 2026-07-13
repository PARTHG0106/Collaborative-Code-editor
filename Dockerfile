FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY . .
RUN npm install
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server
RUN cp -r apps/server/src/generated apps/server/dist/generated

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates g++ python3 default-jdk golang
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 7860
ENV PORT=7860
CMD npx prisma db push --schema=apps/server/prisma/schema.prisma --accept-data-loss && node apps/server/dist/index.js
