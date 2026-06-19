# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] - 2026-06-19

### Added

- **Monaco Editor Integration**: Replaced fallback textarea with the official Monaco Editor component from `@monaco-editor/react`.
- **Dynamic Syntax Highlighting**: Added lookup heuristics mapping file extensions (`.js`, `.ts`, `.py`, `.html`, `.css`, `.json`, `.md`, `.sql`, `.sh`, `.yml`) to native Monaco language types.
- **IDE Settings Toolbar**: Added interactive header controls to toggle word wrap, show/hide code minimap, and alternate editor themes (`vs-dark` vs `light`).
- **Vitest Mocking Strategy**: Added virtual JSDOM editor interceptors in unit test files to ensure testing suite passes successfully without DOM canvas runtime constraints.

## [0.4.0] - 2026-06-19

### Added

- **File System Database Model**: Added `FileSystemItem` model and `FileSystemItemType` enum supporting hierarchical trees, parent relationships, and CASCADE deletion.
- **File System REST API**: Exposed `/api/workspaces/:workspaceId/files` CRUD endpoints to create, fetch, update content/name, and delete items.
- **Tabbed IDE Dashboard**: Restructured the frontend workspace console with custom tab views separating the primary Code Editor workspace from Settings/Collaborators control panels.
- **File Tree Sidebar**: Developed an interactive directory explorer component rendering recursively with folder chevron toggles, inline name creators, and actions to rename or delete nodes.
- **Scroll-Synced Editor Pane**: Built a dark code workspace consisting of a sidebar showing scroll-synchronized line numbers alongside a monospace font textarea.
- **Debounced Auto-Saving**: Implemented a frontend timer to automatically commit file edits to the database after 1.5 seconds of inactivity.
- **Vitest Suites**: Added 10 backend integration tests and 4 frontend tree-navigation tests.

## [0.3.0] - 2026-06-19

### Added

- **Workspace Database Model**: Expanded Prisma schema with `Workspace` and `WorkspaceMember` models supporting role-based access control enum roles: `OWNER`, `EDITOR`, `VIEWER`.
- **Workspace REST API Endpoints**: Implemented workspace CRUD operations (`GET /workspaces`, `POST /workspaces`, `GET /workspaces/:id`, `PATCH /workspaces/:id`, `DELETE /workspaces/:id`).
- **Workspace Membership Endpoints**: Implemented invite/remove membership controls (`POST /workspaces/:id/members`, `DELETE /workspaces/:id/members/:userId`) and self-leave action (`DELETE /workspaces/:id/members/:userId`).
- **Authorization Guard Middlewares**: Created `requireWorkspaceMember` middleware to ensure membership and check permission level (`OWNER`, `EDITOR`, `VIEWER`) prior to invoking route handlers.
- **Glassmorphic Workspaces Dashboard**: Created a beautiful frontend workspaces interface supporting workspace listing, loading indicators, empty states, and modal creators.
- **WorkspaceDetail Management Console**: Developed a workspace settings panel allowing users to edit workspace name/description, view and update members' roles, invite members by email, and leave/delete the workspace.
- **Vitest Unit and API Tests**: Added 15 backend API integration tests for workspace operations and 4 frontend Dashboard unit tests covering lists, modals, and detail navigations.

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
