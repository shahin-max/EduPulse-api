// Before the app module (and its ConfigModule) is imported, which happens at import time.
const before = vi.hoisted(() => {
  const value = process.env.PORTALS_OPEN;
  process.env.PORTALS_OPEN = 'admin';
  return value;
});

import {
  api,
  bearer,
  closeTestApp,
  createTestApp,
  createUser,
  TestContext,
} from './helpers.js';

describe('Staged launch: PORTALS_OPEN=admin (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    t.admin = (await createUser(ctx, ['ADMIN'])).token;
    t.adminTeacher = (await createUser(ctx, ['ADMIN', 'FACULTY'])).token;
    t.faculty = (await createUser(ctx, ['FACULTY'])).token;
    t.student = (await createUser(ctx, ['STUDENT'])).token;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    if (before === undefined) delete process.env.PORTALS_OPEN;
    else process.env.PORTALS_OPEN = before;
  });

  it('tells the website which portals are open', async () => {
    const res = await ctx.http().get(api('/portals')).expect(200);
    expect(res.body).toEqual({ open: 'admin' });
  });

  it('keeps the admin portal fully open, including for admins who also teach', async () => {
    for (const token of [t.admin, t.adminTeacher]) {
      await ctx.http().get(api('/questions')).set(bearer(token)).expect(200);
      await ctx.http().get(api('/users')).set(bearer(token)).expect(200);
    }
  });

  it('lets faculty and students sign in but closes their portal routes', async () => {
    for (const [token, path] of [
      [t.faculty, '/questions'],
      [t.student, '/exams/available'],
    ]) {
      const me = await ctx.http().get(api('/auth/me')).set(bearer(token));
      expect(me.status).toBe(200);
      const res = await ctx.http().get(api(path)).set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PORTAL_CLOSED');
    }
  });

  it('treats faculty and students as visitors on public routes, so private files stay closed', async () => {
    const admin = await ctx.http().get(api('/auth/me')).set(bearer(t.admin));
    const file = await ctx.prisma.file_assets.create({
      data: {
        bucket: 'local',
        object_key: '2026/11/portal-check.pdf',
        original_filename: 'submission.pdf',
        mime_type: 'application/pdf',
        size_bytes: 10n,
        visibility: 'PRIVATE',
        uploaded_by: BigInt(admin.body.id),
      },
    });
    const path = api(`/files/${file.id}`);
    await ctx.http().get(path).set(bearer(t.admin)).expect(200);
    await ctx.http().get(path).set(bearer(t.faculty)).expect(401);
    await ctx.http().get(path).set(bearer(t.student)).expect(401);
  });

  it('keeps the public website open to signed-in faculty and students', async () => {
    await ctx.http().get(api('/courses')).set(bearer(t.student)).expect(200);
    await ctx.http().get(api('/courses')).set(bearer(t.faculty)).expect(200);
  });
});
