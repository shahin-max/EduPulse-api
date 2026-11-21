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

### Branches: head office and branch admins

Nobody picks a branch before signing in: the account decides. Everyone uses the same login page.

- **Head office** = the global `ADMIN` role. Sees and runs every branch; `branchId` on lists (batches,
  enrollments, invoices, payments, enquiries, `/reports/admin-summary`) narrows to one branch for the portal's
  branch switcher.
- **Branch admin** = `ADMIN` in `branch_staff` for a branch, without the global role. Head office adds one with
  `POST /branches/:id/staff { userId, role: "ADMIN" }` and removes them with
  `DELETE /branches/:id/staff/:userId/ADMIN` (access ends on the next request; closing the branch ends it too).
  Responses report them with the role `BRANCH_ADMIN`, and `GET /auth/me` returns `is_head_office` and
  `admin_branches`, so the website sends them to the admin portal limited to those branches.
- A branch admin manages, at their branches only: batches (only for courses head office offers there:
  `PUT/DELETE /branches/:id/courses/:courseId`), faculty assignment (faculty on the branch staff), enrollments,
  classes and attendance, fee plans/invoices/payments/refunds (plans for every branch are read-only), enquiries,
  BRANCH and batch announcements, gradebooks and the admin summary. They see their branches' students and faculty
  plus students not admitted anywhere yet, and can create STUDENT and FACULTY accounts (new faculty join their
  branch staff, `branchId` picks the branch when they run several).
- Head office only: branches, the course catalog and question bank, website content, Scholarship Tests, roles,
  deleting accounts, the audit log and other admins.
- Enquiries carry a branch: the website form may send `branchId`; with a single active branch it is filled in,
  otherwise head office routes it (`GET /admission-enquiries?unrouted=true`, then `PATCH { branchId }`). Branch
  admins are notified of their branches' new enquiries.
- Faculty work at several branches by being on each branch's staff (`role: "FACULTY"`); what they can open is
  still decided by `batch_faculty`.

Every request re-checks the session, account status and roles in the database, so logout,
suspension and role changes take effect immediately (not when the 15-minute access token expires).

## Authentication

- `POST /api/v1/auth/register` (students), `POST /auth/login` with email **or** mobile.
- Access token (15 min) + refresh token (7 days), one `auth_sessions` row per device. Refresh tokens
  rotate on every use; replaying an old one ends that session.
- Password reset and email/mobile verification use single-use tokens in `auth_tokens` (stored hashed).
  Accounts with an email get a link by email (`@nestjs/mail`; set `SMTP_URL`, `MAIL_FROM` and
  `APP_WEB_URL`): `/set-password?token=` for resets and `/verify-email?token=` for verification. Without
  `SMTP_URL` the email is only logged (with the link outside production). Mobile-only accounts get the link
  by SMS when `SMS_PROVIDER` is set: `twilio` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`) or
  `msg91` for Indian DLT routes (`MSG91_AUTH_KEY` and one approved Flow template per message,
  `MSG91_TEMPLATE_PASSWORD_RESET` and `MSG91_TEMPLATE_MOBILE_VERIFY`, each with a `##link##` variable). The API
  refuses to start with a half-configured provider. Without one, SMS are only logged. Tokens are returned as `devToken` when
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

## Deploying (Railway API + Netlify website)

**Railway (this API + MySQL)**

- Build: `npm run build`. Start: `npm run start:prod`. Pre-deploy (or once per release):
  `npx prisma migrate deploy`. Health check path: `/api/v1/health`.
- Variables: `NODE_ENV=production`, `DATABASE_URL` (Railway MySQL; URL-encode special characters),
  `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (two different random strings of 32+ characters),
  `CORS_ORIGINS` (the Netlify URL and any custom domain, comma separated), `APP_WEB_URL` (the public site,
  for email links), `SMTP_URL` and `MAIL_FROM` (password reset emails), `EXPOSE_DEV_TOKENS=false`.
  Optionally `SMS_PROVIDER` and its keys (see Authentication). Railway sets `PORT`.
- Background jobs run every minute (`JOBS_ENABLED`, on by default) and take a MySQL lock (`job_locks`), so
  running several API instances is safe: each job runs on one of them at a time.
- `TRUST_PROXY` defaults to 1 in production, which matches Railway's proxy; without it every visitor would
  share one rate limit and audit logs would show the proxy's address.
- **Uploads:** set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` (and optionally
  `CLOUDINARY_FOLDER`, default `edupulse`) so files are stored on Cloudinary. Without them files go to the
  container disk, which is wiped on every deploy: then attach a Volume (e.g. at `/data`) and set
  `UPLOAD_DIR=/data/uploads`. Files uploaded to disk before Cloudinary was set up still need that disk.
