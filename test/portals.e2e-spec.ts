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
  const before = process.env.PORTALS_OPEN;

  beforeAll(async () => {
    process.env.PORTALS_OPEN = 'admin';
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

  it('keeps the public website open to signed-in faculty and students', async () => {
    await ctx.http().get(api('/courses')).set(bearer(t.student)).expect(200);
    await ctx.http().get(api('/courses')).set(bearer(t.faculty)).expect(200);
  });
});
