FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates python3 make g++
WORKDIR /app
COPY . .
RUN npm install
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server
RUN cp -r apps/server/src/generated apps/server/dist/generated

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates g++ python3 make default-jdk golang
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 7860
ENV PORT=7860
# migrate deploy applies the committed migrations and nothing else. The previous
# `db push --accept-data-loss` reshaped the live database on every boot and was
# permitted to drop data to do it.
CMD npm run db:deploy --workspace=apps/server && node apps/server/dist/index.js
