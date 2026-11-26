#!/usr/bin/env node
/**
 * Phase 1 end-to-end smoke test against a RUNNING EduPulse API.
 *
 *   node scripts/phase1-smoke.mjs                                    # http://localhost:$PORT/api/v1
 *   SMOKE_API_URL=http://localhost:34568/api/v1 node scripts/phase1-smoke.mjs
 *
 * - Admin credentials: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env
 *   (override with SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD).
 * - Every route called is checked against the live OpenAPI document (/docs-json); routes missing
 *   from it are listed at the end.
 * - It creates real rows (users, a batch, content, exams, fees, an enquiry) tagged "SMOKE <run id>".
 *   Run it against a development database only, with SMTP_URL, SMS_PROVIDER and Cloudinary unset
 *   so no email, SMS or upload leaves the machine. Password reset needs EXPOSE_DEV_TOKENS=true.
 * - Rate limits (10 logins/min, 120 requests/min per IP) are respected: on 429 it waits for
 *   Retry-After and retries.
 *
 * Exit code: 0 when every check passed, 1 when any check failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

// ---------------------------------------------------------------- configuration

const envPath = new URL('../.env', import.meta.url);
const dotenv = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
const API = (
  process.env.SMOKE_API_URL ?? `http://localhost:${dotenv.PORT ?? 34567}/api/v1`
).replace(/\/$/, '');
const ORIGIN = new URL(API).origin;
const PREFIX = new URL(API).pathname.replace(/\/$/, '');
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? dotenv.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? dotenv.SEED_ADMIN_PASSWORD;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const TAG = `SMOKE ${RUN}`;
const PASSWORD = `Smoke${RUN}pass1`;
const NEW_PASSWORD = `Reset${RUN}pass2`;
const SEEDED_COURSE_SLUGS = [
  'aissee-class-6', 'aissee-class-9', 'amu-entrance', 'cuet', 'nda-cds',
  'jee', 'neet', 'imu-cet', 'school-tuition',
];
const MEET_URL = `https://meet.google.com/smk-${RUN.toLowerCase().slice(0, 4)}-test`;
const RECORDING_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
/** Fake mobiles in the +91 90000xxxxx range. Nothing is texted: run with SMS_PROVIDER unset. */
const fakeMobile = () => `+9190000${String(randomInt(0, 100000)).padStart(5, '0')}`;
const email = (who) => `smoke.${RUN.toLowerCase()}.${who}@example.com`;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/** A tiny but valid one-page PDF. */
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

// ---------------------------------------------------------------- reporting

const results = [];
let section = '';
let throttled = 0;
const undocumented = new Set();
const specRoutes = new Set();

class Skip extends Error {}

const log = (line = '') => console.log(line);

