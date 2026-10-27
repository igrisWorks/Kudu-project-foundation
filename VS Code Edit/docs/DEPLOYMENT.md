# Deployment

## Supported baseline

The initial deployment target is Docker Compose on Ubuntu Linux LTS or Debian stable, with Node.js 24 and PostgreSQL 18. The application container is built from the included Node 24 Debian image; PostgreSQL runs in a separate container with a named persistent volume mounted at `/var/lib/postgresql`, as required by the official PostgreSQL 18 image.

## Build and run

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` to a strong private URL-safe value (letters and numbers avoid URL-encoding errors). Do not commit or share `.env`.
3. Build and start the services:

   ```sh
   docker compose up --build -d
   ```

4. Apply database migrations:

   ```sh
   docker compose exec app pnpm db:migrate
   ```

5. Check `http://localhost:3000/api/v1/health` and open `http://localhost:3000`.

The Compose file binds PostgreSQL to loopback only. The web application is published on port 3000; place it behind the site's network controls and TLS-terminating reverse proxy before exposing it to users. Configure firewall rules and backups to match the site's operational policy.

## Operations

```sh
docker compose ps
docker compose logs -f app
docker compose logs -f db
docker compose down
```

`docker compose down` preserves the named database volume. `docker compose down -v` deletes it and permanently removes stored database data; do not use that command for routine shutdown.

The initial package is not yet a hardened production product: authentication, authorization, backup automation, monitoring, and upgrade/rollback procedures must be designed before handling operational data or exposing it to an untrusted network. It performs no PLC writes.
