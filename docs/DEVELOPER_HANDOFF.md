# Developer Handoff & Recent Updates

> **Purpose of this file.** Orient a new engineer on the codebase, then explain
> the most recent change (the **platform fee — "Fee Model A"**) in enough detail
> to continue it safely. For full setup, API surface, and design decisions see
> the [root README](../README.md); this doc does not duplicate it.

_Last updated: 2026-09-12 · Branch: `md-file-branch-updates`_

---

## 1. Codebase at a glance

Backend for the **Vocation Movement Platform**: sponsors fund specific **bills**
(tuition, books, retreats, medical…) for religious students.

- **Stack:** NestJS 10 · TypeScript (strict) · PostgreSQL 16 via Prisma 5 · Redis.
- **Money moves in exactly one place:** the signature-verified gateway **webhook
  handler**. `POST /payments/intent` only *starts* a gift; funds are credited when
  the webhook arrives. Recurring charges re-enter the same idempotent path.
- **DB is the source of truth**, stored in integer **cents**; `src/common/serializers/`
  adapts it to the frontend's dollar-unit / string-enum shapes.
- **Derived financials have a single source of truth:** `AggregationService`
  (`src/aggregation/`) recomputes `Bill.raisedCents`, religious-profile totals, and
  sponsor totals. Nothing else writes those fields.

Module map (see README §Architecture for the annotated version):

```
src/
├── config/         typed AppConfig from env (APP_CONFIG token)
├── prisma/         PrismaService (global)
├── redis/          refresh tokens + rate-limit counters (global)
├── providers/      payments / storage / email adapters (stub + live)
├── notifications/  in-app notifications + templated emails (global)
├── aggregation/    single source of truth for derived financials + shared clock
├── settings/       NEW — effective platform settings + Fee Model A math (global)
├── auth/  religious/  bills/  admin/  payments/  sponsors/  messages/  inquiries/  jobs/
```

---

## 2. Recent update — Platform Fee ("Fee Model A")

### 2.1 What it is

A configurable platform fee, expressed as a percentage (`platformFeePercent`).
**Model A means the fee is _deducted from the gift_:**

- The sponsor is **charged the full gift** (gross) at the gateway.
- The platform keeps `feeCents = round(gift × fee%)`.
- The student's bill / progress bar advances only by the **net** (`gift − fee`).

With the default `platformFeePercent = 0`, `feeCents = 0` and **net == gross**, so
all existing and seeded numbers are unchanged. The fee only ever changes behaviour
once an admin sets a non-zero percentage.

The rule lives in one place — `SettingsService.computeFee()`
([../src/settings/settings.service.ts](../src/settings/settings.service.ts)):

```
feeCents = clamp(round(gift × fee%), 0, gift)
chargeCents = gift            // what the sponsor pays
netCents = gift − feeCents    // what the bill receives
```

### 2.2 Data model

Three new columns + one settings model (in
[../prisma/schema.prisma](../prisma/schema.prisma)):

| Model | Field | Meaning |
|---|---|---|
| `Payment` | `feeCents` | platform fee taken from the gift (default `0`) |
| `Payment` | `netAmountCents` | `amountCents − feeCents`; credited to bills |
| `PaymentSplit` | `netAmountCents` | per-bill portion net of fee; **drives the progress bar** |
| `PlatformSettings` | `platformFeePercent`, `minGiftCents`, … | admin-editable singleton (id `singleton`) |

`amountCents` on both `Payment` and `PaymentSplit` still holds the **gross** — it is
what the sponsor was charged and what the receipt shows. Net is additive, never a
replacement, so history is preserved.

### 2.3 The three integrations performed

1. **Settings module wired in.** `SettingsModule` (`@Global`) is registered in
   [../src/app.module.ts](../src/app.module.ts), so `SettingsService` injects
   anywhere without importing the module.

