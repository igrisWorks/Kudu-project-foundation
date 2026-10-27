# Architecture

## Current foundation

Kudu is a single TypeScript pnpm workspace with three packages: a React/Vite frontend, a Fastify API, and shared API contracts. PostgreSQL is the only database. Kysely provides typed SQL access; ordered SQL files are applied by a small backend-owned migration runner.

The browser talks to the versioned REST API at `/api/v1`. Vite proxies `/api` to the local API during development. In a production build, Fastify serves the built frontend and API from one process. The app and database run as separate Docker Compose services.

## Boundaries

- Domain and application behavior belong in backend modules, not route handlers or React components.
- Routes validate external input and format contract-shaped responses.
- Repositories and persistence use PostgreSQL through Kysely and parameterized SQL.
- Future connectors should normalize data through application services while preserving source provenance; they should not write directly from UI or route code.
- Local media belongs behind a storage abstraction. The initial foundation does not expose filesystem access or media endpoints.
- A future MCP adapter should call the same application services as REST. It is not part of this foundation.

## Portability and security

`VS Code Edit/` is the source of truth. The surrounding Replit workspace may contain platform routing and tooling, but Kudu's application and setup must remain runnable from this directory alone. No Replit service, cloud database, external API, or internet connection at runtime is required after dependencies and container images are present.

The API exposes liveness and readiness probes plus versioned asset and data-source registry routes. Asset parent links are validated and cycle-checked while serialized with a PostgreSQL advisory lock. Data-source registration stores metadata only; it does not connect, read files, or ingest data. The API has no machine-control operations.

Registry writes are currently unauthenticated. The default development host is loopback, and Docker Compose publishes the app port only on loopback. Do not expose this release to untrusted networks until authentication and authorization are implemented. Database access uses configured credentials; migrations are transactional, serialized with a separate PostgreSQL advisory lock, and reject checksum changes to already-applied files.

## Compatibility decisions

- Node.js 24 LTS and pnpm 10.26.1 are pinned as the development baseline.
- Fastify 5 is used with the matching `@fastify/static` 8.x plugin line.
- PostgreSQL 18 is the Compose target; PostgreSQL 17 remains a supported alternative for sites that need compatibility with existing installations.
- React, Vite, and TypeScript use stable releases with exact package versions and a committed lockfile.
