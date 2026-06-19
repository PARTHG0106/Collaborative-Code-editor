# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-06-19

### Added

- **JWT Authentication Engine**: Implemented robust backend authentication with secure Access Tokens (short-lived) and Refresh Tokens (long-lived) rotation.
- **Refresh Token Rotation & Database Logs**: Integrated automatic old-token deletion transaction on refresh to prevent replay attacks and prevent session leaks.
- **Backend API Auth Endpoints**: Exposed `/register`, `/login`, `/refresh`, `/logout`, and `/me` routes with input validations verified by Zod.
- **Auth Middleware**: Created `requireAuth` Express middleware to protect access to downstream endpoints.
- **Client AuthContext**: Built global context to track authentication status, store profile details, and expose utility methods.
- **Silent Refresh Interceptors**: Designed custom Axios client with response interceptors that intercept `401 Unauthorized` responses and renew tokens transparently.
- **ProtectedRoute Guard**: Implemented route protector in React Router to redirect unauthorized visits back to `/login`.
- **Glassmorphic Login & Register Interfaces**: Created premium login and sign-up interfaces using CSS glassmorphism, indicators, and validation alerts.
- **User Dashboard**: Developed an initial dashboard area representing current session parameters and visual phase indicators.
- **Test Coverage**: Added extensive unit and integration tests for auth routes and React navigation controls.

## [0.1.0] - 2026-06-19

### Added

- **Monorepo Architecture**: Setup Turborepo workspace orchestration with npm workspaces.
- **Frontend App**: Scaffolding of React + Vite + TypeScript web application with beautiful dark-mode glassmorphic user interface.
- **Backend API**: Developed Node.js + Express API server in TypeScript supporting modular routes, customized operational errors, global handling, and robust CORS/Helmet configuration.
- **Prisma Setup**: Integrated Prisma ORM with PostgreSQL datasource, created schema with HealthCheck model, and set up automatic seed scripts.
- **Docker Integration**: Configured Docker Compose configuration for local PostgreSQL service dependency.
- **Testing Suites**: Created unit and integration test configuration using Vitest. Integrated `supertest` for backend API integration tests and `@testing-library/react` + `jsdom` for frontend React unit testing.
- **Shared Configuration Packages**: Added shared TypeScript configurations and standard ESLint specifications for both frontend and backend modules to enforce quality across the codebase.