2. **Aggregation reads net.** In
   [../src/aggregation/aggregation.service.ts](../src/aggregation/aggregation.service.ts):
   - `recomputeBill` → `Bill.raisedCents` sums `PaymentSplit.netAmountCents`.
   - `recomputeReligiousAggregates` → `totalRaisedCents` sums `Payment.netAmountCents`
     (so a profile total equals the sum of its bills' progress bars).
   - **Intentionally left gross:** `sponsorAggregates.totalGivenCents` — the sponsor
     really did pay the full gift, so "total given" is the gross.

3. **Payments write net.** In
   [../src/payments/payments.service.ts](../src/payments/payments.service.ts) a private
   `feeFor(amountCents)` helper resolves the current fee % and computes the breakdown;
   `feeCents` + `netAmountCents` are then persisted on the `Payment` **and** its split in
   **all three** creation paths:
   - `createIntent` — one-off gift
   - `createRecurring` — first charge of a subscription
   - `recordRecurringCharge` — later cron-driven renewals

   Gateway charge amounts are **unchanged** (the sponsor still pays gross); fee/net is
   internal bookkeeping only.

Supporting pieces already in place: config defaults
(`defaults.platformFeePercent`, `minGiftCents` in
[../src/config/configuration.ts](../src/config/configuration.ts)), the admin
read/write of `platformFeePercent`
([../src/admin/admin.service.ts](../src/admin/admin.service.ts)), and seed rows that
set `feeCents: 0` / `netAmountCents == gross`
([../prisma/seed.ts](../prisma/seed.ts)).

### 2.4 Status

- ✅ All code changes complete; Prisma client regenerated.
- ✅ `npm run typecheck` (`tsc --noEmit`) passes with **no errors**.
- ⏳ **Database not yet migrated** (see §3).

---

## 3. How to continue

1. **Apply the schema to the database.** There is **no `prisma/migrations/` folder
   yet** — this is the project's first migration, so it's a deliberate choice:
   ```bash
   npx prisma migrate dev --name platform_fee_model_a   # starts migration history (recommended)
   # or, for schema-sync without history:
   npx prisma db push
   ```
   Then reseed if desired: `npm run db:seed`.

2. **Decide admin-reporting semantics (open question).** Admin KPIs/reports in
   [../src/admin/admin.service.ts](../src/admin/admin.service.ts) (`totalAmount`,
   `fundsRaised`) still sum **gross** `amountCents`. That is defensible ("amount
   processed" is gross), but if "funds raised" should mean **net**, switch those
   aggregates to `netAmountCents` to match the progress bars.

3. **Add tests.** None yet for this feature. Worth covering:
   - `SettingsService.computeFee` — rounding, `fee% = 0`, clamping to `[0, gift]`.
   - Aggregation — a confirmed payment with a non-zero fee advances `raisedCents`
     by the **net**, not the gross.

4. **Possible follow-ups.**
   - `minGiftCents` is configured but not yet enforced on gift creation — add a
     validation in the payment intent path if that's intended.
   - Multi-bill splits: today each payment has a single split, so the split's net
     equals the payment's. If gifts are ever split across multiple bills, the fee
     must be **allocated proportionally** across splits (the per-split
     `netAmountCents` column already supports this).

---

## 4. Touched files (this change)

| File | Change |
|---|---|
| [../prisma/schema.prisma](../prisma/schema.prisma) | `PlatformSettings` model; `feeCents`/`netAmountCents` columns |
| [../prisma/seed.ts](../prisma/seed.ts) | seed fee=0 / net==gross |
| [../src/settings/settings.service.ts](../src/settings/settings.service.ts) | `effective()` + `computeFee()` (Fee Model A math) |
| [../src/settings/settings.module.ts](../src/settings/settings.module.ts) | `@Global` module |
| [../src/app.module.ts](../src/app.module.ts) | register `SettingsModule` |
| [../src/aggregation/aggregation.service.ts](../src/aggregation/aggregation.service.ts) | bill + religious totals sum net |
| [../src/payments/payments.service.ts](../src/payments/payments.service.ts) | inject `SettingsService`; `feeFor()`; persist fee/net in 3 paths |
| [../src/config/configuration.ts](../src/config/configuration.ts) | `platformFeePercent` / `minGiftCents` defaults |
