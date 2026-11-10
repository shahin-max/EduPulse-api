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

const HOUR = 3600 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('Classes & attendance (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const outsider = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const otherStudent = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      outsider: outsider.token,
      student: student.token,
      other: otherStudent.token,
    });
    ids.faculty = faculty.id;

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    const second = await createCourseWithBatch(ctx);
    Object.assign(ids, {
      batch: main.batchId,
      subject: main.subjectId,
      otherBatch: second.batchId,
      otherSubject: second.subjectId,
    });
    ids.enrollment = await enrol(ctx, student.id, main.batchId);
    ids.otherEnrollment = await enrol(ctx, otherStudent.id, second.batchId);
  });

  afterAll(() => closeTestApp(ctx));

  const http = () => ctx.http();

  it('lets assigned faculty schedule a class, defaulting to themselves as teacher', async () => {
    const res = await http()
      .post(api('/class-sessions'))
      .set(bearer(t.faculty))
      .send({
        batchId: ids.batch,
        subjectId: ids.subject,
        title: 'Kinematics',
        startsAt: at(-2 * HOUR),
        endsAt: at(-HOUR),
        meetingUrl: 'https://meet.example.com/abc',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'SCHEDULED',
      faculty_user_id: ids.faculty,
      subjects: { id: ids.subject },
    });
    ids.past = res.body.id;

    const future = await http()
      .post(api('/class-sessions'))
      .set(bearer(t.admin))
      .send({
        batchId: ids.batch,
        title: 'Revision',
        startsAt: at(24 * HOUR),
        endsAt: at(26 * HOUR),
      })
      .expect(201);
    expect(future.body.faculty_user_id).toBeNull();
    ids.future = future.body.id;
  });

  it('rejects bad schedules and outsiders', async () => {
    const base = {
      batchId: ids.batch,
      title: 'X class',
      startsAt: at(HOUR),
      endsAt: at(2 * HOUR),
    };
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.faculty))
      .send({ ...base, endsAt: at(HOUR) })
      .expect(400);
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.faculty))
      .send({ ...base, subjectId: ids.otherSubject })
      .expect(400);
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.faculty))
      .send({ ...base, meetingUrl: 'not a url' })
      .expect(400);
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.admin))
      .send({ ...base, facultyUserId: ids.faculty + 1000 })
      .expect(400);
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.outsider))
      .send(base)
      .expect(403);
    await http()
      .post(api('/class-sessions'))
      .set(bearer(t.student))
      .send(base)
      .expect(403);
  });

  it('shows the batch schedule to its students only', async () => {
    const res = await http()
      .get(api(`/class-sessions?batchId=${ids.batch}`))
      .set(bearer(t.student))
      .expect(200);
    expect(res.body.meta.total).toBe(2);
    await http()
      .get(api(`/class-sessions?batchId=${ids.batch}`))
      .set(bearer(t.other))
      .expect(403);
    await http()
      .get(api(`/class-sessions/${ids.past}`))
      .set(bearer(t.other))
      .expect(403);
  });

  it('builds a timetable across the user’s batches', async () => {
    const student = await http()
      .get(api('/class-sessions/timetable'))
      .set(bearer(t.student))
      .expect(200);
    expect(student.body.map((s: { id: number }) => s.id)).toEqual([ids.future]);
    const other = await http()
      .get(api('/class-sessions/timetable'))
      .set(bearer(t.other))
      .expect(200);
    expect(other.body).toEqual([]);
    await http()
      .get(
        api(`/class-sessions/timetable?from=${at(0)}&to=${at(40 * 24 * HOUR)}`),
      )
      .set(bearer(t.student))
      .expect(400);
  });

  it('marks attendance in bulk and lets the student see a summary', async () => {
    const sheet = await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.faculty))
      .send({ entries: [{ enrollmentId: ids.enrollment, status: 'PRESENT' }] })
      .expect(200);
    expect(sheet.body.students).toHaveLength(1);
    expect(sheet.body.students[0]).toMatchObject({
      enrollment_id: ids.enrollment,
      status: 'PRESENT',
    });
    expect(sheet.body.summary).toMatchObject({
      total: 1,
      present: 1,
      percentage: 100,
    });

    const mine = await http()
      .get(api('/attendance/me'))
      .set(bearer(t.student))
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      batch: { id: ids.batch },
      summary: { present: 1, percentage: 100 },
    });

    // Re-marking overwrites.
    await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.faculty))
      .send({ entries: [{ enrollmentId: ids.enrollment, status: 'ABSENT' }] })
      .expect(200);
    const after = await http()
      .get(api('/attendance/me'))
      .set(bearer(t.student))
      .expect(200);
    expect(after.body[0].summary).toMatchObject({
      total: 1,
      absent: 1,
      percentage: 0,
    });
  });

  it('refuses attendance for other batches, future or cancelled classes, and non-managers', async () => {
    const entries = [{ enrollmentId: ids.enrollment, status: 'PRESENT' }];
    await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.faculty))
      .send({
        entries: [{ enrollmentId: ids.otherEnrollment, status: 'PRESENT' }],
      })
      .expect(400);
    await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.faculty))
      .send({ entries: [...entries, ...entries] })
      .expect(400);
    await http()
      .put(api(`/class-sessions/${ids.future}/attendance`))
      .set(bearer(t.faculty))
      .send({ entries })
      .expect(400);
    await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.outsider))
      .send({ entries })
      .expect(403);
    await http()
      .get(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.student))
      .expect(403);

    const cancelled = await http()
      .post(api(`/class-sessions/${ids.past}/cancel`))
      .set(bearer(t.faculty))
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    await http()
      .put(api(`/class-sessions/${ids.past}/attendance`))
      .set(bearer(t.faculty))
      .send({ entries })
      .expect(400);
  });

  it('updates a class, e.g. adding the recording', async () => {
    const res = await http()
      .patch(api(`/class-sessions/${ids.future}`))
      .set(bearer(t.faculty))
      .send({
        recordingUrl: 'https://videos.example.com/rev-1',
        facultyUserId: ids.faculty,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      recording_url: 'https://videos.example.com/rev-1',
      faculty_user_id: ids.faculty,
    });
    await http()
      .patch(api(`/class-sessions/${ids.future}`))
      .set(bearer(t.faculty))
      .send({ endsAt: at(HOUR) })
      .expect(400);
  });
});
