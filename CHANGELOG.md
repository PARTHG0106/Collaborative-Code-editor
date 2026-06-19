# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-06-19

### Added

- **Monorepo Architecture**: Setup Turborepo workspace orchestration with npm workspaces.
- **Frontend App**: Scaffolding of React + Vite + TypeScript web application with beautiful dark-mode glassmorphic user interface.
- **Backend API**: Developed Node.js + Express API server in TypeScript supporting modular routes, customized operational errors, global handling, and robust CORS/Helmet configuration.
- **Prisma Setup**: Integrated Prisma ORM with PostgreSQL datasource, created schema with HealthCheck model, and set up automatic seed scripts.
- **Docker Integration**: Configured Docker Compose configuration for local PostgreSQL service dependency.
- **Testing Suites**: Created unit and integration test configuration using Vitest. Integrated `supertest` for backend API integration tests and `@testing-library/react` + `jsdom` for frontend React unit testing.
- **Shared Configuration Packages**: Added shared TypeScript configurations and standard ESLint specifications for both frontend and backend modules to enforce quality across the codebase.