- Back up the MySQL database and the uploads volume regularly (e.g. a scheduled `mysqldump`).

**Netlify (the Edupulse-LMS website)**

- Variables: `NEXT_PUBLIC_API_URL=https://<railway-api-domain>/api/v1` and `NEXT_PUBLIC_SITE_URL` (the public
  site address, used for the sitemap and links). `NEXT_PUBLIC_*` values are built in, so redeploy the site
  after changing them.

## Fees: invoice and receipt numbers

- Numbers are `<branch prefix>/<financial year>/<sequence>`, e.g. `ALG/26-27/0001` for invoices and
  `ALGR/26-27/0001` for receipts. Each branch has its own consecutive series per Indian financial year
  (April to March, IST), kept in `document_sequences`; the series restarts every April.
- Draft invoices are numbered `DRAFT-<id>`; the real number is taken when the invoice is **issued**, so
  discarded drafts leave no gaps. Receipt numbers are taken when a payment is **confirmed**.
- Each branch needs its own invoice and receipt prefixes (the API refuses duplicates). Keep prefixes to 5
  characters or fewer so numbers fit GST's 16-character limit.
- `GET /fee-invoices` returns `summary` (billed, collected, outstanding) over every matching invoice;
  `GET /payments` is the payments register (filter by `from`/`to`, branch, method) with totals by method,
  refunds in the period and the net collection.

## Files and profile photos

- `POST /files` stores new files on Cloudinary when it is configured (`file_assets.bucket = 'cloudinary'`), else on
  disk (`'local'`). Cloudinary files are uploaded as **authenticated**: a plain Cloudinary link is refused, and
  `GET /files/:id/content` checks access and then streams the file through a one-minute signed link. Images are
  stored as Cloudinary images, everything else (PDF, Word, video) as raw files.
- Profile photos: `PUT /me/photo` (any signed-in user, multipart field `photo`, JPEG/PNG/WebP/GIF up to 5 MB,
  checked by content) and `DELETE /me/photo`; admins use `PUT/DELETE /users/:id/photo`. Photos are public,
  cropped square around the face at 512 px, and returned as `photo_url` on users and on `GET /faculty`.
  They need Cloudinary (503 without it).
- The e2e suites blank the Cloudinary keys, so tests never upload to a real account.

## Scholarship Tests

The whole flow reuses the batch and exam engine (migration `5_scholarships`):

1. **Set up (admin):** `POST /scholarship-tests` with title, eligible classes, score slabs
   (`[{ minPercentage, discountPercent }]`), the online window and duration, registration deadline and how long
   awards stay valid. It creates a candidates batch and a draft exam in the hidden, draft "Scholarship Tests"
   course (created on first use with every subject attached), so the paper is built with the normal question bank
   and exam builder (pictures, maths, OMR included).
2. **Open:** `POST /scholarship-tests/:id/open` (needs questions) publishes the exam and opens registration.
   `GET /scholarship-tests/current` (public) returns `{ test }` for the website button.
3. **Register:** a student (signing up on the website first if needed) calls `POST /scholarship-tests/:id/join`
   with their class; they are enrolled in the candidates batch only (hidden from their course lists) and an
   enquiry with source `SCHOLARSHIP_TEST` is created for the office.
4. **Take the test** in the student portal within the window (`GET /student/scholarships`), one attempt.
5. **Results (admin):** `GET /scholarship-tests/:id/results` ranks candidates by their best graded attempt and
   suggests the slab; `PUT /scholarship-tests/:id/awards/:studentUserId` overrides (null resets to the slab);
   `POST /scholarship-tests/:id/publish` stores the awards, releases the scores and notifies candidates.
6. **Admission:** `GET /students/:userId/scholarships` lists usable awards; `POST /fee-invoices` with
   `scholarshipAwardId` adds the % off the gross amount to the discount and uses the award up (voiding the invoice
   releases it).

## Pictures in test questions

Questions and options may carry a picture (`imageAssetId` on create/update, `image_asset_id` in responses): upload
the image first with `POST /files` (PNG, JPEG, GIF or WebP). An option needs text, a picture or both, so
non-verbal reasoning options can be pictures only. Pictures are private: a student can open them
(`GET /files/:id/content`) only once they have an attempt at an exam that uses the question, so a paper's figures
can't be seen before the test starts. Maths in question text is written between `$` signs and rendered by the
website (KaTeX).

## Teaching reports

For admins and the faculty assigned to the batch:

- `GET /teaching/dashboard`: submissions waiting for review, classes from the last 14 days without attendance,
  assignments due in the next 7 days (with how many were handed in), open or upcoming tests, and the caller's
  new and follow-up enquiries. Faculty see their batches; admins see all.