function heading(name) {
  section = name;
  log(`\n== ${name} ${'='.repeat(Math.max(0, 70 - name.length))}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ section, name, status: 'PASS', detail });
    log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (error) {
    const status = error instanceof Skip ? 'SKIP' : 'FAIL';
    results.push({ section, name, status, detail: error.message });
    log(`${status}  ${name}  -> ${error.message}`);
    return false;
  }
}

/** Throws Skip when a value an earlier step should have produced is missing. */
function need(values) {
  const missing = Object.entries(values)
    .filter(([, v]) => v === undefined || v === null)
    .map(([k]) => k);
  if (missing.length) throw new Skip(`needs ${missing.join(', ')} from an earlier step`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const short = (data) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text && text.length > 300 ? `${text.slice(0, 300)}...` : text;
};

function expectStatus(res, statuses) {
  const ok = Array.isArray(statuses) ? statuses : [statuses];
  if (!ok.includes(res.status))
    throw new Error(`expected HTTP ${ok.join('/')}, got ${res.status}: ${short(res.data)}`);
  return res.data;
}

/** Lists come back as `{ data, meta }` (paginated) or plain arrays. */
const rows = (data) =>
  Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

const contains = (data, text) => JSON.stringify(data ?? '').includes(text);

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterSeconds(headers) {
  for (const [key, value] of headers) {
    if (key.toLowerCase().startsWith('retry-after')) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds + 1, 65);
    }
  }
  return 15;
}

/**
 * Calls `METHOD /template` (template as written in the OpenAPI document, without the /api/v1
 * prefix, e.g. '/exams/{id}'), with path params, query, JSON body or multipart form.
 */
async function call(method, template, { token, params = {}, query, body, form } = {}) {
  const key = `${method} ${PREFIX}${template}`;
  if (specRoutes.size && !specRoutes.has(key)) undocumented.add(key);
  const path = template.replace(/\{(\w+)\}/g, (_, name) => {
    if (params[name] === undefined || params[name] === null)
      throw new Skip(`missing path param ${name}`);
    return encodeURIComponent(String(params[name]));
  });
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  for (let attempt = 0; ; attempt += 1) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form();
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    if (res.status === 429 && attempt < 6) {
      throttled += 1;
      const wait = retryAfterSeconds(res.headers);
      log(`      .. 429 on ${method} ${template}; waiting ${wait}s (rate limit)`);
      await res.arrayBuffer();
      await sleep(wait * 1000);
      continue;
    }
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (file content, HTML) */
    }
    return { status: res.status, data };
  }
}

async function login(loginValue, password) {
  const res = await call('POST', '/auth/login', { body: { login: loginValue, password } });
  return res;
}

function pdfForm(filename) {
  return () => {
    const fd = new FormData();
    fd.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), filename);
    fd.append('visibility', 'PRIVATE');
    return fd;
  };
}

// ---------------------------------------------------------------- state

const S = {
  admin: null, faculty: null, faculty2: null, studentA: null, studentB: null, studentC: null,
  tokens: {},
  courseId: null, branchId: null, subjectId: null, subjectName: null,
  batchId: null, enrollA: null, enrollB: null,
  files: {}, chapterId: null, materials: {}, classPast: null, classUpcoming: null,
  assignmentId: null, submissionId: null, questions: [], exams: {},
  attemptA: null, attemptB: null, expectedA: null,
  feePlanId: null, invoiceId: null, paymentId: null,
  announcementTitle: `${TAG} Batch notice`,
  enquiryName: `Smoke Enquiry ${RUN}`,
};

// ---------------------------------------------------------------- run

async function main() {
  log(`EduPulse Phase 1 smoke test   run=${RUN}   api=${API}`);
  log(`Started ${new Date().toISOString()}`);

  // ------------------------------------------------------------ preflight
  heading('Preflight');

  await check('GET /health responds with status ok and database up', async () => {
    const data = expectStatus(await call('GET', '/health'), 200);
    assert(data?.status === 'ok', `status=${data?.status}`);
    return `database=${data.database}`;
  });

  await check('GET /docs (Swagger UI) responds', async () => {
    const res = await fetch(`${ORIGIN}/docs`);
    assert(res.status === 200, `HTTP ${res.status}`);
    await res.arrayBuffer();
    return 'HTTP 200';
  });

  await check('GET /docs-json (OpenAPI) loads; routes used below are validated against it', async () => {
    const res = await fetch(`${ORIGIN}/docs-json`);
    assert(res.status === 200, `HTTP ${res.status}`);
    const spec = await res.json();
    for (const [path, ops] of Object.entries(spec.paths ?? {}))
      for (const method of Object.keys(ops)) specRoutes.add(`${method.toUpperCase()} ${path}`);
    return `${Object.keys(spec.paths).length} paths, ${specRoutes.size} operations`;
  });

  await check('Admin credentials available from .env', async () => {
    assert(ADMIN_EMAIL && ADMIN_PASSWORD, 'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set');
    return ADMIN_EMAIL.replace(/^(.).*(@.*)$/, '$1***$2');
  });

  // ------------------------------------------------------------ admin setup
  heading('Admin: login and setup');

  await check('Admin login (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)', async () => {
    need({ ADMIN_EMAIL, ADMIN_PASSWORD });
    const data = expectStatus(await login(ADMIN_EMAIL, ADMIN_PASSWORD), 200);
    assert(data.accessToken, 'no accessToken');
    S.tokens.admin = data.accessToken;
    const me = expectStatus(await call('GET', '/auth/me', { token: S.tokens.admin }), 200);
    assert(contains(me, 'ADMIN'), `roles: ${short(me.roles)}`);
    S.admin = me;
    return `user id ${me.id}`;
  });

  await check('Find AISSEE Class 6 course, a subject and the branch', async () => {
    need({ admin: S.tokens.admin });
    const course = expectStatus(
      await call('GET', '/courses/{idOrSlug}', { params: { idOrSlug: 'aissee-class-6' } }),
      200,
    );
    S.courseId = Number(course.id);
    const cur = expectStatus(
      await call('GET', '/courses/{idOrSlug}/curriculum', {
        token: S.tokens.admin,
        params: { idOrSlug: S.courseId },
      }),
      200,
    );
    const subjects = cur.subjects ?? [];
    assert(subjects.length, 'AISSEE Class 6 has no subjects attached');
    const math = subjects.find((s) => s.subjects?.code === 'MATH') ?? subjects[0];
    S.subjectId = Number(math.subject_id ?? math.subjects.id);
    S.subjectName = math.subjects?.name;
    const branches = rows(
      expectStatus(await call('GET', '/branches', { token: S.tokens.admin }), 200),
    );
    const branch = branches.find((b) => b.is_active !== false) ?? branches[0];
    assert(branch, 'no branch');
    S.branchId = Number(branch.id);
    return `course ${S.courseId}, subject ${S.subjectName} (${S.subjectId}), branch ${branch.code} (${S.branchId})`;
  });

  await check('Admin creates a batch for AISSEE Class 6', async () => {
    need({ courseId: S.courseId, branchId: S.branchId });
    const data = expectStatus(
      await call('POST', '/batches', {
        token: S.tokens.admin,
        body: {
          branchId: S.branchId,
          courseId: S.courseId,
          code: `SMK-${RUN}`,
          name: `${TAG} AISSEE Class 6`,
          startDate: iso(-DAY),
          endDate: iso(180 * DAY),
          capacity: 40,
          status: 'ACTIVE',
        },
      }),
      201,
    );
    S.batchId = Number(data.id);
    return `batch ${S.batchId} SMK-${RUN}`;
  });

  const createUser = async (key, body) => {
    const data = expectStatus(
      await call('POST', '/users', { token: S.tokens.admin, body: { password: PASSWORD, ...body } }),
      201,
    );
    S[key] = { ...data, id: Number(data.id), email: body.email, mobile: body.mobile };
    return `user ${S[key].id}, status ${data.status}`;
  };

  await check('Admin creates a faculty user', async () => {
    need({ admin: S.tokens.admin });
    return createUser('faculty', {
      fullName: `${TAG} Faculty`, email: email('faculty'), roles: ['FACULTY'],
    });
  });
  await check('Admin creates a second faculty user (not assigned; for security checks)', async () => {
    need({ admin: S.tokens.admin });
    return createUser('faculty2', {
      fullName: `${TAG} Other Faculty`, email: email('faculty2'), roles: ['FACULTY'],
    });
  });
  await check('Admin creates a student with email', async () => {
    need({ admin: S.tokens.admin });
    return createUser('studentA', {
      fullName: `${TAG} Student Email`, email: email('student-a'), roles: ['STUDENT'],
    });
  });
  await check('Admin creates a student with mobile only', async () => {
    need({ admin: S.tokens.admin });
    const mobile = fakeMobile();
    const detail = await createUser('studentB', {
      fullName: `${TAG} Student Mobile`, mobile, roles: ['STUDENT'],
    });
    assert(!S.studentB.email, 'unexpected email on mobile-only student');
    return `${detail}, mobile stored as ${S.studentB.mobile ?? mobile}`;
  });
  await check('Admin creates a student who is NOT enrolled (for security checks)', async () => {
    need({ admin: S.tokens.admin });
    return createUser('studentC', {
      fullName: `${TAG} Outsider`, email: email('student-c'), roles: ['STUDENT'],
    });
  });

  await check('Admin assigns the faculty to the batch', async () => {
    need({ batchId: S.batchId, faculty: S.faculty, subjectId: S.subjectId });
    expectStatus(
      await call('POST', '/batches/{id}/faculty', {
        token: S.tokens.admin,
        params: { id: S.batchId },
        body: { facultyUserId: S.faculty.id, subjectId: S.subjectId },
      }),
      [200, 201],
    );
    return `faculty ${S.faculty.id} teaches ${S.subjectName}`;
  });

  for (const [key, enrollKey] of [['studentA', 'enrollA'], ['studentB', 'enrollB']]) {
    await check(`Admin enrols ${key === 'studentA' ? 'email' : 'mobile-only'} student in the batch`, async () => {
      need({ batchId: S.batchId, student: S[key] });
      const data = expectStatus(
        await call('POST', '/enrollments', {
          token: S.tokens.admin,
          body: { studentUserId: S[key].id, batchId: S.batchId, status: 'ACTIVE' },
        }),
        201,
      );
      S[enrollKey] = Number(data.id);
      return `enrollment ${S[enrollKey]}, status ${data.status}`;
    });
  }

  await check('Batch roster lists both enrolled students', async () => {
    need({ batchId: S.batchId, enrollA: S.enrollA, enrollB: S.enrollB });
    const data = expectStatus(
      await call('GET', '/batches/{id}/students', { token: S.tokens.admin, params: { id: S.batchId } }),
      200,
    );
    assert(contains(data, S.studentA.fullName ?? `${TAG} Student Email`), 'email student missing');
    assert(contains(data, `${TAG} Student Mobile`), 'mobile student missing');
    return `${rows(data).length || 'n/a'} on roster`;
  });

  // ------------------------------------------------------------ login methods
  heading('Login with email and with mobile');

  await check('Student logs in with EMAIL', async () => {
    need({ studentA: S.studentA });
    const data = expectStatus(await login(S.studentA.email, PASSWORD), 200);
    S.tokens.studentA = data.accessToken;
    return `user ${data.user?.id}`;
  });

  await check('Mobile-only student logs in with MOBILE (typed as 0XXXXXXXXXX)', async () => {
    need({ studentB: S.studentB });
    const digits = String(S.studentB.mobile).replace(/\D/g, '').slice(-10);
    const data = expectStatus(await login(`0${digits}`, PASSWORD), 200);
    S.tokens.studentB = data.accessToken;
    return `login "0${digits.slice(0, 2)}******${digits.slice(-2)}" -> user ${data.user?.id}`;
  });

  for (const key of ['faculty', 'faculty2', 'studentC']) {
    await check(`${key} logs in`, async () => {
      need({ user: S[key] });
      const data = expectStatus(await login(S[key].email, PASSWORD), 200);
      S.tokens[key] = data.accessToken;
      return `user ${data.user?.id}`;
    });
  }

  // ------------------------------------------------------------ faculty content
  heading('Faculty: content, classes, attendance, assignment, tests');

  const F = () => S.tokens.faculty;

  for (const [key, filename] of [
    ['note', 'smoke-notes.pdf'],
    ['worksheet', 'smoke-worksheet.pdf'],
    ['paper', 'smoke-previous-paper.pdf'],
  ]) {
    await check(`Faculty uploads PDF (${filename})`, async () => {
      need({ faculty: F() });
      const data = expectStatus(
        await call('POST', '/files', { token: F(), form: pdfForm(filename) }),
        201,
      );
      S.files[key] = Number(data.id);
      return `file ${data.id}, ${data.mime_type}, bucket ${data.bucket}`;
    });
  }

  await check('Faculty creates a published chapter', async () => {
    need({ faculty: F(), courseId: S.courseId, subjectId: S.subjectId });
    const data = expectStatus(
      await call('POST', '/chapters', {
        token: F(),
        body: {
          courseId: S.courseId, subjectId: S.subjectId,
          title: `${TAG} Fractions`, isPublished: true,
        },
      }),
      201,
    );
    S.chapterId = Number(data.id);
    return `chapter ${S.chapterId}`;
  });

  const materials = [
    ['note', 'PDF_NOTE', 'PDF note', { assetKey: 'note' }],
    ['worksheet', 'WORKSHEET', 'Worksheet', { assetKey: 'worksheet' }],
    ['paper', 'PREVIOUS_PAPER', 'Previous year paper', { assetKey: 'paper' }],
    ['video', 'VIDEO_LINK', 'YouTube video', { externalUrl: VIDEO_URL }],
  ];
  for (const [key, kind, label, source] of materials) {
    await check(`Faculty adds ${label} (${kind}) to the chapter`, async () => {
      need({ chapterId: S.chapterId, ...(source.assetKey ? { file: S.files[source.assetKey] } : {}) });
      const data = expectStatus(
        await call('POST', '/study-materials', {
          token: F(),
          body: {
            chapterId: S.chapterId,
            title: `${TAG} ${label}`,
            kind,
            ...(source.assetKey ? { assetId: S.files[source.assetKey] } : {}),
            ...(source.externalUrl ? { externalUrl: source.externalUrl } : {}),
            isPublished: true,
            isDownloadable: kind !== 'VIDEO_LINK',
          },
        }),
        201,
      );
      S.materials[key] = Number(data.id);
      return `material ${data.id}`;
    });
  }

  await check('Chapter lists the 4 materials', async () => {
    need({ chapterId: S.chapterId });
    const data = expectStatus(
      await call('GET', '/study-materials', { token: F(), query: { chapterId: S.chapterId } }),
      200,
    );
    const n = rows(data).length;
    assert(n === 4, `expected 4, got ${n}`);
    return '4 materials';
  });

  await check('Faculty schedules a live class (Meet link + recording link)', async () => {
    need({ batchId: S.batchId });
    // Started 50 minutes ago so attendance can be marked (not allowed before a class starts).
    const data = expectStatus(
      await call('POST', '/class-sessions', {
        token: F(),
        body: {
          batchId: S.batchId, subjectId: S.subjectId, title: `${TAG} Live class: Fractions`,
          startsAt: iso(-50 * MINUTE), endsAt: iso(-5 * MINUTE),
          meetingUrl: MEET_URL, recordingUrl: RECORDING_URL,
        },
      }),
      201,
    );
    S.classPast = Number(data.id);
    assert(data.meeting_url === MEET_URL, `meeting_url=${data.meeting_url}`);
    assert(data.recording_url === RECORDING_URL, `recording_url=${data.recording_url}`);
    return `class ${S.classPast}`;
  });

  await check('Faculty schedules an upcoming class (for the timetable)', async () => {
    need({ batchId: S.batchId });
    const data = expectStatus(
      await call('POST', '/class-sessions', {
        token: F(),
        body: {
          batchId: S.batchId, subjectId: S.subjectId, title: `${TAG} Live class: Decimals`,
          startsAt: iso(2 * DAY), endsAt: iso(2 * DAY + 60 * MINUTE), meetingUrl: MEET_URL,
        },
      }),
      201,
    );
    S.classUpcoming = Number(data.id);
    return `class ${S.classUpcoming}`;
  });

  await check('Faculty marks attendance (email student PRESENT, mobile student ABSENT)', async () => {
    need({ classPast: S.classPast, enrollA: S.enrollA, enrollB: S.enrollB });
    expectStatus(
      await call('PUT', '/class-sessions/{id}/attendance', {
        token: F(),
        params: { id: S.classPast },
        body: {
          entries: [
            { enrollmentId: S.enrollA, status: 'PRESENT' },
            { enrollmentId: S.enrollB, status: 'ABSENT' },
          ],
        },
      }),
      [200, 201, 204],
    );
    const data = expectStatus(
      await call('GET', '/class-sessions/{id}/attendance', { token: F(), params: { id: S.classPast } }),
      200,
    );
    assert(contains(data, 'PRESENT') && contains(data, 'ABSENT'), short(data));
    return 'saved and read back';
  });

  await check('Faculty creates a published assignment', async () => {
    need({ batchId: S.batchId });
    const data = expectStatus(
      await call('POST', '/assignments', {
        token: F(),
        body: {
          batchId: S.batchId, subjectId: S.subjectId, title: `${TAG} Assignment: Fractions`,
          instructions: 'Solve questions 1-10 of the worksheet.',
          dueAt: iso(3 * DAY), maxMarks: 10, status: 'PUBLISHED',
        },
      }),
      201,
    );
    S.assignmentId = Number(data.id);
    return `assignment ${S.assignmentId}, status ${data.status}`;
  });

  const questionDefs = [
    { text: `${TAG} What is 1/2 + 1/4?`, options: ['3/4', '2/6', '1/8', '2/4'], correct: 'A' },
    { text: `${TAG} Which is the largest: 0.5, 0.45, 0.405?`, options: ['0.45', '0.5', '0.405', 'All equal'], correct: 'B' },
  ];
  for (const [index, def] of questionDefs.entries()) {
    await check(`Faculty creates question bank entry #${index + 1}`, async () => {
      need({ courseId: S.courseId, subjectId: S.subjectId, chapterId: S.chapterId });
      const data = expectStatus(
        await call('POST', '/questions', {
          token: F(),
          body: {
            courseId: S.courseId, subjectId: S.subjectId, chapterId: S.chapterId,
            questionText: def.text, difficulty: 'EASY', marksDefault: 4,
            explanation: 'Smoke test question.',
            options: def.options.map((text, i) => ({
              optionLabel: 'ABCD'[i], optionText: text, isCorrect: 'ABCD'[i] === def.correct, sortOrder: i,
            })),
          },
        }),
        201,
      );
      S.questions.push({ id: Number(data.id), correct: def.correct });
      return `question ${data.id}`;
    });
  }

  for (const kind of ['DAILY_PRACTICE', 'MOCK_TEST', 'OMR_PRACTICE']) {
    await check(`Faculty creates ${kind} test, adds questions, attaches batch, publishes`, async () => {
      need({ batchId: S.batchId, questions: S.questions.length === 2 ? true : null });
      const exam = expectStatus(
        await call('POST', '/exams', {
          token: F(),
          body: {
            courseId: S.courseId, subjectId: S.subjectId, title: `${TAG} ${kind}`, kind,
            durationMinutes: 20, negativeMarksPerWrong: 1, maxAttempts: 1,
            showResultImmediately: true, rankingAttemptPolicy: 'BEST',
          },
        }),
        201,
      );
      const id = Number(exam.id);
      for (const q of S.questions)
        expectStatus(
          await call('POST', '/exams/{id}/questions', { token: F(), params: { id }, body: { questionId: q.id } }),
          [200, 201],
        );
      expectStatus(
        await call('PUT', '/exams/{id}/batches/{batchId}', { token: F(), params: { id, batchId: S.batchId } }),
        [200, 201, 204],
      );
      const published = expectStatus(
        await call('PATCH', '/exams/{id}', { token: F(), params: { id }, body: { status: 'PUBLISHED' } }),
        200,
      );
      assert(published.status === 'PUBLISHED', `status ${published.status}`);
      S.exams[kind] = id;
      return `exam ${id}, total marks ${published.total_marks}`;
    });
  }

  // ------------------------------------------------------------ student portal
  heading('Student portal');

  const A = () => S.tokens.studentA;

  await check('Student sees enrolled course/batch', async () => {
    need({ studentA: A(), batchId: S.batchId });
    const data = expectStatus(await call('GET', '/student/courses', { token: A() }), 200);
    assert(contains(data, `SMK-${RUN}`) || contains(data, `${TAG} AISSEE`), short(data));
    return 'batch listed';
  });

  await check('Student timetable shows both classes with the Meet link', async () => {
    need({ studentA: A(), classPast: S.classPast, classUpcoming: S.classUpcoming });
    const data = expectStatus(
      await call('GET', '/class-sessions/timetable', {
        token: A(), query: { from: iso(-DAY), to: iso(7 * DAY) },
      }),
      200,
    );
    assert(contains(data, `${TAG} Live class: Fractions`), 'past class missing');
    assert(contains(data, `${TAG} Live class: Decimals`), 'upcoming class missing');
    assert(contains(data, MEET_URL), 'meeting link missing');
    assert(contains(data, RECORDING_URL), 'recording link missing');
    return 'both classes, meet + recording links';
  });

  await check('Student sees the chapter materials (PDF, worksheet, paper, video)', async () => {
    need({ studentA: A(), courseId: S.courseId, chapter: S.chapterId });
    const data = expectStatus(
      await call('GET', '/student/courses/{courseId}/materials', { token: A(), params: { courseId: S.courseId } }),
      200,
    );
    const missing = ['PDF note', 'Worksheet', 'Previous year paper', 'YouTube video']
      .filter((label) => !contains(data, `${TAG} ${label}`));
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    assert(contains(data, VIDEO_URL), 'video URL missing');
    return 'all 4 visible';
  });

  await check('Enrolled student can open the uploaded PDF', async () => {
    need({ studentA: A(), file: S.files.note });
    const res = await call('GET', '/files/{id}/content', { token: A(), params: { id: S.files.note } });
    expectStatus(res, [200, 302]);
    return `HTTP ${res.status}`;
  });

  await check('Student sees the assignment', async () => {
    need({ studentA: A(), assignmentId: S.assignmentId });
    const data = expectStatus(await call('GET', '/student/assignments', { token: A() }), 200);
    assert(contains(data, `${TAG} Assignment`), 'assignment missing');
    return 'listed';
  });

  await check('Student submits the assignment', async () => {
    need({ studentA: A(), assignmentId: S.assignmentId });
    const data = expectStatus(
      await call('PUT', '/assignments/{id}/submission', {
        token: A(), params: { id: S.assignmentId },
        body: { responseText: 'Answers: 1) 3/4 2) 0.5 ... (smoke test)' },
      }),
      [200, 201],
    );
    S.submissionId = Number(data.id);
    assert(data.submitted_at, `no submitted_at: ${short(data)}`);
    return `submission ${S.submissionId}, late=${data.is_late}`;
  });

  await check('Student sees the 3 available tests', async () => {
    need({ studentA: A(), exams: Object.keys(S.exams).length === 3 ? true : null });
    const data = expectStatus(await call('GET', '/exams/available', { token: A() }), 200);
    const missing = Object.keys(S.exams).filter((k) => !contains(data, `${TAG} ${k}`));
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    return `${Object.keys(S.exams).join(', ')} available`;
  });

  /** Starts, answers and submits an attempt; returns { attempt, expected }. */
  async function takeTest(token, examId, answerAllCorrect) {
    const started = expectStatus(
      await call('POST', '/exams/{id}/attempts', { token, params: { id: examId }, body: { batchId: S.batchId } }),
      201,
    );
    let expected = 0;
    for (const [i, q] of started.questions.entries()) {
      const def = S.questions.find((d) => d.id === Number(q.question_id));
      // Email student: first displayed question right, second wrong. Mobile student: all right.
      const right = answerAllCorrect || i === 0;
      const option = q.options.find((o) =>
        right ? o.option_label === def.correct : o.option_label !== def.correct,
      );
      expected += right ? Number(q.marks) : -Number(q.negative_marks ?? 0);
      expectStatus(
        await call('PUT', '/exam-attempts/{id}/answers/{questionId}', {
          token, params: { id: started.id, questionId: q.question_id },
          body: { selectedOptionId: Number(option.id) },
        }),
        200,
      );
    }
    const submitted = expectStatus(
      await call('POST', '/exam-attempts/{id}/submit', { token, params: { id: started.id } }),
      [200, 201],
    );
    return { attempt: submitted.attempt ?? submitted, id: Number(started.id), expected: Math.max(expected, 0), rawExpected: expected };
  }

  await check('Student attempts and submits the DAILY_PRACTICE test; score is auto-graded', async () => {
    need({ studentA: A(), exam: S.exams.DAILY_PRACTICE });
    const { attempt, id, expected, rawExpected } = await takeTest(A(), S.exams.DAILY_PRACTICE, false);
    S.attemptA = id;
    assert(attempt.score !== undefined, `no score in submit response: ${short(attempt)}`);
    const score = Number(attempt.score);
    assert(
      score === expected || score === rawExpected,
      `score ${attempt.score}, expected ${rawExpected} (1 right, 1 wrong with negative marking)`,
    );
    S.expectedA = score;
    return `status ${attempt.status}, score ${attempt.score}/${attempt.max_score}, ${attempt.correct_count} right ${attempt.wrong_count} wrong`;
  });

  await check('Mobile-only student takes the same test (all correct) for ranking', async () => {
    need({ studentB: S.tokens.studentB, exam: S.exams.DAILY_PRACTICE });
    const { attempt, id, expected } = await takeTest(S.tokens.studentB, S.exams.DAILY_PRACTICE, true);
    S.attemptB = id;
    assert(Number(attempt.score) === expected, `score ${attempt.score}, expected ${expected}`);
    return `score ${attempt.score}/${attempt.max_score}`;
  });

  await check('Student test history lists the attempt with its score', async () => {
    need({ studentA: A(), attemptA: S.attemptA });
    const data = expectStatus(await call('GET', '/exam-attempts/me', { token: A() }), 200);
    const mine = rows(data).find((a) => Number(a.id) === S.attemptA);
    assert(mine, 'attempt missing from history');
    assert(mine.score !== undefined, 'score hidden in history');
    return `attempt ${mine.id}: ${mine.score}/${mine.max_score}`;
  });

  await check('Student sees leaderboard and rank', async () => {
    need({ studentA: A(), exam: S.exams.DAILY_PRACTICE, attemptB: S.attemptB });
    const data = expectStatus(
      await call('GET', '/exams/{id}/leaderboard', {
        token: A(), params: { id: S.exams.DAILY_PRACTICE }, query: { batchId: S.batchId },
      }),
      200,
    );
    const entries = data.entries ?? rows(data);
    const a = entries.find((e) => e.full_name === `${TAG} Student Email`);
    const b = entries.find((e) => e.full_name === `${TAG} Student Mobile`);
    assert(a && b, `entries: ${short(entries)}`);
    assert(Number(b.rank) < Number(a.rank), `ranks: mobile ${b.rank}, email ${a.rank}`);
    return `email student rank ${a.rank}, mobile student rank ${b.rank} of ${entries.length}`;
  });

  await check('Student sees own attendance', async () => {
    need({ studentA: A(), classPast: S.classPast });
    const data = expectStatus(await call('GET', '/attendance/me', { token: A() }), 200);
    assert(contains(data, 'PRESENT'), short(data));
    return 'PRESENT recorded';
  });

  await check('Student sees subject-wise performance', async () => {
    need({ studentA: A(), attemptA: S.attemptA });
    const data = expectStatus(await call('GET', '/student/performance', { token: A() }), 200);
    const subjects = Array.isArray(data) ? data : (data.subjects ?? []);
    const row = subjects.find((s) => Number(s.subject?.id) === S.subjectId);
    assert(row, `no row for subject ${S.subjectId}: ${short(data)}`);
    assert(
      Number(row.tests?.score) === S.expectedA && Number(row.tests?.max) === 8,
      `tests ${row.tests?.score}/${row.tests?.max}, expected ${S.expectedA}/8`,
    );
    return `${row.subject.name}: tests ${row.tests.score}/${row.tests.max} (${row.tests.percentage}%)`;
  });

  await check('Student fee status endpoint works (before invoicing)', async () => {
    need({ studentA: A() });
    const data = expectStatus(await call('GET', '/fee-invoices/me', { token: A() }), 200);
    return `${rows(data).length} invoice(s)`;
  });

  await check('Student notifications include new assignment/test notices', async () => {
    need({ studentA: A() });
    const data = expectStatus(await call('GET', '/notifications', { token: A() }), 200);
    const n = rows(data).length;
    assert(n > 0, 'no notifications');
    assert(contains(data, TAG), 'no notification about the smoke assignment/tests');
    return `${n} notification(s)`;
  });

  // ------------------------------------------------------------ review
  heading('Faculty review of the assignment');

  await check('Faculty reviews the submission with marks + feedback', async () => {
    need({ assignmentId: S.assignmentId });
    const subs = expectStatus(
      await call('GET', '/assignments/{id}/submissions', { token: F(), params: { id: S.assignmentId } }),
      200,
    );
    const sub = rows(subs).find((s) => contains(s, `${TAG} Student Email`)) ?? rows(subs)[0];
    assert(sub, 'no submissions listed');
    S.submissionId = Number(sub.id ?? S.submissionId);
    const data = expectStatus(
      await call('PATCH', '/assignment-submissions/{id}/review', {
        token: F(), params: { id: S.submissionId },
        body: { marksAwarded: 8, feedback: 'Good work - check Q7 again.' },
      }),
      200,
    );
    assert(Number(data.marks_awarded) === 8 && data.reviewed_at, `marks ${data.marks_awarded}, reviewed_at ${data.reviewed_at}`);
    return `marks ${data.marks_awarded}, reviewed`;
  });

  await check('Student sees marks and feedback', async () => {
    need({ studentA: A(), assignmentId: S.assignmentId });
    const data = expectStatus(
      await call('GET', '/assignments/{id}/submission', { token: A(), params: { id: S.assignmentId } }),
      200,
    );
    assert(Number(data.marks_awarded) === 8, `marks ${data.marks_awarded}`);
    assert(String(data.feedback).includes('check Q7'), `feedback ${data.feedback}`);
    const list = expectStatus(await call('GET', '/student/assignments', { token: A() }), 200);
    const row = rows(list).find((a) => Number(a.id) === S.assignmentId);
    assert(row?.state === 'REVIEWED', `assignment state ${row?.state}`);
    return `marks ${data.marks_awarded}, feedback shown, state ${row.state}`;
  });

  // ------------------------------------------------------------ fees
  heading('Admin: fees');

  await check('Admin creates a fee plan', async () => {
    need({ batchId: S.batchId });
    const data = expectStatus(
      await call('POST', '/fee-plans', {
        token: S.tokens.admin,
        body: {
          courseId: S.courseId, branchId: S.branchId, batchId: S.batchId,
          title: `${TAG} Fee plan`, amount: '12000.00',
        },
      }),
      201,
    );
    S.feePlanId = Number(data.id);
    return `plan ${S.feePlanId}, amount ${data.amount}`;
  });

  await check('Admin creates an invoice (draft) for the email student', async () => {
    need({ feePlanId: S.feePlanId, enrollA: S.enrollA });
    const data = expectStatus(
      await call('POST', '/fee-invoices', {
        token: S.tokens.admin,
        body: {
          enrollmentId: S.enrollA, feePlanId: S.feePlanId,
          description: `${TAG} Term 1 fee`, dueDate: iso(15 * DAY),
        },
      }),
      201,
    );
    S.invoiceId = Number(data.id);
    return `invoice ${S.invoiceId}, ${data.invoice_number}, status ${data.status}, net ${data.net_amount ?? data.gross_amount}`;
  });

  await check('Admin issues the invoice (gets a real number)', async () => {
    need({ invoiceId: S.invoiceId });
    const data = expectStatus(
      await call('POST', '/fee-invoices/{id}/issue', { token: S.tokens.admin, params: { id: S.invoiceId } }),
      [200, 201],
    );
    assert(data.status === 'ISSUED', `status ${data.status}`);
    assert(data.invoice_number && !String(data.invoice_number).startsWith('DRAFT'), `number ${data.invoice_number}`);
    return `${data.invoice_number}`;
  });

  await check('Student sees the issued invoice as unpaid', async () => {
    need({ studentA: A(), invoiceId: S.invoiceId });
    const data = expectStatus(await call('GET', '/fee-invoices/me', { token: A() }), 200);
    const inv = rows(data).find((i) => Number(i.id) === S.invoiceId);
    assert(inv, 'invoice missing');
    assert(inv.status === 'ISSUED', `status ${inv.status}`);
    return `status ${inv.status}`;
  });

  await check('Admin records a UPI payment (confirmed)', async () => {
    need({ invoiceId: S.invoiceId });
    const data = expectStatus(
      await call('POST', '/fee-invoices/{id}/payments', {
        token: S.tokens.admin, params: { id: S.invoiceId },
        body: {
          amount: '12000.00', method: 'UPI', idempotencyKey: randomUUID(), status: 'CONFIRMED',
          externalReference: `UPI${RUN}0001`, notes: `${TAG} payment`,
        },
      }),
      201,
    );
    const payment = data.payment ?? data;
    S.paymentId = Number(payment.id);
    return `payment ${S.paymentId}, status ${payment.status}`;
  });

  await check('Admin gets the payment receipt (receipt number)', async () => {
    need({ paymentId: S.paymentId });
    const data = expectStatus(
      await call('GET', '/payments/{id}', { token: S.tokens.admin, params: { id: S.paymentId } }),
      200,
    );
    assert(data.receipt_number, `no receipt_number: ${short(data)}`);
    return `receipt ${data.receipt_number}, ${data.method} ${data.amount}`;
  });

  await check('Student sees the updated fee status (PAID)', async () => {
    need({ studentA: A(), invoiceId: S.invoiceId, paymentId: S.paymentId });
    const data = expectStatus(await call('GET', '/fee-invoices/me', { token: A() }), 200);
    const inv = rows(data).find((i) => Number(i.id) === S.invoiceId);
    assert(inv?.status === 'PAID', `status ${inv?.status}`);
    return `status ${inv.status}`;
  });

  // ------------------------------------------------------------ announcements
  heading('Admin: announcements');

  await check('Admin publishes an announcement to the batch', async () => {
    need({ batchId: S.batchId });
    const data = expectStatus(
      await call('POST', '/announcements', {
        token: S.tokens.admin,
        body: {
          title: S.announcementTitle, body: 'Class test on Friday. (smoke test)',
          audience: 'BATCH', batchId: S.batchId, publish: true,
        },
      }),
      201,
    );
    assert(data.status === 'PUBLISHED', `status ${data.status}`);
    return `announcement ${data.id}`;
  });

  await check('Student sees the announcement in the feed', async () => {
    need({ studentA: A() });
    const data = expectStatus(await call('GET', '/announcements/feed', { token: A() }), 200);
    assert(contains(data, S.announcementTitle), 'not in feed');
    return 'in feed';
  });

  await check('Student receives an in-app notification for it', async () => {
    need({ studentA: A() });
    const data = expectStatus(await call('GET', '/notifications', { token: A() }), 200);
    assert(contains(data, S.announcementTitle), 'not in notifications');
    const kinds = ['Assignment', 'DAILY_PRACTICE', 'invoice', 'Fee', 'payment', 'mark']
      .filter((k) => JSON.stringify(data).toLowerCase().includes(k.toLowerCase()));
    return `${rows(data).length} notifications; mentions: ${kinds.join(', ') || 'n/a'}`;
  });

  // ------------------------------------------------------------ reports
  heading('Admin reports');

  await check('Admin summary report', async () => {
    const data = expectStatus(await call('GET', '/reports/admin-summary', { token: S.tokens.admin }), 200);
    return `keys: ${Object.keys(data).join(', ')}`;
  });

  await check('Batch gradebook includes both students, the assignment and the test', async () => {
    need({ batchId: S.batchId });
    const data = expectStatus(
      await call('GET', '/batches/{id}/gradebook', { token: S.tokens.admin, params: { id: S.batchId } }),
      200,
    );
    for (const text of [`${TAG} Student Email`, `${TAG} Student Mobile`, `${TAG} Assignment`, `${TAG} DAILY_PRACTICE`])
      assert(contains(data, text), `missing ${text}`);
    return 'students, assignment and tests present';
  });

  await check('Student progress report', async () => {
    need({ batchId: S.batchId, studentA: S.studentA });
    const data = expectStatus(
      await call('GET', '/batches/{id}/students/{userId}/report', {
        token: S.tokens.admin, params: { id: S.batchId, userId: S.studentA.id },
      }),
      200,
    );
    assert(contains(data, `${TAG} Assignment`), 'assignment missing');
    return `keys: ${Object.keys(data).join(', ')}`;
  });

  // ------------------------------------------------------------ security
  heading('Security');

  const C = () => S.tokens.studentC;
  const denied = (name, request, statuses = [403, 404]) =>
    check(name, async () => {
      const res = await request();
      expectStatus(res, statuses);
      return `HTTP ${res.status}`;
    });

  // Not-enrolled student
  await denied('Not-enrolled student: course materials', () =>
    call('GET', '/student/courses/{courseId}/materials', { token: C(), params: { courseId: S.courseId } }));
  await denied('Not-enrolled student: single study material', () =>
    call('GET', '/study-materials/{id}', { token: C(), params: { id: S.materials.note } }));
  await denied('Not-enrolled student: PDF file content', () =>
    call('GET', '/files/{id}/content', { token: C(), params: { id: S.files.note } }));
  await denied('Not-enrolled student: batch classes list', () =>
    call('GET', '/class-sessions', { token: C(), query: { batchId: S.batchId } }));
  await denied('Not-enrolled student: single class (Meet link)', () =>
    call('GET', '/class-sessions/{id}', { token: C(), params: { id: S.classPast } }));
  await denied('Not-enrolled student: test details', () =>
    call('GET', '/exams/{id}', { token: C(), params: { id: S.exams.MOCK_TEST } }));
  await denied('Not-enrolled student: start a test attempt', () =>
    call('POST', '/exams/{id}/attempts', { token: C(), params: { id: S.exams.MOCK_TEST }, body: {} }));
  await denied('Not-enrolled student: leaderboard', () =>
    call('GET', '/exams/{id}/leaderboard', { token: C(), params: { id: S.exams.DAILY_PRACTICE }, query: { batchId: S.batchId } }));
  await denied('Not-enrolled student: assignment', () =>
    call('GET', '/assignments/{id}', { token: C(), params: { id: S.assignmentId } }));
  await check('Not-enrolled student: timetable does not leak the batch classes', async () => {
    const data = expectStatus(
      await call('GET', '/class-sessions/timetable', { token: C(), query: { from: iso(-DAY), to: iso(7 * DAY) } }),
      200,
    );
    assert(!contains(data, TAG), 'smoke classes visible to outsider');
    return 'no smoke classes listed';
  });

  // Student calling admin / faculty endpoints
  await denied('Student -> admin: list users', () => call('GET', '/users', { token: A() }), [403]);
  await denied('Student -> admin: create user', () =>
    call('POST', '/users', { token: A(), body: { fullName: 'x', email: email('evil'), roles: ['ADMIN'], password: PASSWORD } }), [403]);
  await denied('Student -> admin: create batch', () =>
    call('POST', '/batches', { token: A(), body: { branchId: S.branchId, courseId: S.courseId, code: `X-${RUN}`, name: 'x' } }), [403]);
  await denied('Student -> admin: admin summary', () => call('GET', '/reports/admin-summary', { token: A() }), [403]);
  await denied('Student -> admin: record payment', () =>
    call('POST', '/fee-invoices/{id}/payments', { token: A(), params: { id: S.invoiceId }, body: { amount: '1.00', method: 'UPI', idempotencyKey: randomUUID() } }), [403]);
  await denied('Student -> faculty: add study material', () =>
    call('POST', '/study-materials', { token: A(), body: { chapterId: S.chapterId, title: 'x', kind: 'VIDEO_LINK', externalUrl: VIDEO_URL } }), [403]);
  await denied('Student -> faculty: schedule class', () =>
    call('POST', '/class-sessions', { token: A(), body: { batchId: S.batchId, title: 'x', startsAt: iso(DAY), endsAt: iso(DAY + MINUTE) } }), [403]);
  await denied('Student -> faculty: mark attendance', () =>
    call('PUT', '/class-sessions/{id}/attendance', { token: A(), params: { id: S.classPast }, body: { entries: [{ enrollmentId: S.enrollA, status: 'PRESENT' }] } }), [403]);
  await denied('Student -> faculty: create exam', () =>
    call('POST', '/exams', { token: A(), body: { courseId: S.courseId, title: 'x', kind: 'MOCK_TEST', durationMinutes: 10 } }), [403]);
  await denied('Student -> faculty: review submission', () =>
    call('PATCH', '/assignment-submissions/{id}/review', { token: A(), params: { id: S.submissionId }, body: { marksAwarded: 10 } }), [403]);
  await denied('Student -> faculty: batch gradebook', () =>
    call('GET', '/batches/{id}/gradebook', { token: A(), params: { id: S.batchId } }), [403]);

  // Faculty not assigned to the batch
  const F2 = () => S.tokens.faculty2;
  await denied('Unassigned faculty: schedule class in the batch', () =>
    call('POST', '/class-sessions', { token: F2(), body: { batchId: S.batchId, title: `${TAG} intruder`, startsAt: iso(DAY), endsAt: iso(DAY + 30 * MINUTE) } }));
  await denied('Unassigned faculty: mark attendance', () =>
    call('PUT', '/class-sessions/{id}/attendance', { token: F2(), params: { id: S.classPast }, body: { entries: [{ enrollmentId: S.enrollB, status: 'PRESENT' }] } }));
  await denied('Unassigned faculty: create assignment in the batch', () =>
    call('POST', '/assignments', { token: F2(), body: { batchId: S.batchId, title: `${TAG} intruder`, status: 'DRAFT' } }));
  await denied('Unassigned faculty: list submissions', () =>
    call('GET', '/assignments/{id}/submissions', { token: F2(), params: { id: S.assignmentId } }));
  await denied('Unassigned faculty: review submission', () =>
    call('PATCH', '/assignment-submissions/{id}/review', { token: F2(), params: { id: S.submissionId }, body: { marksAwarded: 0 } }));
  await denied('Unassigned faculty: edit the batch test', () =>
    call('PATCH', '/exams/{id}', { token: F2(), params: { id: S.exams.MOCK_TEST }, body: { title: `${TAG} hijacked` } }));
  await denied('Unassigned faculty: batch gradebook', () =>
    call('GET', '/batches/{id}/gradebook', { token: F2(), params: { id: S.batchId } }));
  await denied('Unassigned faculty: student report', () =>
    call('GET', '/batches/{id}/students/{userId}/report', { token: F2(), params: { id: S.batchId, userId: S.studentA?.id } }));
  await denied('Unassigned faculty: assign self to the batch', () =>
    call('POST', '/batches/{id}/faculty', { token: F2(), params: { id: S.batchId }, body: { facultyUserId: S.faculty2?.id, subjectId: S.subjectId } }));

  // No token at all
  const portalRoutes = [
    ['GET', '/auth/me', {}],
    ['GET', '/student/courses', {}],
    ['GET', '/class-sessions/timetable', {}],
    ['GET', '/student/assignments', {}],
    ['GET', '/exams/available', {}],
    ['GET', '/exam-attempts/me', {}],
    ['GET', '/attendance/me', {}],
    ['GET', '/fee-invoices/me', {}],
    ['GET', '/notifications', {}],
    ['GET', '/announcements/feed', {}],
    ['GET', '/users', {}],
    ['GET', '/files/{id}/content', { params: { id: S.files.note } }],
    ['GET', '/batches/{id}/gradebook', { params: { id: S.batchId } }],
  ];
  for (const [method, template, opts] of portalRoutes)
    await denied(`No token: ${method} ${template} -> 401`, () => call(method, template, opts), [401]);

  // ------------------------------------------------------------ public
  heading('Public website');

  await check('Published courses list includes all 9 seeded courses', async () => {
    const data = expectStatus(await call('GET', '/courses'), 200);
    const slugs = new Set(rows(data).map((c) => c.slug));
    const missing = SEEDED_COURSE_SLUGS.filter((s) => !slugs.has(s));
    assert(!missing.length, `${9 - missing.length}/9 published; not in public list: ${missing.join(', ')}`);
    return `${slugs.size} published`;
  });

  await check('Public course page data for aissee-class-6', async () => {
    const data = expectStatus(await call('GET', '/courses/{idOrSlug}', { params: { idOrSlug: 'aissee-class-6' } }), 200);
    return data.title;
  });

  await check('Public enquiry form submission is accepted', async () => {
    const data = expectStatus(
      await call('POST', '/admission-enquiries', {
        body: {
          studentName: S.enquiryName, mobile: fakeMobile(), email: email('enquiry'),
          interestedCourseId: S.courseId ?? undefined,
          message: 'Interested in AISSEE Class 6 (smoke test).', source: 'WEBSITE',
        },
      }),
      [200, 201],
    );
    return `enquiry ${data.id ?? 'accepted'}`;
  });

  await check('Admin sees the enquiry', async () => {
    need({ admin: S.tokens.admin });
    const data = expectStatus(
      await call('GET', '/admission-enquiries', { token: S.tokens.admin, query: { search: S.enquiryName } }),
      200,
    );
    assert(contains(data, S.enquiryName), 'enquiry not listed');
    const row = rows(data).find((e) => e.student_name === S.enquiryName);
    return `status ${row?.status}, branch ${row?.branch_id ?? 'unrouted'}`;
  });

  // ------------------------------------------------------------ password reset (last: it ends sessions)
  heading('Password reset');

  let devToken;
  await check('Forgot password returns a dev token', async () => {
    need({ studentA: S.studentA });
    const data = expectStatus(
      await call('POST', '/auth/password/forgot', { body: { login: S.studentA.email } }),
      [200, 202],
    );
    devToken = data.devToken;
    assert(devToken, `no devToken (is EXPOSE_DEV_TOKENS=true?): ${short(data)}`);
    return 'devToken received';
  });

  await check('Reset password with the token', async () => {
    need({ devToken });
    expectStatus(
      await call('POST', '/auth/password/reset', { body: { token: devToken, newPassword: NEW_PASSWORD } }),
      [200, 204],
    );
    return 'password changed';
  });

  await check('Old password no longer works', async () => {
    need({ devToken });
    const res = await login(S.studentA.email, PASSWORD);
    expectStatus(res, [401]);
    return 'HTTP 401';
  });

  await check('New password works', async () => {
    need({ devToken });
    const data = expectStatus(await login(S.studentA.email, NEW_PASSWORD), 200);
    assert(data.accessToken, 'no token');
    return 'logged in';
  });

  await check('Reset token is single-use', async () => {
    need({ devToken });
    const res = await call('POST', '/auth/password/reset', { body: { token: devToken, newPassword: `Again${RUN}pass3` } });
    expectStatus(res, [400, 401, 403, 404, 410]);
    return `HTTP ${res.status}`;
  });

  // ------------------------------------------------------------ summary
  summary();
}

