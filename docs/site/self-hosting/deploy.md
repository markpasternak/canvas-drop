# Deploy

A production canvas-drop runs as a single app image, fronted by an identity-aware
reverse proxy that terminates TLS and asserts identity.

## Blessed production profile

- **URL mode:** subdomain (`{slug}.{base}`) — origin isolation per canvas.
- **Auth:** `proxy` with JWT, behind an identity-aware proxy / IAP.
- **Database:** Postgres.
- **Storage:** S3-compatible.
- **TLS:** wildcard cert at the proxy (covers `*.{base}`).

Any Docker host works — a small VPS, a PaaS, or Kubernetes. Cost on a single modest
VPS is intended to stay low.

## Shape

```
            ┌─────────────────────────┐
  client ──▶│ identity-aware proxy/IAP │  TLS, asserts identity (JWT header)
            └────────────┬────────────┘
                         ▼
                 canvas-drop app  ── Postgres
                                   └ S3-compatible storage
```

The proxy's egress IPs go in `CANVAS_DROP_TRUSTED_PROXY_IPS` so only it may assert
identity. See the [Security model](/docs/self-hosting/security-model).

## Backups

Nightly `pg_dump` (or a SQLite snapshot) plus object-store versioning.

## Without a proxy

If you don't run an identity-aware proxy, use the built-in `oidc` auth mode — point
it at your OpenID provider via `CANVAS_DROP_OIDC_*`. You still get real auth without
standing up extra infrastructure.

See [Configuration](/docs/self-hosting/configuration) for the full env surface.
