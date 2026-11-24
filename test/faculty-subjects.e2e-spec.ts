import {
  api,
  bearer,
  closeTestApp,
  createTestApp,
  createUser,
  TestContext,
} from './helpers.js';

describe('Faculty website subjects (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  let facultyId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    t.admin = (await createUser(ctx, ['ADMIN'])).token;
    const faculty = await createUser(ctx, ['FACULTY']);
    t.faculty = faculty.token;
    facultyId = faculty.id;
  });
  afterAll(() => closeTestApp(ctx));

  const publicEntry = async () => {
    const res = await ctx.http().get(api('/faculty')).expect(200);
    return (res.body as { user_id: number; display_subjects: unknown }[]).find(
      (f) => f.user_id === facultyId,
    );
  };

  it('lets an admin set the chips, trimmed and in order, and shows them publicly', async () => {
    await ctx
      .http()
      .patch(api(`/faculty/${facultyId}`))
      .set(bearer(t.admin))
      .send({ subjects: [' Physics ', 'JEE Main'] })
      .expect(200);
    expect((await publicEntry())?.display_subjects).toEqual([
      'Physics',
      'JEE Main',
    ]);
  });

  it('clears them with an empty list', async () => {
    await ctx
      .http()
      .patch(api(`/faculty/${facultyId}`))
      .set(bearer(t.admin))
      .send({ subjects: [] })
      .expect(200);
    expect((await publicEntry())?.display_subjects).toBeNull();
  });

  it('refuses blank, duplicate, too long or too many subjects', async () => {
    for (const subjects of [
      [''],
      ['Physics', 'physics'],
      ['x'.repeat(41)],
      Array.from({ length: 9 }, (_, i) => `S${i}`),
    ])
      await ctx
        .http()
        .patch(api(`/faculty/${facultyId}`))
        .set(bearer(t.admin))
        .send({ subjects })
        .expect(400);
  });

  it('lets teachers set their own chips', async () => {
    await ctx
      .http()
      .patch(api('/faculty/me'))
      .set(bearer(t.faculty))
      .send({ subjects: ['Chemistry', 'NEET'] })
      .expect(200);
    expect((await publicEntry())?.display_subjects).toEqual([
      'Chemistry',
      'NEET',
    ]);
    await ctx
      .http()
      .patch(api('/faculty/me'))
      .set(bearer(t.faculty))
      .send({ subjects: ['Chemistry', 'chemistry'] })
      .expect(400);
  });
});
