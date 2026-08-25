# Vocation Movement — Backend API

Backend for the **Vocation Movement Platform**: a funding platform where sponsors
support religious students (seminarians, novices, postulants) by funding specific
**bills** (tuition, books, retreats, medical, etc.). Built to satisfy the existing
Next.js 14 frontend's API contract exactly, following the structure of the
Backend PRD (v1.0).

- **Framework:** NestJS 10 · TypeScript (strict)
- **Data:** PostgreSQL 16 (Prisma 5) · Redis (refresh tokens + rate limiting)
- **Auth:** RS256 JWT access tokens + httpOnly refresh cookie · bcrypt (cost 12)
- **Payments:** Stripe + Paystack behind an adapter, driven entirely by
  signature-verified webhooks (card data never touches this server)
- **Providers:** Stripe / Paystack / S3 / Cloudinary / Resend sit behind
  interfaces with **stub** implementations, so the whole app runs locally with
  **zero external accounts**.

---

## Quick start (local, zero external accounts)

Requires Node 20+, npm, and Docker (for Postgres + Redis).

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
docker compose up -d

# 3. Generate the Prisma client, create the schema, and seed demo data
npm run prisma:generate
npm run prisma:migrate      # creates tables (dev migration)
npm run db:seed             # demo admin, sponsor, 10 students, bills, gifts

# 4. Run the API (watch mode)
npm run start:dev
```

The API listens on **http://localhost:4000** with every route under **`/api`**
(e.g. `GET http://localhost:4000/api/stats/platform`). Uploaded files (stub
storage) are served at **`/storage/*`**.

`PROVIDER_MODE=stub` (the default in `.env`) means payments, emails, and uploads
are simulated and logged — nothing leaves your machine. Set `PROVIDER_MODE=live`
and fill in the relevant keys to use the real SDKs.

> **Demo clock.** The seed data and frontend both treat **2026-08-18** as "today".
> `.env` ships with `NOW_OVERRIDE=2026-08-18` so overdue-bill logic lines up with
> the demo. Clear it in production to use the real clock. (Token expiry always
> uses the real clock.)

### Seeded demo accounts

| Role    | Email                                 | Password           |
|---------|---------------------------------------|--------------------|
| Admin   | `admin@vocationmovement.org`          | `ChangeMe!Admin123`|
| Sponsor | `onyeka.a@example.com`                | `Sponsor!Demo123`  |
| Student | `brother-emeka-okonkwo@example.com`   | `Student!Demo123`  |

All 10 seeded students share the password `Student!Demo123`; their emails follow
`<slugified-full-name>@example.com`. One student is intentionally left **pending
approval** to exercise the admin verification workflow.

> Admins are **never** self-registered — the seed (and `POST`-free admin flow)
> creates them. The UI only logs admins in.

---

## Architecture

```
src/
├── main.ts                 # bootstrap: rawBody, helmet, CORS, cookies, /storage, /api prefix
├── worker.ts               # one-shot job runner (npm run worker [recurring|overdue|cleanup])
├── app.module.ts           # wires all modules + global guards/interceptor/filter + scheduler
│
├── config/                 # typed AppConfig from env (APP_CONFIG token)
├── prisma/                 # PrismaService (global)
├── redis/                  # RedisService: refresh tokens + rate-limit counters (global)
├── providers/              # adapter layer — payments / storage / email (stub + live)
├── notifications/          # in-app notifications + templated emails (global)
├── aggregation/            # single source of truth for derived financials + shared clock
├── uploads/                # profile photos, documents, attachments (global)
│
├── auth/                   # register/login/refresh/logout, email verify, password reset
├── religious/              # student profiles, dashboard, bills-by-student, documents
├── bills/                  # create/update/archive bills, contributions
├── admin/                  # KPIs, verification queue, transactions, reports, settings
├── payments/               # intent/confirm/recurring, webhooks, split logic, receipts
├── sponsors/               # sponsor profile, dashboard, students, recurring management
├── messages/               # thank-you notes + threaded replies (anonymity-proxied)
├── inquiries/              # public contact form + admin inbox
└── jobs/                   # cron sweeps (overdue/cleanup/recurring) + public platform stats
```

### Key design decisions

- **DB is the source of truth; the serialization layer adapts it to the frontend.**
  `src/common/serializers/` converts PRD-native DB shapes (enums, integer *cents*)
  into the frontend's `types.ts` shapes (string unions, dollar *units*). Controllers
  return frontend-shaped objects.
- **Anonymity is enforced at serialization — never by deleting data** (PRD §4.2).
  An anonymous sponsor's real identity is always stored; it is hidden per-viewer
  when serialized, and message threads are proxied so a student can thank an
  anonymous donor without ever learning who they are.
- **Money moves in exactly one place: the webhook handler.** `POST /payments/intent`
  only *starts* a gift; funds are credited when the (signature-verified) gateway
  webhook arrives. Recurring charges re-enter the same idempotent path, so there is
  a single, auditable code path for all crediting.
- **Standard envelopes.** Every success is `{ success: true, data, message?, meta? }`
  (via the global `ResponseInterceptor`); every error is
  `{ success: false, error: { code, message, statusCode, details? } }`
  (via the global `AllExceptionsFilter`). 5xx internals are never leaked.
- **Three global guards, in order:** `JwtAuthGuard` (RS256 Bearer; skips `@Public()`)
  → `RolesGuard` (`@Roles(...)`) → `RateLimitGuard` (`@RateLimit(...)`, Redis-backed).

---

## API surface

All paths are prefixed with `/api`. `🔓` = public, `👤` = authenticated,
role in brackets.

