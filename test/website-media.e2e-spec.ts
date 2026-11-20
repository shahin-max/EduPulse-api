import {
  api,
  bearer,
  closeTestApp,
  createTestApp,
  createUser,
  TestContext,
} from './helpers.js';

describe('Website images (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);

  beforeAll(async () => {
    ctx = await createTestApp();
    t.admin = (await createUser(ctx, ['ADMIN'])).token;
    t.faculty = (await createUser(ctx, ['FACULTY'])).token;
  });
  afterAll(() => closeTestApp(ctx));

  it('is for admins only', async () => {
    await ctx
      .http()
      .post(api('/website-content/images'))
      .attach('image', png, 'slide.png')
      .expect(401);
    await ctx
      .http()
      .post(api('/website-content/images'))
      .set(bearer(t.faculty))
      .attach('image', png, 'slide.png')
      .expect(403);
  });

  it('needs Cloudinary (the suites run without it)', async () => {
    await ctx
      .http()
      .post(api('/website-content/images'))
      .set(bearer(t.admin))
      .attach('image', png, 'slide.png')
      .expect(503);
  });

  it('still stores JSON section content under a key', async () => {
    const body = JSON.stringify({ v: 1, items: [{ title: 'AISSEE 2027' }] });
    await ctx
      .http()
      .put(api('/website-content/home.updates'))
      .set(bearer(t.admin))
      .send({ body, isPublished: true })
      .expect(200);
    const res = await ctx
      .http()
      .get(api('/website-content?prefix=home.'))
      .expect(200);
    expect(res.body.map((b: { body: string }) => b.body)).toContain(body);
  });
});
