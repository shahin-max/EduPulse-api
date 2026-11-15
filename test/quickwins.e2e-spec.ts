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
const DAY = 24 * HOUR;
const NOW = Date.now();
const at = (offsetMs: number) => new Date(NOW + offsetMs);

describe('Enquiry notes, past work, low attendance and admin summary (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const other = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT'], {
      fullName: 'Past Student',
    });
    const absentee = await createUser(ctx, ['STUDENT'], {
      fullName: 'Often Absent',
    });
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      other: other.token,
      student: student.token,
    });
    Object.assign(ids, { faculty: faculty.id, student: student.id });

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    Object.assign(ids, main);
    ids.enrollment = await enrol(ctx, student.id, main.batchId);
    const absentEnrollment = BigInt(
      await enrol(ctx, absentee.id, main.batchId),
    );
    const batchId = BigInt(main.batchId);

    // Three past classes: the absentee missed two and attended one (33.3%).
    for (let i = 1; i <= 3; i++) {
      const s = await ctx.prisma.class_sessions.create({
        data: {
          batch_id: batchId,
          title: `Class ${i}`,
          starts_at: at(-i * DAY),
          ends_at: at(-i * DAY + HOUR),
        },
      });
      await ctx.prisma.class_attendance.create({
        data: {
          batch_id: batchId,
          class_session_id: s.id,
          enrollment_id: absentEnrollment,
          status: i === 3 ? 'PRESENT' : 'ABSENT',
        },
      });
    }
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();

  it('keeps call notes on an enquiry and marks a NEW one contacted', async () => {
    const enquiry = await ctx.prisma.admission_enquiries.create({
      data: {
        student_name: 'Caller',
        mobile: '+919876511111',
        assigned_to: BigInt(ids.faculty),
      },
    });
    await http()
      .post(api(`/admission-enquiries/${enquiry.id}/notes`))
      .set(bearer(t.faculty))
      .send({ body: '  ' })
      .expect(400);
    const note = await http()
      .post(api(`/admission-enquiries/${enquiry.id}/notes`))
      .set(bearer(t.faculty))
      .send({ body: 'Asked to call back Monday' })
      .expect(201);
    expect(note.body).toMatchObject({
      body: 'Asked to call back Monday',
      users: { id: ids.faculty },
    });
    await http()
      .post(api(`/admission-enquiries/${enquiry.id}/notes`))
      .set(bearer(t.admin))
      .send({ body: 'Office called too' })
      .expect(201);

    const list = await http()
      .get(api(`/admission-enquiries/${enquiry.id}/notes`))
      .set(bearer(t.faculty))
      .expect(200);
    expect(list.body.map((n: { body: string }) => n.body)).toEqual([
      'Asked to call back Monday',
      'Office called too',
    ]);
    const after = await http()
      .get(api(`/admission-enquiries/${enquiry.id}`))
      .set(bearer(t.admin))
      .expect(200);
    expect(after.body).toMatchObject({
      status: 'CONTACTED',
      _count: { enquiry_notes: 2 },
    });
    // Faculty only reach enquiries assigned to them.
    await http()
      .get(api(`/admission-enquiries/${enquiry.id}/notes`))
      .set(bearer(t.other))
      .expect(404);
  });

  it('returns photo_url in the batch roster', async () => {
    const res = await http()
      .get(api(`/batches/${ids.batchId}/students`))
      .set(bearer(t.faculty))
      .expect(200);
    expect(res.body[0].student_profiles.users).toHaveProperty(
      'photo_url',
      null,
    );
  });

  it('lists low attendance on the teaching dashboard', async () => {
    const res = await http()
      .get(api('/teaching/dashboard'))
      .set(bearer(t.faculty))
      .expect(200);
    expect(res.body.low_attendance).toEqual([
      expect.objectContaining({
        full_name: 'Often Absent',
        percentage: 33.3,
        counted: 3,
        batch: expect.objectContaining({ id: ids.batchId }),
      }),
    ]);
  });

  it('lets a student re-read past work after the batch ends, without handing in', async () => {
    const a = await ctx.prisma.assignments.create({
      data: {
        batch_id: BigInt(ids.batchId),
        title: 'Old worksheet',
        status: 'PUBLISHED',
      },
    });
    await http()
      .put(api(`/assignments/${a.id}/submission`))
      .set(bearer(t.student))
      .send({ responseText: 'My answer' })
      .expect(200);
    const current = await http()
      .get(api(`/assignments/${a.id}`))
      .set(bearer(t.student))
      .expect(200);
    expect(current.body.can_submit).toBe(true);

    await ctx.prisma.enrollments.update({
      where: { id: BigInt(ids.enrollment) },
      data: { status: 'COMPLETED', completed_at: new Date() },
    });
    const past = await http()
      .get(api(`/assignments/${a.id}`))
      .set(bearer(t.student))
      .expect(200);
    expect(past.body.can_submit).toBe(false);
    const mine = await http()
      .get(api(`/assignments/${a.id}/submission`))
      .set(bearer(t.student))
      .expect(200);
    expect(mine.body.response_text).toBe('My answer');
    await http()
      .put(api(`/assignments/${a.id}/submission`))
      .set(bearer(t.student))
      .send({ responseText: 'Change' })
      .expect(403);
    const list = await http()
      .get(api('/student/assignments'))
      .set(bearer(t.student))
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: Number(a.id),
        current: false,
        state: 'SUBMITTED',
      }),
    ]);
  });

  it('summarises six months for the admin home', async () => {
    const res = await http()
      .get(api('/reports/admin-summary'))
      .set(bearer(t.admin))
      .expect(200);
    expect(res.body.months).toHaveLength(6);
    expect(res.body.months[5]).toBe(
      new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 7),
    );
    expect(
      res.body.enrollments.reduce((s: number, n: number) => s + n, 0),
    ).toBeGreaterThanOrEqual(2);
    expect(res.body.enquiries[5].total).toBeGreaterThanOrEqual(1);
    expect(res.body.batch_attendance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batch: expect.objectContaining({ id: ids.batchId }),
          percentage: 33.3,
          marked: 3,
        }),
      ]),
    );
    await http()
      .get(api('/reports/admin-summary'))
      .set(bearer(t.faculty))
      .expect(403);
  });
});
