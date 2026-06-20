---
title: syncscript-api
emoji: 🚀
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# SyncScript - Collaborative Real-Time Code Editor

SyncScript is a high-performance, production-grade collaborative real-time code editor built on a modern TypeScript monorepo using React, Express, PostgreSQL, Prisma, and Turborepo. It features a stunning glassmorphic interface, state-of-the-art secure token rotation, and modular components.

## 🚀 Features & Milestones

### Phase 1: Foundational Monorepo Setup
- **Monorepo Structure**: Orchestrated with Turborepo and npm workspaces for fast parallel building and caching.
- **Backend Service**: Express API server in TypeScript featuring modular routing, operational errors, and global exception handlers.
- **Frontend Client**: React + Vite + TypeScript single-page application styled with premium dark-mode glassmorphic components.
- **Prisma Integration**: PostgreSQL database integration via Prisma ORM including schema model, health check routines, and automatic seeding.
- **Containerization**: Out-of-the-box local developer service configurations using Docker Compose.
- **Testing Suite**: In-memory unit and integration tests configured with Vitest, React Testing Library, and Supertest.

### Phase 2: Secure JWT Authentication (Current)
- **Token Rotation Engine**: Implements short-lived Access Tokens (JWT) and long-lived Refresh Tokens (stored in secure HTTP-Only, SameSite cookies).
- **Replay Attack Mitigation**: Stores and verifies refresh tokens in the database, matching them on reuse, and rotating them during transparent token renewals.
- **Silent Refresh Interceptor**: Standardizes API calls via a dedicated Axios client that hooks into `401 Unauthorized` errors and fetches a new session automatically without disrupting the client state.
- **Secure Route Guards**: Redirects unauthenticated traffic away from private views like `/dashboard` back to `/login` using React Router.
- **Responsive Auth Views**: Beautiful, interactive login and registration forms featuring responsive input layouts, status spinners, and error banners.

---

## 📁 Project Architecture

```text
Collaborative-Code-editor/
├── apps/
│   ├── server/           # Express API Server (Node.js, TypeScript, Prisma)
│   └── web/              # React Frontend client (Vite, TypeScript, React Router)
├── packages/
│   ├── eslint-config/    # Shared linting configs
│   └── typescript-config/# Shared TS compilations configurations
├── docker-compose.yml    # Database containers
├── package.json          # Workspace package settings
├── turbo.json            # Turborepo task dependencies
└── CHANGELOG.md          # Project version updates
```

---

## 🛠️ Tech Stack

- **Monorepo**: Turborepo, npm Workspaces
- **Frontend**: React 18, Vite, TypeScript, React Router 6, Lucide Icons, Vanilla CSS Glassmorphism
- **Backend**: Node.js, Express, TypeScript, Zod, BcryptJS, JsonWebToken, Cookie Parser
- **Database & ORM**: PostgreSQL, Prisma ORM
- **Testing**: Vitest, React Testing Library, Supertest, JSDOM
- **Code Quality**: ESLint, Prettier

---

## ⚙️ Quick Start

### 1. Prerequisites
- Node.js (v18+)
- npm (v9+)
- Docker Desktop (Optional, for database)

### 2. Environment Configurations
Configure the backend server environment variables by creating `.env` at the root of the project:

```env
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/syncscript?schema=public"

# JWT Secrets
JWT_ACCESS_SECRET=your_super_secret_access_token_key_here
JWT_REFRESH_SECRET=your_super_secret_refresh_token_key_here
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
```

### 3. Install Dependencies
Run the command below in the project root to install workspace packages:
```bash
npm install
```

### 4. Database Setup & Prisma Client Generation
Generate the Prisma ORM typescript interfaces:
```bash
npm run db:generate --workspace=apps/server
```
If you have a local PostgreSQL database running, execute migrations:
```bash
npm run db:migrate --workspace=apps/server
```

### 5. Running the Project Locally
Start both the React client and the Express backend simultaneously in development mode:
```bash
npm run dev
```

- **Frontend client**: http://localhost:5173
- **Backend API**: http://localhost:4000

---

## 🧪 Testing

Both workspaces contain full unit and integration test suites. Run tests globally with:
```bash
npm test
```
To run the project linter:
```bash
npm run lint
```
To build all projects:
```bash
npm run build
```