function summary() {
  const count = (s) => results.filter((r) => r.status === s).length;
  log(`\n${'='.repeat(74)}`);
  log(`SUMMARY  run=${RUN}   PASS ${count('PASS')}   FAIL ${count('FAIL')}   SKIP ${count('SKIP')}   (429 waits: ${throttled})`);
  log('='.repeat(74));
  const sections = [...new Set(results.map((r) => r.section))];
  for (const name of sections) {
    const rs = results.filter((r) => r.section === name);
    const bad = rs.filter((r) => r.status !== 'PASS');
    log(`${bad.length ? 'XX' : 'OK'}  ${name.padEnd(48)} ${rs.length - bad.length}/${rs.length} pass`);
    for (const r of bad) log(`      ${r.status}  ${r.name}  -> ${r.detail}`);
  }
  if (undocumented.size) {
    log('\nRoutes called that are NOT in /docs-json:');
    for (const r of undocumented) log(`  - ${r}`);
  } else if (specRoutes.size) {
    log('\nEvery route called is documented in /docs-json.');
  }
  log(`\nCreated data is tagged "${TAG}" / batch SMK-${RUN} / emails smoke.${RUN.toLowerCase()}.*@example.com`);
  process.exitCode = count('FAIL') ? 1 : 0;
}

main().catch((error) => {
  log(`\nFATAL: ${error.stack ?? error}`);
  summary();
  process.exitCode = 1;
});