### Auth — `/auth`
| Method | Path | Access |
|---|---|---|
| POST | `/register` | 🔓 (sponsor or religious; never admin) |
| POST | `/login` | 🔓 |
| POST | `/refresh` | 🔓 (reads refresh cookie) |
| POST | `/logout` | 🔓 |
| GET  | `/verify-email/:token` | 🔓 |
| POST | `/forgot-password` | 🔓 |
| POST | `/reset-password` | 🔓 |
| GET  | `/me` | 👤 |

### Students — `/religious`
| Method | Path | Access |
|---|---|---|
| GET | `/` | 🔓 (browse/filter approved students) |
| GET | `/:id` | 🔓 (public profile) |
| GET | `/me/dashboard` | [RELIGIOUS] |
| GET | `/me/payments` | [RELIGIOUS] |
| GET | `/me/documents` | [RELIGIOUS] |
| POST | `/profile` · PATCH `/profile` | [RELIGIOUS] |
| POST | `/photo` · POST `/documents` | [RELIGIOUS] |

### Bills — `/bills`
| Method | Path | Access |
|---|---|---|
| GET | `/religious/:id` | 🔓 (a student's bills) |
| GET | `/:id` · GET `/:id/contributions` | 🔓 |
| POST | `/` · PUT `/:id` · PATCH `/:id/archive` | [RELIGIOUS] |

### Payments — `/payments`
| Method | Path | Access |
|---|---|---|
| POST | `/intent` | [SPONSOR] |
| POST | `/confirm` | [SPONSOR] |
| POST | `/recurring` | [SPONSOR] |
| GET | `/:id/receipt` | 👤 (owner or admin) |
| POST | `/webhooks/stripe` · `/webhooks/paystack` | 🔓 (signature-verified) |

### Sponsors — `/sponsors` (all [SPONSOR])
`GET /me`, `GET /me/dashboard`, `GET /me/students`, `GET /me/payments`,
`GET /me/recurring`, `POST /profile`, `PATCH /profile`,
`PATCH /me/recurring/:id/pause|resume`, `DELETE /me/recurring/:id`.

### Messages — `/messages`
| Method | Path | Access |
|---|---|---|
| GET | `/` | [RELIGIOUS, SPONSOR] |
| POST | `/` | [RELIGIOUS] (thank a sponsor who funded them) |
| POST | `/:id/replies` | [RELIGIOUS, SPONSOR] |
| PATCH | `/:id/read` | [RELIGIOUS, SPONSOR] |

### Inquiries — `/inquiries`
| Method | Path | Access |
|---|---|---|
| POST | `/` | 🔓 (contact form; rate-limited by IP) |
| GET | `/` · PATCH `/:id/read` · DELETE `/:id` | [ADMIN] |

### Admin — `/admin` (all [ADMIN])
`GET /kpis`, `GET /overview`, `GET /pending`, `GET /verifications`,
`POST /verify/:id`, `POST /reject/:id`, `POST /request-info/:id`,
`POST /suspend/:userId`, `GET /transactions`, `GET|POST /reports`,
`GET|PATCH /settings`.

### Public stats — `/stats`
`GET /platform` 🔓 — marketing headline numbers.

---

## Background jobs (PRD §8)

Runs two ways: in-process via `@nestjs/schedule` (active whenever the API is up),
or as a one-shot process for external schedulers.

| Job | Schedule | What it does |
|---|---|---|
| `recurring-charges` | daily 01:00 | Charge due monthly sponsorships (via the webhook path) |
| `overdue-bills` | daily 02:00 | Flag past-due, under-funded bills `OVERDUE` + notify |
| `cleanup-tokens` | daily 03:00 | Delete used/expired email + reset tokens |

```bash
npm run worker            # run all three once, then exit
npm run worker recurring  # just recurring charges
npm run worker overdue    # just the overdue sweep
npm run worker cleanup    # just token cleanup
```

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | API in watch mode |
| `npm run build` / `npm run start:prod` | Compile to `dist/`, then run `node dist/main` |
| `npm run worker` / `worker:prod` | One-shot background jobs (ts-node / compiled) |
| `npm run typecheck` | `tsc --noEmit` (whole project, incl. seed) |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:migrate` / `prisma:deploy` | Dev migration / prod migrate |
| `npm run db:seed` / `db:reset` | Seed demo data / reset + reseed |
| `npm run prisma:studio` | Browse the DB in Prisma Studio |
| `npm run lint` / `format` | ESLint / Prettier |

---

## Environment

See [`.env.example`](.env.example) for the full, documented list. The committed
[`.env`](.env) is pre-filled for local stub mode. Highlights:

- `PROVIDER_MODE` — `stub` (default) or `live`.
- `DATABASE_URL`, `REDIS_URL` — match `docker-compose.yml`.
- `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` — RS256 PEMs; blank in dev auto-generates
  an ephemeral pair each boot (tokens invalidate on restart).
- `NOW_OVERRIDE` — freeze the clock for demo-consistent overdue logic.
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — the bootstrap admin.

---

## Security notes (PRD §5)

- Passwords hashed with **bcrypt cost 12**; never stored or logged in plaintext.
- Access token is a short-lived RS256 JWT (Authorization header). The refresh
  token lives in an **httpOnly cookie** and in Redis (`refresh:<userId>:<tokenId>`)
  — never in localStorage.
- **Card data never touches this server** — the client tokenizes with the gateway;
  we only ever see gateway references.
- **Webhooks are signature-verified** before any state change (Stripe
  `constructEvent`; Paystack HMAC-SHA512; the stub self-signs with the same scheme).
- Per-route **rate limiting** (Redis) on login, registration, contact form, and
  payment endpoints.
- **Admins never self-register** — no code path creates an admin from a public
  request; they come from the seed/backend only.
