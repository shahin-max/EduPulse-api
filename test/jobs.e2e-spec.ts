// ConfigModule reads the environment when AppModule is first imported, so switch jobs on before
// any import runs (test-env.ts turns them off for every other suite).
const before = vi.hoisted(() => {
  const value = process.env.JOBS_ENABLED;
  process.env.JOBS_ENABLED = 'true';
  return value;
});

import { ScheduledJobs } from '../src/jobs/jobs.js';
import {
  closeTestApp,
  createCourseWithBatch,
  createTestApp,
  createUser,
  enrol,
  TestContext,
} from './helpers.js';

/** The every-minute jobs, run by hand with JOBS_ENABLED on: they take a MySQL lock and do the work. */
describe('Scheduled jobs (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    process.env.JOBS_ENABLED = before;
  });

  it('sends class reminders and due announcements under a lock', async () => {
    const p = ctx.prisma;
    const faculty = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const { batchId } = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    await enrol(ctx, student.id, batchId);
    const startsAt = new Date(Date.now() + 30 * 60 * 1000);
    await p.class_sessions.create({
      data: {
        batch_id: BigInt(batchId),
        faculty_user_id: BigInt(faculty.id),
        title: 'Optics',
        starts_at: startsAt,
        ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
      },
    });
    const announcement = await p.announcements.create({
      data: {
        title: 'Results day',
        body: 'Results are out at 5 pm.',
        audience: 'BATCH',
        batch_id: BigInt(batchId),
        status: 'PUBLISHED',
        publish_at: new Date(Date.now() - 1000),
      },
    });

    const jobs = ctx.app.get(ScheduledJobs);
    await jobs.remindClasses();
    await jobs.dispatchAnnouncements();
    // Running again changes nothing: each person gets each reminder and announcement once.
    await jobs.remindClasses();
    await jobs.dispatchAnnouncements();

    const notes = await p.notifications.findMany({
      where: { user_id: BigInt(student.id) },
      select: { title: true, link_url: true },
    });
    expect(notes.filter((n) => n.title.startsWith('Class at'))).toHaveLength(1);
    expect(
      notes.filter((n) => n.link_url === `/announcements/${announcement.id}`),
    ).toHaveLength(1);

    const locks = await p.job_locks.findMany({ select: { lock_key: true } });
    expect(locks.map((l) => l.lock_key)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('jobs:class-reminders'),
        expect.stringContaining('jobs:announcements'),
      ]),
    );
  });
});
