import { AnnouncementsService } from '../src/communications/announcements.service.js';
import {
  api,
  bearer,
  closeTestApp,
  createCourseWithBatch,
  createTestApp,
  createUser,
  enrol,
  TestContext,
} from './helpers.js';

describe('Announcements & notifications (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const other = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      student: student.token,
      other: other.token,
    });
    Object.assign(ids, { student: student.id, other: other.id });
    const mine = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    const foreign = await createCourseWithBatch(ctx);
    Object.assign(ids, { batch: mine.batchId, foreignBatch: foreign.batchId });
    await enrol(ctx, student.id, mine.batchId);
  });

  afterAll(() => closeTestApp(ctx));

  const http = () => ctx.http();
  const notificationsOf = async (who: string) =>
    (await http().get(api('/notifications')).set(bearer(t[who])).expect(200))
      .body;

  it('publishes a school-wide announcement and notifies everyone but the author', async () => {
    const res = await http()
      .post(api('/announcements'))
      .set(bearer(t.admin))
      .send({
        title: 'Holiday on Friday',
        body: 'The academy is closed this Friday.',
        audience: 'ALL',
        publish: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'PUBLISHED',
      audience: 'ALL',
      batch_id: null,
    });
    ids.all = res.body.id;

    expect((await notificationsOf('admin')).data).toHaveLength(0);
    for (const who of ['student', 'other', 'faculty']) {
      const list = await notificationsOf(who);
      expect(list.data).toHaveLength(1);
      expect(list.data[0]).toMatchObject({
        title: 'Holiday on Friday',
        link_url: `/announcements/${ids.all}`,
        read_at: null,
      });
      expect(list.meta.unread).toBe(1);
    }
  });

  it('lets faculty post only to batches they teach', async () => {
    const base = {
      title: 'Test on Monday',
      body: 'Chapter 3 test.',
      audience: 'BATCH',
      publish: true,
    };
    await http()
      .post(api('/announcements'))
      .set(bearer(t.faculty))
      .send({ ...base, audience: 'ALL' })
      .expect(403);
    await http()
      .post(api('/announcements'))
      .set(bearer(t.faculty))
      .send({ ...base, batchId: ids.foreignBatch })
      .expect(403);
    await http()
      .post(api('/announcements'))
      .set(bearer(t.faculty))
      .send(base)
      .expect(400);
    await http()
      .post(api('/announcements'))
      .set(bearer(t.admin))
      .send({ ...base, audience: 'STUDENTS', batchId: ids.batch })
      .expect(400);
    await http()
      .post(api('/announcements'))
      .set(bearer(t.student))
      .send({ ...base, batchId: ids.batch })
      .expect(403);

    const res = await http()
      .post(api('/announcements'))
      .set(bearer(t.faculty))
      .send({ ...base, batchId: ids.batch })
      .expect(201);
    ids.batchAnn = res.body.id;
    expect((await notificationsOf('student')).meta.unread).toBe(2);
    expect((await notificationsOf('other')).meta.unread).toBe(1);
  });

  it('builds each user’s feed from role and batch', async () => {
    const student = await http()
      .get(api('/announcements/feed'))
      .set(bearer(t.student))
      .expect(200);
    expect(
      student.body.data
        .map((a: { id: number }) => a.id)
        .sort((a: number, b: number) => a - b),
    ).toEqual([ids.all, ids.batchAnn].sort((a, b) => a - b));
    const other = await http()
      .get(api('/announcements/feed'))
      .set(bearer(t.other))
      .expect(200);
    expect(other.body.data.map((a: { id: number }) => a.id)).toEqual([ids.all]);
    await http()
      .get(api(`/announcements/${ids.batchAnn}`))
      .set(bearer(t.other))
      .expect(404);
    await http()
      .get(api(`/announcements/${ids.batchAnn}`))
      .set(bearer(t.student))
      .expect(200);
  });

  it('keeps drafts private to their author and admins', async () => {
    const draft = await http()
      .post(api('/announcements'))
      .set(bearer(t.admin))
      .send({ title: 'Fee revision', body: 'Draft text', audience: 'STUDENTS' })
      .expect(201);
    expect(draft.body.status).toBe('DRAFT');
    await http()
      .get(api(`/announcements/${draft.body.id}`))
      .set(bearer(t.student))
      .expect(404);
    expect((await notificationsOf('student')).meta.unread).toBe(2);

    const managed = await http()
      .get(api('/announcements'))
      .set(bearer(t.faculty))
      .expect(200);
    expect(managed.body.data.map((a: { id: number }) => a.id)).toEqual([
      ids.batchAnn,
    ]);
    await http().get(api('/announcements')).set(bearer(t.student)).expect(403);
  });

  it('holds scheduled announcements back until they are due', async () => {
    const res = await http()
      .post(api('/announcements'))
      .set(bearer(t.admin))
      .send({
        title: 'Results next week',
        body: 'Stay tuned.',
        audience: 'STUDENTS',
        publishAt: new Date(Date.now() + 3600_000).toISOString(),
        publish: true,
      })
      .expect(201);
    ids.scheduled = res.body.id;
    const feed = await http()
      .get(api('/announcements/feed'))
      .set(bearer(t.student))
      .expect(200);
    expect(feed.body.data.map((a: { id: number }) => a.id)).not.toContain(
      ids.scheduled,
    );
    expect((await notificationsOf('student')).meta.unread).toBe(2);

    // Time passes...
    await ctx.prisma.announcements.update({
      where: { id: BigInt(ids.scheduled) },
      data: { publish_at: new Date(Date.now() - 1000) },
    });
    const service = ctx.app.get(AnnouncementsService);
    expect(await service.dispatchDue()).toBe(2); // the two students
    expect(await service.dispatchDue()).toBe(0); // idempotent
    expect((await notificationsOf('student')).meta.unread).toBe(3);
    expect((await notificationsOf('faculty')).meta.unread).toBe(1);
  });

  it('marks notifications read', async () => {
    const list = await notificationsOf('student');
    const first = list.data[0].id;
    const read = await http()
      .patch(api(`/notifications/${first}/read`))
      .set(bearer(t.student))
      .expect(200);
    expect(read.body.read_at).not.toBeNull();
    await http()
      .patch(api(`/notifications/${first}/read`))
      .set(bearer(t.other))
      .expect(404);

    const unread = await http()
      .get(api('/notifications?unread=true'))
      .set(bearer(t.student))
      .expect(200);
    expect(unread.body.meta).toMatchObject({ total: 2, unread: 2 });

    const all = await http()
      .post(api('/notifications/read-all'))
      .set(bearer(t.student))
      .expect(201);
    expect(all.body).toEqual({ updated: 2 });
    expect((await notificationsOf('student')).meta.unread).toBe(0);
  });

  it('archives announcements out of the feed and lets admins notify users directly', async () => {
    await http()
      .post(api(`/announcements/${ids.all}/archive`))
      .set(bearer(t.admin))
      .expect(201);
    const feed = await http()
      .get(api('/announcements/feed'))
      .set(bearer(t.other))
      .expect(200);
    const visible = feed.body.data.map((a: { id: number }) => a.id);
    expect(visible).not.toContain(ids.all);
    expect(visible).toContain(ids.scheduled);

    const sent = await http()
      .post(api('/notifications'))
      .set(bearer(t.admin))
      .send({
        userIds: [ids.other],
        title: 'Please visit the office',
        message: 'Bring your ID card.',
      })
      .expect(201);
    expect(sent.body).toEqual({ created: 1 });
    await http()
      .post(api('/notifications'))
      .set(bearer(t.faculty))
      .send({ userIds: [ids.other], title: 'Hi', message: 'x' })
      .expect(403);
  });
});
