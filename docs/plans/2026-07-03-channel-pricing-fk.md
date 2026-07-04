# Channel Pricing Foreign Key Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent `ModelPricing.channel` from drifting away from `AiChannel.name` after channel rename/create operations.

**Architecture:** Keep the existing business identifier `ModelPricing.channel` as a channel name, add a Prisma relation to `AiChannel.name` with `onUpdate: Cascade` and `onDelete: Restrict`, and update service queries to use that relation. Add service-level validation for admin writes so user-facing API errors stay readable instead of leaking Prisma constraint failures.

**Tech Stack:** Next.js App Router, TypeScript, Prisma 6, PostgreSQL.

---

### Task 1: Schema relation and migration

**Files:**
- Modify: `web/prisma/schema.prisma`
- Create: `web/prisma/migrations/20260703183000_channel_pricing_fk/migration.sql`

**Steps:**
1. Add `AiChannel.name @unique`.
2. Add `ModelPricing.aiChannel` relation using `fields: [channel]`, `references: [name]`, `onUpdate: Cascade`, `onDelete: Restrict`.
3. Add `AiChannel.modelPricings ModelPricing[]`.
4. Create SQL migration adding unique constraint and FK.
5. Validate schema with `DATABASE_URL=postgresql://user:pass@localhost:5432/db prisma validate`.

### Task 2: Runtime pricing resolution

**Files:**
- Modify: `web/src/server/services/pricing-service.ts`
- Modify: `web/src/app/api/models/route.ts`

**Steps:**
1. Change `resolveModel()` to `include: { aiChannel: true }`.
2. Return AppError when linked channel is disabled.
3. Change `estimateCost()` to require enabled linked channel.
4. Change `/api/models` to only list enabled pricing with enabled channel.

### Task 3: Admin write validation and seed consistency

**Files:**
- Modify: `web/src/server/services/admin-service.ts`
- Modify: `web/prisma/seed.ts`

**Steps:**
1. In `upsertPricing()`, verify the channel exists before upsert.
2. In `upsertChannel()`, preflight duplicate names excluding current id.
3. In `seed.ts`, use `channel.name` returned by channel upsert for pricing rows.

### Task 4: Verification

**Commands:**
- `set DATABASE_URL=postgresql://user:pass@localhost:5432/db&& node_modules\.bin\prisma.exe validate --schema prisma\schema.prisma`
- `node_modules\.bin\prisma.exe migrate diff --from-empty --to-schema-datamodel prisma\schema.prisma --script`
- `node_modules\.bin\tsc.exe --noEmit --pretty false` and document pre-existing unrelated errors if still present.

### Task 5: PR summary

**Steps:**
1. Review `git diff` for unrelated changes.
2. Commit implementation on `feature/channel-pricing-fk`.
3. Provide PR title, summary, validation evidence, and known baseline issues.
