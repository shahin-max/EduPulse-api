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

type Note = { title: string; message: string; link_url: string | null };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('Class notifications and subject-wise performance (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const outsider = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      student: student.token,
      outsider: outsider.token,
    });
    Object.assign(ids, { faculty: faculty.id, student: student.id });

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    Object.assign(ids, main);
    ids.enrollment = await enrol(ctx, student.id, main.batchId);
    await enrol(ctx, outsider.id, (await createCourseWithBatch(ctx)).batchId);

    // A second subject in the same course, for the per-subject split.
    const chem = await ctx.prisma.subjects.create({
      data: { code: `CHEM${Date.now() % 100000}`, name: 'Chemistry' },
    });
    await ctx.prisma.course_subjects.create({
      data: { course_id: BigInt(main.courseId), subject_id: chem.id },
    });
    ids.chem = Number(chem.id);
    await ctx.prisma.subjects.update({
      where: { id: BigInt(main.subjectId) },
      data: { name: 'Physics' },
    });

    // A class starting in 30 minutes, created before any notification read, for the reminder test
    // (reminders run at most once a minute per app instance, on the first read).
    const soon = await ctx.prisma.class_sessions.create({
      data: {
        batch_id: BigInt(main.batchId),
        faculty_user_id: BigInt(faculty.id),
        title: 'Soon class',
        starts_at: new Date(Date.now() + 30 * MIN),
        ends_at: new Date(Date.now() + 90 * MIN),
        meeting_url: 'https://meet.google.com/abc-defg-hij',
      },
    });
    ids.soon = Number(soon.id);
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();
  const notes = async (token: string): Promise<Note[]> =>
    (await http().get(api('/notifications')).set(bearer(token)).expect(200))
      .body.data;

  it('reminds students and the teacher about a class starting within the hour', async () => {
    const mine = await notes(t.student);
    const reminder = mine.find(
      (n) =>
        n.title.startsWith('Class at ') && n.title.endsWith(': Soon class'),
    );
    expect(reminder).toMatchObject({
      link_url: `/student/classes?class=${ids.soon}`,
    });
    expect(reminder!.message).toContain('join link');
    const teacher = await notes(t.faculty);
    expect(
      teacher.some(
        (n) =>
          n.title.endsWith(': Soon class') &&
          n.link_url === `/teach/classes/${ids.soon}`,
      ),
    ).toBe(true);
    expect(
      (await notes(t.outsider)).some((n) => n.title.includes('Soon class')),
    ).toBe(false);
  });

  it('tells the batch when a class is scheduled, moved, recorded and cancelled', async () => {
    const start = new Date(Date.now() + 2 * DAY);
    const created = await http()
      .post(api('/class-sessions'))
      .set(bearer(t.faculty))
      .send({
        batchId: ids.batchId,
        title: 'Optics',
        startsAt: start,
        endsAt: new Date(start.getTime() + HOUR),
      })
      .expect(201);
    expect((await notes(t.student))[0]).toMatchObject({
      title: 'New class: Optics',
      link_url: `/student/classes?class=${created.body.id}`,
    });
    expect(
      (await notes(t.outsider)).some((n) => n.title.includes('Optics')),
    ).toBe(false);

    const later = new Date(start.getTime() + DAY);
    await http()
      .patch(api(`/class-sessions/${created.body.id}`))
      .set(bearer(t.faculty))
      .send({ startsAt: later, endsAt: new Date(later.getTime() + HOUR) })
      .expect(200);
    const moved = (await notes(t.student))[0];
    expect(moved.title).toBe('Class moved: Optics');
    expect(moved.message).toMatch(/^Now .* \(was .*\)\.$/);

    await http()
      .patch(api(`/class-sessions/${created.body.id}`))
      .set(bearer(t.faculty))
      .send({ recordingUrl: 'https://youtu.be/abcdefghijk' })
      .expect(200);
    expect((await notes(t.student))[0].title).toBe(
      'Recording available: Optics',
    );

    await http()
      .post(api(`/class-sessions/${created.body.id}/cancel`))
      .set(bearer(t.faculty))
      .expect(201);
    await http()
      .post(api(`/class-sessions/${created.body.id}/cancel`))
      .set(bearer(t.faculty));
    const all = await notes(t.student);
    expect(
      all.filter((n) => n.title === 'Class cancelled: Optics'),
    ).toHaveLength(1);
  });

  it('splits test and assignment results by subject', async () => {
    // Two Physics and one Chemistry question, 4 marks each, no negative marking.
    const make = async (subjectId: number, text: string) => {
      const q = await http()
        .post(api('/questions'))
        .set(bearer(t.admin))
        .send({
          courseId: ids.courseId,
          subjectId,
          questionText: text,
          marksDefault: 4,
          options: [
            { optionLabel: 'A', optionText: 'Right', isCorrect: true },
            { optionLabel: 'B', optionText: 'Wrong', isCorrect: false },
          ],
        })
        .expect(201);
      const right = q.body.question_options.find(
        (o: { is_correct: boolean }) => o.is_correct,
      ).id;
      const wrong = q.body.question_options.find(
        (o: { is_correct: boolean }) => !o.is_correct,
      ).id;
      return {
        id: q.body.id as number,
        right: right as number,
        wrong: wrong as number,
      };
    };
    const p1 = await make(ids.subjectId, 'Physics 1');
    const p2 = await make(ids.subjectId, 'Physics 2');
    const c1 = await make(ids.chem, 'Chemistry 1');

    const publishExam = async (showResultImmediately: boolean) => {
      const exam = await http()
        .post(api('/exams'))
        .set(bearer(t.admin))
        .send({
          courseId: ids.courseId,
          title: `Mixed ${showResultImmediately}`,
          kind: 'MOCK_TEST',
          durationMinutes: 20,
          showResultImmediately,
        })
        .expect(201);
      await http()
        .put(api(`/exams/${exam.body.id}/batches/${ids.batchId}`))
        .set(bearer(t.admin))
        .expect(200);
      for (const q of [p1, p2, c1])
        await http()
          .post(api(`/exams/${exam.body.id}/questions`))
          .set(bearer(t.admin))
          .send({ questionId: q.id })
          .expect(201);
      await http()
        .patch(api(`/exams/${exam.body.id}`))
        .set(bearer(t.admin))
        .send({ status: 'PUBLISHED' })
        .expect(200);
      return exam.body.id as number;
    };
    const take = async (
      examId: number,
      answers: [{ id: number }, number][],
    ) => {
      const attempt = await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(t.student))
        .send({})
        .expect(201);
      for (const [q, option] of answers)
        await http()
          .put(api(`/exam-attempts/${attempt.body.id}/answers/${q.id}`))
          .set(bearer(t.student))
          .send({ selectedOptionId: option })
          .expect(200);
      await http()
        .post(api(`/exam-attempts/${attempt.body.id}/submit`))
        .set(bearer(t.student))
        .expect(200);
    };

    // Released: Physics 1 right, Physics 2 wrong, Chemistry 1 right.
    await take(await publishExam(true), [
      [p1, p1.right],
      [p2, p2.wrong],
      [c1, c1.right],
    ]);
    // Not released: everything right; only staff see it.
    await take(await publishExam(false), [
      [p1, p1.right],
      [p2, p2.right],
      [c1, c1.right],
    ]);

    const a = await ctx.prisma.assignments.create({
      data: {
        batch_id: BigInt(ids.batchId),
        subject_id: BigInt(ids.subjectId),
        title: 'Physics sheet',
        status: 'PUBLISHED',
        max_marks: 10,
      },
    });
    const sub = await http()
      .put(api(`/assignments/${a.id}/submission`))
      .set(bearer(t.student))
      .send({ responseText: 'x' })
      .expect(200);
    await http()
      .patch(api(`/assignment-submissions/${sub.body.id}/review`))
      .set(bearer(t.faculty))
      .send({ marksAwarded: 8 })
      .expect(200);

    const mine = await http()
      .get(api('/student/performance'))
      .set(bearer(t.student))
      .expect(200);
    const physics = mine.body.find(
      (s: { subject: { name: string } }) => s.subject.name === 'Physics',
    );
    const chemistry = mine.body.find(
      (s: { subject: { name: string } }) => s.subject.name === 'Chemistry',
    );
    expect(physics.tests).toMatchObject({
      score: 4,
      max: 8,
      percentage: 50,
      correct: 1,
      wrong: 1,
      tests: 1,
    });
    expect(physics.assignments).toEqual({
      marks: 8,
      max: 10,
      percentage: 80,
      count: 1,
    });
    expect(chemistry.tests).toMatchObject({
      score: 4,
      max: 4,
      percentage: 100,
    });
    expect(chemistry.assignments).toBeNull();

    // Staff see both tests: best attempt per test, so Physics is 4/8 + 8/8.
    const report = await http()
      .get(api(`/batches/${ids.batchId}/students/${ids.student}/report`))
      .set(bearer(t.faculty))
      .expect(200);
    const staffPhysics = report.body.subjects.find(
      (s: { subject: { name: string } }) => s.subject.name === 'Physics',
    );
    expect(staffPhysics.tests).toMatchObject({
      score: 12,
      max: 16,
      percentage: 75,
      tests: 2,
    });

    await http()
      .get(api('/student/performance'))
      .set(bearer(t.faculty))
      .expect(403);
  });
});