- `GET /batches/:id/gradebook`: every student (active, paused or completed enrollment) with attendance (late
  counts as present, excused is left out), each published assignment (missing, not due, submitted, late,
  reviewed + marks), each test (best graded attempt) and study materials completed.
- `GET /batches/:id/students/:userId/report`: one student's attendance by class, assignments with feedback,
  every test attempt and study material progress.
- The dashboard also lists `low_attendance`: actively enrolled students under 75% (3+ classes counted).
- `GET /reports/admin-summary` (admin): fee collections (confirmed payments minus refunds), new enrollments and
  enquiries with conversions for the last 6 months (IST), and attendance per active batch.

## Enquiry call notes

`GET/POST /admission-enquiries/:id/notes` (admins, or the faculty member the enquiry is assigned to). Notes are
kept in `enquiry_notes`, oldest first; the first note on a NEW enquiry marks it CONTACTED. Enquiry responses
include `_count.enquiry_notes`.

## Notifications

Besides announcements, the API notifies (in-app, best-effort, once per item): students when an assignment or
test is published for their batch, when their work is marked, when an invoice is issued and when a payment is
confirmed; staff when an enquiry is assigned to them. Links point at the student/faculty portal pages.
Classes: the batch is told when a future class is scheduled, moved (old and new time), cancelled or gets a
recording, and students plus the class teacher get a "Class at 5:30 pm" reminder for classes starting within the
hour. Each person gets each reminder once.

Fee invoices and payments, marked work, new assignments and tests, Scholarship Test results and announcements
are also **emailed** to recipients with an email address when `SMTP_URL` is set (`EMAIL_NOTIFICATIONS=false`
turns this off). Emails are sent in the background; a mail failure never fails the action.

## Background jobs

`@nestjs/schedule` runs two jobs every minute: sending scheduled announcements once they are due, and the
class reminders. `@nestjs/locks` with a MySQL store (`src/jobs/mysql-lock-store.ts`, table `job_locks`, checked
against the package's store contract in `test/lock-store.e2e-spec.ts`) keeps each job on one instance and stops
it overlapping itself. Both jobs are idempotent, so a missed or repeated minute is harmless. With
`JOBS_ENABLED=false` (the e2e suites) the old fallback runs instead: due work is picked up when notifications or
the announcement feed are read.

## CSV exports

Admins (branch admins: their branches) download the same data as the lists, with the same filters, as CSV
(UTF-8 with BOM for Excel, formulas neutralised, at most 20,000 rows): `GET /fee-invoices/export`,
`GET /payments/export` (payments register), `GET /admission-enquiries/export` and, for anyone who can open the
gradebook, `GET /batches/:id/gradebook/export`.

## Student portal views

Students see only their current enrollments (ACTIVE and inside the access window):

- `GET /student/courses`: current batches with teachers and study-material progress (completed / published).
- `GET /student/assignments`: published and closed assignments across all current batches, each with the
  student's submission and a `state` (MISSING, NOT_DUE, SUBMITTED, LATE, REVIEWED).
- `GET /student/courses/:courseId/materials`: the course's published chapters by subject, with published
  materials and the student's progress on each (403 without a current enrollment in the course).
- `GET /student/performance`: results per subject. Every question belongs to a subject, so a mixed test counts
  towards each subject it covers (best graded attempt per test, released results only), plus marked assignments
  that have a subject and maximum marks. Staff get the same `subjects` (including unreleased tests) in
  `GET /batches/:id/students/:userId/report`.
- After a batch ends (enrollment COMPLETED, PAUSED or past its access window) students can still read that
  batch's assignments, attachments and their own submissions and feedback; `current: false` in
  `/student/assignments` and `can_submit: false` on `GET /assignments/:id`. Handing in work, tests and study
  materials still need a current enrollment.
- Attempts include `exam.results_release_at` and `exam.answer_review_release_at` so the portal can say when
  results and the answer review open.

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
src/communications/ announcements, notifications (with email copies)
src/audit/         audit interceptor and log
src/mail/          email transport (SMTP, or logged when not configured)
src/storage/       Cloudinary storage (files and profile photos)
src/reports/       teaching dashboard, batch gradebook, student progress report
src/student/       student portal views (courses, assignments, course materials)
src/jobs/          every-minute jobs and their MySQL lock store
src/sms/           SMS sender (Twilio, MSG91, or logged)
src/branches/      branches, branch staff (branch admins, faculty), courses offered
test/              e2e suites and helpers
```

Uploaded files are stored on Cloudinary when it is configured, otherwise on local disk under `UPLOAD_DIR`
(default `./uploads`); back that folder up with the database.
