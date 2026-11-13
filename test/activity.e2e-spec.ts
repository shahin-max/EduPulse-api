import {
  api,
  bearer,
  closeTestApp,
  createCourseWithBatch,
  createTestApp,
  createUser,
  enrol,
  testBranchId,
  TestContext,
} from './helpers.js';

type Note = { title: string; message: string; link_url: string | null };

describe('Activity notifications and multi-batch tests (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const twoBatches = await createUser(ctx, ['STUDENT']);
    const outsider = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      student: student.token,
      twoBatches: twoBatches.token,
      outsider: outsider.token,
    });
    ids.faculty = faculty.id;

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    Object.assign(ids, main);
    // A second batch of the same course, taught by the same teacher.
    const second = await ctx.prisma.batches.create({
      data: {
        branch_id: BigInt(await testBranchId(ctx)),
        course_id: BigInt(main.courseId),
        code: `B2X${Date.now() % 100000}`,
        name: 'Evening batch',
        status: 'ACTIVE',
      },
    });
    await ctx.prisma.batch_faculty.create({
      data: {
        batch_id: second.id,
        faculty_user_id: BigInt(faculty.id),
        subject_id: BigInt(main.subjectId),
      },
    });
    ids.second = Number(second.id);
    ids.enrollment = await enrol(ctx, student.id, main.batchId);
    await enrol(ctx, twoBatches.id, main.batchId);
    await enrol(ctx, twoBatches.id, ids.second);
    await enrol(ctx, outsider.id, (await createCourseWithBatch(ctx)).batchId);
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();
  const notes = async (token: string): Promise<Note[]> =>
    (await http().get(api('/notifications')).set(bearer(token)).expect(200))
      .body.data;

  it('tells the batch about a published assignment once, and the student when it is marked', async () => {
    const draft = await http()
      .post(api('/assignments'))
      .set(bearer(t.faculty))
      .send({
        batchId: ids.batchId,
        title: 'Worksheet 3',
        status: 'DRAFT',
        maxMarks: 10,
      })
      .expect(201);
    expect(await notes(t.student)).toEqual([]);

    await http()
      .patch(api(`/assignments/${draft.body.id}`))
      .set(bearer(t.faculty))
      .send({ status: 'PUBLISHED' })
      .expect(200);
    // Closing and re-publishing does not notify again.
    await http()
      .patch(api(`/assignments/${draft.body.id}`))
      .set(bearer(t.faculty))
      .send({ status: 'CLOSED' })
      .expect(200);
    await http()
      .patch(api(`/assignments/${draft.body.id}`))
      .set(bearer(t.faculty))
      .send({ status: 'PUBLISHED' })
      .expect(200);
    const mine = await notes(t.student);
    expect(mine).toEqual([
      expect.objectContaining({
        title: 'New assignment: Worksheet 3',
        link_url: `/student/assignments/${draft.body.id}`,
      }),
    ]);
    expect(await notes(t.outsider)).toEqual([]);

    const sub = await http()
      .put(api(`/assignments/${draft.body.id}/submission`))
      .set(bearer(t.student))
      .send({ responseText: 'Done' })
      .expect(200);
    await http()
      .patch(api(`/assignment-submissions/${sub.body.id}/review`))
      .set(bearer(t.faculty))
      .send({ marksAwarded: 8, feedback: 'Good' })
      .expect(200);
    expect((await notes(t.student))[0]).toMatchObject({
      title: 'Assignment marked: Worksheet 3',
      message: 'You got 8 out of 10. Your teacher left feedback.',
    });
  });

  it('announces a published test, and lets a student in two batches choose one', async () => {
    const q = await http()
      .post(api('/questions'))
      .set(bearer(t.faculty))
      .send({
        courseId: ids.courseId,
        subjectId: ids.subjectId,
        questionText: '2 + 2?',
        marksDefault: 4,
        options: [
          { optionLabel: 'A', optionText: '4', isCorrect: true },
          { optionLabel: 'B', optionText: '5', isCorrect: false },
        ],
      })
      .expect(201);
    const exam = await http()
      .post(api('/exams'))
      .set(bearer(t.faculty))
      .send({
        courseId: ids.courseId,
        title: 'Quick quiz',
        kind: 'DAILY_PRACTICE',
        durationMinutes: 10,
      })
      .expect(201);
    await http()
      .put(api(`/exams/${exam.body.id}/batches/${ids.batchId}`))
      .set(bearer(t.faculty))
      .expect(200);
    await http()
      .post(api(`/exams/${exam.body.id}/questions`))
      .set(bearer(t.faculty))
      .send({ questionId: q.body.id })
      .expect(201);
    await http()
      .patch(api(`/exams/${exam.body.id}`))
      .set(bearer(t.faculty))
      .send({ status: 'PUBLISHED' })
      .expect(200);
    expect((await notes(t.student))[0]).toMatchObject({
      title: 'New test: Quick quiz',
      link_url: `/student/tests#exam-${exam.body.id}`,
    });

    // A batch attached after publishing hears about it; the first batch is not told twice.
    await http()
      .put(api(`/exams/${exam.body.id}/batches/${ids.second}`))
      .set(bearer(t.faculty))
      .expect(200);
    const twoNotes = (await notes(t.twoBatches)).filter(
      (n) => n.title === 'New test: Quick quiz',
    );
    expect(twoNotes).toHaveLength(1);

    const available = await http()
      .get(api('/exams/available'))
      .set(bearer(t.twoBatches))
      .expect(200);
    expect(
      available.body[0].my_batches
        .map((b: { id: number }) => b.id)
        .sort((a: number, b: number) => a - b),
    ).toEqual([ids.batchId, ids.second].sort((a, b) => a - b));
    const single = await http()
      .get(api('/exams/available'))
      .set(bearer(t.student))
      .expect(200);
    expect(single.body[0].my_batches).toEqual([
      expect.objectContaining({ id: ids.batchId }),
    ]);

    await http()
      .post(api(`/exams/${exam.body.id}/attempts`))
      .set(bearer(t.twoBatches))
      .send({})
      .expect(400);
    const attempt = await http()
      .post(api(`/exams/${exam.body.id}/attempts`))
      .set(bearer(t.twoBatches))
      .send({ batchId: ids.second })
      .expect(201);
    expect(attempt.body.batch_id).toBe(ids.second);
  });

  it('tells the student about an issued invoice and a confirmed payment', async () => {
    const invoice = await http()
      .post(api('/fee-invoices'))
      .set(bearer(t.admin))
      .send({
        enrollmentId: ids.enrollment,
        grossAmount: '12000',
        discountAmount: '2000',
        issue: true,
      })
      .expect(201);
    const issued = (await notes(t.student))[0];
    expect(issued).toMatchObject({
      title: `Fee invoice ${invoice.body.invoice_number}`,
      link_url: `/student/fees#invoice-${invoice.body.id}`,
    });
    expect(issued.message).toContain('10,000');

    const pay = await http()
      .post(api(`/fee-invoices/${invoice.body.id}/payments`))
      .set(bearer(t.admin))
      .send({
        amount: '4000',
        method: 'UPI',
        idempotencyKey: 'activity-pay-0001',
      })
      .expect(201);
    const paid = (await notes(t.student))[0];
    expect(paid.title).toContain('Payment received');
    expect(paid.message).toContain(pay.body.receipt_number);
  });

  it('tells a teacher when an enquiry is assigned to them', async () => {
    const enquiry = await ctx.prisma.admission_enquiries.create({
      data: { student_name: 'Rahul', mobile: '+919876500000' },
    });
    await http()
      .patch(api(`/admission-enquiries/${enquiry.id}`))
      .set(bearer(t.admin))
      .send({ assignedTo: ids.faculty })
      .expect(200);
    expect((await notes(t.faculty))[0]).toMatchObject({
      title: 'Enquiry assigned: Rahul',
      link_url: '/teach/enquiries',
    });
  });
});
