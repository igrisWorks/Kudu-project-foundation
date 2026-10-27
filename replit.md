# Kudu

An on-premises industrial data platform foundation for unifying existing applications, signals, and events.

## Source of truth

- The complete, portable Kudu application lives in `VS Code Edit/`. Make all frontend, backend, shared-contract, database, script, and product-documentation changes there.
- Do not implement Kudu features in root `artifacts/`, `lib/`, or other workspace template packages. Keep Replit-specific configuration minimal and limited to invoking the portable source where needed.
- A developer receiving only `VS Code Edit/` must be able to install, run, build, test, migrate, and deploy the application without Replit.
- Do not introduce cloud dependencies, external runtime services, or PLC-write operations.

## Run & operate

Run commands from `VS Code Edit/`; follow its `README.md` and `docs/DEVELOPMENT.md`.

- Runtime: Node.js 24 LTS and pnpm 10.26.1.
- Frontend: React, TypeScript, Vite.
- Backend: Fastify, TypeScript.
- Database: PostgreSQL with Kysely and versioned SQL migrations.
- Deployment: Docker Compose for Ubuntu Linux LTS and Debian stable.

Update the relevant documentation in `VS Code Edit/docs/` whenever APIs, schema, configuration, commands, deployment, or architecture change.
