FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json ./apps/server/
RUN npm install
COPY . .
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json ./apps/server/
RUN npm install --only=production
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/prisma ./apps/server/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 7860
ENV PORT=7860
CMD ["node", "apps/server/dist/index.js"]
