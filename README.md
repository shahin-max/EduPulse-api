# EduPulse Academy API (Phase 1)

Backend for EduPulse Academy, Aligarh. NestJS 12 + Prisma 7 + MySQL 8, on the existing
`edupulse_lms` schema (37 tables). Interactive API docs are served at **`/docs`** (Swagger UI) and
**`/docs-json`** (OpenAPI).

## Requirements

- Node.js **22.22.3+** (or 24.15+); npm 11 recommended. With npm 10 run installs as `npx npm@11 install`
  (npm 10 has a known crash resolving this dependency tree).
- MySQL 8.

## Setup

```sh
npx npm@11 install                     # also runs `prisma generate`
cp .env.example .env                   # set DATABASE_URL and two different random JWT secrets
npm run db:deploy                      # apply migrations (fresh database)
npm run db:seed                        # roles, the 9 courses, first admin (SEED_ADMIN_*)
npm run start:dev                      # http://localhost:3000/api/v1, docs at /docs
```

Special characters in the database password must be URL-encoded in `DATABASE_URL` (`@` → `%40`).

### Existing `edupulse_lms` database

The schema was created by hand before this project. `prisma/migrations/0_init` is that exact DDL
(including CHECK constraints and `ON UPDATE` timestamps), and on the existing database it has been
marked as already applied (`prisma migrate resolve --applied 0_init`). New schema changes go in new
migrations created with `npm run db:migrate -- --name <change>`.

> `prisma/schema.prisma` cannot express CHECK constraints. Never regenerate `0_init` from it.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | Run with reload |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run it |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests against the database in `.env.test` (**deletes all rows**; name must end in `_test`) |
| `npm run typecheck` / `npm run lint` | Type check / oxlint |
| `npm run db:deploy` / `db:migrate` / `db:seed` / `db:studio` | Prisma |

Set `E2E_DATABASE_URL` to run an e2e suite against another `*_test` database.

## Roles and permissions

Users can hold several roles (`user_roles`).

| Role | Can |
|---|---|
| **ADMIN** | Everything: users and roles, courses, batches, enrollments, fees, enquiries, website content, audit log |
| **FACULTY** | Author chapters, study materials and questions; manage the batches they are assigned to in `batch_faculty` (classes, attendance, assignments, exams, batch announcements, rosters); follow up enquiries assigned to them |
| **STUDENT** | Own profile; content, classes, assignments, exams, announcements and results of batches where they hold an **ACTIVE** enrollment; own attendance and fees |
| Visitor | Published courses and syllabus, open batches, faculty list, website content, enquiry form, sign-up |

Every request re-checks the session, account status and roles in the database, so logout,
suspension and role changes take effect immediately (not when the 15-minute access token expires).

## Authentication

- `POST /api/v1/auth/register` (students), `POST /auth/login` with email **or** mobile.
- Access token (15 min) + refresh token (7 days), one `auth_sessions` row per device. Refresh tokens
  rotate on every use; replaying an old one ends that session.
- Password reset and email/mobile verification use single-use tokens in `auth_tokens` (stored hashed).
  Accounts with an email get a link by email (`@nestjs/mail`; set `SMTP_URL`, `MAIL_FROM` and
  `APP_WEB_URL`): `/set-password?token=` for resets and `/verify-email?token=` for verification. Without
  `SMTP_URL` the email is only logged (with the link outside production). **No SMS provider is connected
  yet**: tokens for mobile-only accounts are only logged. Tokens are returned as `devToken` when
  `EXPOSE_DEV_TOKENS=true` outside production. Admins can also issue a token with
  `POST /users/:id/password-token`, and creating a user without a password returns a `setupToken`.
- Mobiles are stored as `+91XXXXXXXXXX`; `98765 43210`, `09876543210` and `+91 98765-43210` all match.

## API conventions

- Prefix `/api/v1`. Field names in responses match the database (snake_case); request bodies are camelCase.
- Ids are numbers. Money and marks (DECIMAL) are strings such as `"1500.00"` to keep exact values.
- Lists are paginated: `?page=1&limit=20` → `{ data, meta: { page, limit, total, totalPages } }`.
- Errors use Nest's shape `{ statusCode, message, error }`. Unknown body fields are rejected (400).
  Duplicates → 409; deleting something still in use → 409 (archive/cancel it instead).
- Mutating requests by logged-in users are written to `audit_logs` (`GET /audit-logs`, admin), without
  request bodies.
- Rate limits: 120 requests/min per IP overall; 5–10/min on login, sign-up, password reset and public forms.

## Project layout

```
prisma/            schema.prisma, migrations/0_init (baseline DDL), seed.ts
src/common/        auth decorators, guards, AccessService (batch permissions), validation, pagination
src/auth/          login, sessions, password reset, verification
src/users/         users & roles, student and faculty profiles
src/catalog/       subjects, courses, course subjects, chapters
src/batches/       batches, faculty assignment, enrollments
src/website/       admission enquiries, website content
src/learning/      files, study materials, progress, assignments, submissions
src/exams/         question bank, exams, attempts, grading, leaderboards
src/classes/       class sessions, attendance
src/fees/          fee plans, invoices, payments, refunds
src/communications/ announcements, notifications
src/audit/         audit interceptor and log
src/mail/          email transport (SMTP, or logged when not configured)
test/              e2e suites and helpers
```

Uploaded files are stored on local disk under `UPLOAD_DIR` (default `./uploads`); back that folder up
with the database.
