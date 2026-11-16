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

describe('Scholarship Tests: registration, online test, awards, fees (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    Object.assign(t, { admin: admin.token, faculty: faculty.token });
    // A regular course (for the fee invoice later); its subject is attached to the scholarship course too.
    const regular = await createCourseWithBatch(ctx);
    Object.assign(ids, {
      regularBatch: regular.batchId,
      subject: regular.subjectId,
    });
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();

  it('lets an admin set up a test, refusing to open it with an empty paper', async () => {
    await http()
      .post(api('/scholarship-tests'))
      .set(bearer(t.faculty))
      .send({})
      .expect(403);
    const res = await http()
      .post(api('/scholarship-tests'))
      .set(bearer(t.admin))
      .send({
        title: 'EduPulse Scholarship Test 2027',
        description: 'For Class 5 and 6',
        eligibleGrades: ['Class 5', 'Class 6'],
        slabs: [
          { minPercentage: 60, discountPercent: 25 },
          { minPercentage: 90, discountPercent: 50 },
        ],
        opensAt: new Date(Date.now() - HOUR),
        closesAt: new Date(Date.now() + 2 * HOUR),
        durationMinutes: 30,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      exams: { status: 'DRAFT', kind: 'MOCK_TEST' },
    });
    expect(
      res.body.slabs.map((s: { minPercentage: number }) => s.minPercentage),
    ).toEqual([90, 60]);
    Object.assign(ids, { test: res.body.id, exam: res.body.exam_id });

    await http()
      .post(api(`/scholarship-tests/${ids.test}/open`))
      .set(bearer(t.admin))
      .expect(400);
    expect(
      (await http().get(api('/scholarship-tests/current')).expect(200)).body,
    ).toEqual({ test: null });

    // The paper: two 5-mark questions in the hidden Scholarship Tests course.
    const exam = await http()
      .get(api(`/exams/${ids.exam}`))
      .set(bearer(t.admin))
      .expect(200);
    const options: Record<number, { right: number; wrong: number }> = {};
    for (const n of [1, 2]) {
      const q = await http()
        .post(api('/questions'))
        .set(bearer(t.admin))
        .send({
          courseId: exam.body.course_id,
          subjectId: ids.subject,
          questionText: `Q${n}`,
          marksDefault: 5,
          options: [
            { optionLabel: 'A', optionText: 'Yes', isCorrect: true },
            { optionLabel: 'B', optionText: 'No', isCorrect: false },
          ],
        })
        .expect(201);
      options[q.body.id] = {
        right: q.body.question_options.find(
          (o: { is_correct: boolean }) => o.is_correct,
        ).id,
        wrong: q.body.question_options.find(
          (o: { is_correct: boolean }) => !o.is_correct,
        ).id,
      };
      await http()
        .post(api(`/exams/${ids.exam}/questions`))
        .set(bearer(t.admin))
        .send({ questionId: q.body.id })
        .expect(201);
    }
    ids.q1 = Number(Object.keys(options)[0]);
    ids.q2 = Number(Object.keys(options)[1]);
    Object.assign(ids, {
      q1Right: options[ids.q1].right,
      q2Right: options[ids.q2].right,
      q2Wrong: options[ids.q2].wrong,
    });

    const opened = await http()
      .post(api(`/scholarship-tests/${ids.test}/open`))
      .set(bearer(t.admin))
      .expect(200);
    expect(opened.body).toMatchObject({
      status: 'OPEN',
      exams: { status: 'PUBLISHED' },
    });
    const current = await http()
      .get(api('/scholarship-tests/current'))
      .expect(200);
    expect(current.body.test).toMatchObject({
      id: ids.test,
      eligible_grades: ['Class 5', 'Class 6'],
      duration_minutes: 30,
    });
  });

  it('registers students who sign up on the website, checking the class', async () => {
    for (const [key, n] of [
      ['amy', 1],
      ['ben', 2],
    ] as const) {
      const reg = await http()
        .post(api('/auth/register'))
        .send({
          fullName: `Candidate ${n}`,
          mobile: `+9198765000${10 + n}`,
          password: 'Passw0rd1',
        })
        .expect(201);
      t[key] = reg.body.accessToken;
      ids[`${key}Id`] = reg.body.user.id;
    }
    await http()
      .post(api(`/scholarship-tests/${ids.test}/join`))
      .set(bearer(t.amy))
      .send({ grade: 'Class 9' })
      .expect(400);
    const joined = await http()
      .post(api(`/scholarship-tests/${ids.test}/join`))
      .set(bearer(t.amy))
      .send({ grade: 'Class 5' })
      .expect(200);
    expect(joined.body).toEqual({
      registered: true,
      already: false,
      test_id: ids.test,
    });
    expect(
      (
        await http()
          .post(api(`/scholarship-tests/${ids.test}/join`))
          .set(bearer(t.amy))
          .send({ grade: 'Class 5' })
          .expect(200)
      ).body.already,
    ).toBe(true);
    await http()
      .post(api(`/scholarship-tests/${ids.test}/join`))
      .set(bearer(t.ben))
      .send({ grade: 'Class 6' })
      .expect(200);

    const enquiry = await ctx.prisma.admission_enquiries.findFirst({
      where: { mobile: '+919876500011', source: 'SCHOLARSHIP_TEST' },
    });
    expect(enquiry?.message).toContain('Class: Class 5');
    // The candidates batch is not a "course" in the student portal.
    expect(
      (await http().get(api('/student/courses')).set(bearer(t.amy)).expect(200))
        .body,
    ).toEqual([]);
    const mine = await http()
      .get(api('/student/scholarships'))
      .set(bearer(t.amy))
      .expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({
        id: ids.test,
        can_start: true,
        attempt: null,
        result: null,
      }),
    ]);
  });

  it('marks the online test, ranks candidates and applies slabs and overrides', async () => {
    const take = async (token: string, q2: number) => {
      const attempt = await http()
        .post(api(`/exams/${ids.exam}/attempts`))
        .set(bearer(token))
        .send({})
        .expect(201);
      await http()
        .put(api(`/exam-attempts/${attempt.body.id}/answers/${ids.q1}`))
        .set(bearer(token))
        .send({ selectedOptionId: ids.q1Right })
        .expect(200);
      await http()
        .put(api(`/exam-attempts/${attempt.body.id}/answers/${ids.q2}`))
        .set(bearer(token))
        .send({ selectedOptionId: q2 })
        .expect(200);
      const done = await http()
        .post(api(`/exam-attempts/${attempt.body.id}/submit`))
        .set(bearer(token))
        .expect(200);
      expect(done.body.results_visible).toBe(false);
    };
    await take(t.amy, ids.q2Right); // 100%
    await take(t.ben, ids.q2Wrong); // 50%

    const results = await http()
      .get(api(`/scholarship-tests/${ids.test}/results`))
      .set(bearer(t.admin))
      .expect(200);
    expect(results.body.took_test).toBe(2);
    expect(
      results.body.candidates.map(
        (c: {
          student: { id: number };
          rank: number;
          suggested_discount: number;
        }) => [c.student.id, c.rank, c.suggested_discount],
      ),
    ).toEqual([
      [ids.amyId, 1, 50],
      [ids.benId, 2, 0],
    ]);

    const overridden = await http()
      .put(api(`/scholarship-tests/${ids.test}/awards/${ids.benId}`))
      .set(bearer(t.admin))
      .send({ discountPercent: 10, note: 'Strong interview' })
      .expect(200);
    expect(overridden.body.candidates[1]).toMatchObject({
      discount_percent: 10,
      is_override: true,
      note: 'Strong interview',
    });
  });

  it('publishes results to students with a notification', async () => {
    await http()
      .post(api(`/scholarship-tests/${ids.test}/publish`))
      .set(bearer(t.admin))
      .expect(200);
    await http()
      .post(api(`/scholarship-tests/${ids.test}/publish`))
      .set(bearer(t.admin))
      .expect(409);
    const mine = await http()
      .get(api('/student/scholarships'))
      .set(bearer(t.amy))
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      status: 'RESULTS_PUBLISHED',
      result: {
        percentage: '100',
        rank: 1,
        candidates: 2,
        discount_percent: '50',
        used: false,
      },
    });
    const ben = await http()
      .get(api('/student/scholarships'))
      .set(bearer(t.ben))
      .expect(200);
    expect(ben.body[0].result).toMatchObject({
      rank: 2,
      discount_percent: '10',
    });
    const notes = await http()
      .get(api('/notifications'))
      .set(bearer(t.amy))
      .expect(200);
    expect(notes.body.data[0]).toMatchObject({
      title: 'Scholarship awarded: 50% off',
      link_url: `/student/scholarships?test=${ids.test}`,
    });
  });

  it('applies the award once to a fee invoice, and releases it when the invoice is voided', async () => {
    const enrollment = await enrol(ctx, ids.amyId, ids.regularBatch);
    const available = await http()
      .get(api(`/students/${ids.amyId}/scholarships`))
      .set(bearer(t.admin))
      .expect(200);
    expect(available.body).toHaveLength(1);
    const awardId = available.body[0].id;

    const invoice = await http()
      .post(api('/fee-invoices'))
      .set(bearer(t.admin))
      .send({
        enrollmentId: enrollment,
        grossAmount: '12000',
        scholarshipAwardId: awardId,
      })
      .expect(201);
    expect(invoice.body).toMatchObject({
      gross_amount: '12000',
      discount_amount: '6000',
      amount_due: '6000',
    });
    expect(invoice.body.description).toContain('50% scholarship');
    expect(
      (
        await http()
          .get(api(`/students/${ids.amyId}/scholarships`))
          .set(bearer(t.admin))
          .expect(200)
      ).body,
    ).toEqual([]);

    await http()
      .post(api('/fee-invoices'))
      .set(bearer(t.admin))
      .send({
        enrollmentId: enrollment,
        grossAmount: '12000',
        scholarshipAwardId: awardId,
      })
      .expect(409);
    // Someone else's award is refused.
    const benAward = await ctx.prisma.scholarship_awards.findFirstOrThrow({
      where: { student_user_id: BigInt(ids.benId) },
    });
    await http()
      .post(api('/fee-invoices'))
      .set(bearer(t.admin))
      .send({
        enrollmentId: enrollment,
        grossAmount: '12000',
        scholarshipAwardId: Number(benAward.id),
      })
      .expect(400);

    await http()
      .post(api(`/fee-invoices/${invoice.body.id}/void`))
      .set(bearer(t.admin))
      .expect(201);
    expect(
      (
        await http()
          .get(api(`/students/${ids.amyId}/scholarships`))
          .set(bearer(t.admin))
          .expect(200)
      ).body,
    ).toHaveLength(1);
  });
});
