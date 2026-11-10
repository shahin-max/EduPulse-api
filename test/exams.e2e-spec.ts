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

/**
 * Exams end to end: question bank, exam setup, a student attempt with negative marking,
 * result/review release, auto-submit on expiry, attempt limits, invalidation and ranking.
 */
describe('Exams (e2e)', () => {
  let ctx: TestContext;
  let admin: { id: number; token: string };
  let faculty: { id: number; token: string };
  let otherFaculty: { id: number; token: string };
  let student: { id: number; token: string };
  let student2: { id: number; token: string };
  let outsider: { id: number; token: string };
  let course: Awaited<ReturnType<typeof createCourseWithBatch>>;
  let examId: number;
  const questionIds: number[] = [];
  const correctOption: Record<number, number> = {};
  const wrongOption: Record<number, number> = {};
  let attemptId: number;

  const past = () => new Date(Date.now() - 60_000).toISOString();

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx, ['ADMIN']);
    faculty = await createUser(ctx, ['FACULTY']);
    otherFaculty = await createUser(ctx, ['FACULTY']);
    student = await createUser(ctx, ['STUDENT'], { fullName: 'Aman' });
    student2 = await createUser(ctx, ['STUDENT'], { fullName: 'Sara' });
    outsider = await createUser(ctx, ['STUDENT']);
    course = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    await enrol(ctx, student.id, course.batchId);
    await enrol(ctx, student2.id, course.batchId);
  });

  afterAll(() => closeTestApp(ctx));

  const http = () => ctx.http();

  describe('question bank', () => {
    it('lets faculty write single-choice questions', async () => {
      for (const n of [1, 2, 3]) {
        const res = await http()
          .post(api('/questions'))
          .set(bearer(faculty.token))
          .send({
            courseId: course.courseId,
            subjectId: course.subjectId,
            questionText: `Question ${n}?`,
            explanation: `Because ${n}`,
            marksDefault: 4,
            options: [
              { optionLabel: 'a', optionText: 'Right', isCorrect: true },
              { optionLabel: 'B', optionText: 'Wrong', isCorrect: false },
              { optionLabel: 'C', optionText: 'Also wrong', isCorrect: false },
            ],
          })
          .expect(201);
        expect(res.body.question_options[0]).toMatchObject({
          option_label: 'A',
          is_correct: true,
        });
        questionIds.push(res.body.id);
        correctOption[res.body.id] = res.body.question_options.find(
          (o: { is_correct: boolean }) => o.is_correct,
        ).id;
        wrongOption[res.body.id] = res.body.question_options.find(
          (o: { is_correct: boolean }) => !o.is_correct,
        ).id;
      }
    });

    it('rejects questions without exactly one correct option, or outside the course', async () => {
      const base = {
        courseId: course.courseId,
        subjectId: course.subjectId,
        questionText: 'Bad?',
      };
      await http()
        .post(api('/questions'))
        .set(bearer(faculty.token))
        .send({
          ...base,
          options: [
            { optionLabel: 'A', optionText: 'x', isCorrect: true },
            { optionLabel: 'B', optionText: 'y', isCorrect: true },
          ],
        })
        .expect(400);
      await http()
        .post(api('/questions'))
        .set(bearer(faculty.token))
        .send({
          ...base,
          options: [{ optionLabel: 'A', optionText: 'x', isCorrect: true }],
        })
        .expect(400);
      await http()
        .post(api('/questions'))
        .set(bearer(faculty.token))
        .send({
          ...base,
          courseId: 999999,
          options: [
            { optionLabel: 'A', optionText: 'x', isCorrect: true },
            { optionLabel: 'B', optionText: 'y', isCorrect: false },
          ],
        })
        .expect(400);
    });

    it('keeps the bank away from students and other faculty edits', async () => {
      await http()
        .get(api('/questions'))
        .set(bearer(student.token))
        .expect(403);
      await http()
        .patch(api(`/questions/${questionIds[0]}`))
        .set(bearer(otherFaculty.token))
        .send({ difficulty: 'HARD' })
        .expect(403);
      const list = await http()
        .get(api(`/questions?courseId=${course.courseId}`))
        .set(bearer(admin.token))
        .expect(200);
      expect(list.body.meta.total).toBe(3);
    });
  });

  describe('exam setup', () => {
    it('creates an exam and refuses to publish it empty', async () => {
      const res = await http()
        .post(api('/exams'))
        .set(bearer(faculty.token))
        .send({
          courseId: course.courseId,
          title: 'Chapter test',
          kind: 'CHAPTER_TEST',
          durationMinutes: 30,
          negativeMarksPerWrong: 1,
          maxAttempts: 2,
          rankingAttemptPolicy: 'BEST',
          showResultImmediately: false,
        })
        .expect(201);
      examId = res.body.id;
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(faculty.token))
        .send({ status: 'PUBLISHED' })
        .expect(400);
    });

    it('validates the exam window and duration like the CHECK constraints', async () => {
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(faculty.token))
        .send({
          opensAt: '2027-01-10T10:00:00Z',
          closesAt: '2027-01-10T09:00:00Z',
        })
        .expect(400);
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(faculty.token))
        .send({ durationMinutes: 0 })
        .expect(400);
    });

    it('attaches the batch and questions, and totals the marks', async () => {
      await http()
        .put(api(`/exams/${examId}/batches/${course.batchId}`))
        .set(bearer(otherFaculty.token))
        .expect(403);
      await http()
        .put(api(`/exams/${examId}/batches/${course.batchId}`))
        .set(bearer(faculty.token))
        .expect(200);
      for (const id of questionIds) {
        await http()
          .post(api(`/exams/${examId}/questions`))
          .set(bearer(faculty.token))
          .send({ questionId: id })
          .expect(201);
      }
      await http()
        .post(api(`/exams/${examId}/questions`))
        .set(bearer(faculty.token))
        .send({ questionId: questionIds[0] })
        .expect(409);

      const reordered = await http()
        .put(api(`/exams/${examId}/questions/order`))
        .set(bearer(faculty.token))
        .send({ questionIds: [...questionIds].reverse() })
        .expect(200);
      expect(Number(reordered.body.total_marks)).toBe(12);
      expect(
        reordered.body.exam_questions.map(
          (q: { question_id: number }) => q.question_id,
        ),
      ).toEqual([...questionIds].reverse());
      expect(Number(reordered.body.exam_questions[0].negative_marks)).toBe(1);

      // The other faculty member does not teach the batch, so cannot manage the exam now.
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(otherFaculty.token))
        .send({ title: 'Renamed exam' })
        .expect(403);
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(faculty.token))
        .send({ status: 'PUBLISHED' })
        .expect(200);
    });
  });

  describe('taking the exam', () => {
    it('lists the exam for enrolled students only', async () => {
      const mine = await http()
        .get(api('/exams/available'))
        .set(bearer(student.token))
        .expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).toMatchObject({
        id: examId,
        window: 'OPEN',
        attempts_remaining: 2,
      });
      const theirs = await http()
        .get(api('/exams/available'))
        .set(bearer(outsider.token))
        .expect(200);
      expect(theirs.body).toHaveLength(0);
      await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(outsider.token))
        .send({})
        .expect(403);
    });

    it('starts an attempt without revealing the answers', async () => {
      const res = await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student.token))
        .send({})
        .expect(201);
      attemptId = res.body.id;
      expect(res.body).toMatchObject({
        status: 'IN_PROGRESS',
        attempt_number: 1,
      });
      expect(res.body.questions).toHaveLength(3);
      expect(res.body.seconds_remaining).toBeGreaterThan(29 * 60);
      expect(JSON.stringify(res.body)).not.toContain('is_correct');
      expect(JSON.stringify(res.body)).not.toContain('Because');
      await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student.token))
        .send({})
        .expect(409);
    });

    it('saves answers and rejects options of another question', async () => {
      const [q1, q2] = questionIds;
      await http()
        .put(api(`/exam-attempts/${attemptId}/answers/${q1}`))
        .set(bearer(student.token))
        .send({ selectedOptionId: correctOption[q1] })
        .expect(200);
      const saved = await http()
        .put(api(`/exam-attempts/${attemptId}/answers/${q2}`))
        .set(bearer(student.token))
        .send({ selectedOptionId: wrongOption[q2], isMarkedForReview: true })
        .expect(200);
      expect(saved.body).toMatchObject({
        selected_option_id: wrongOption[q2],
        is_marked_for_review: true,
      });
      await http()
        .put(api(`/exam-attempts/${attemptId}/answers/${q1}`))
        .set(bearer(student.token))
        .send({ selectedOptionId: correctOption[q2] })
        .expect(400);
      await http()
        .put(api(`/exam-attempts/${attemptId}/answers/${q1}`))
        .set(bearer(student2.token))
        .send({ selectedOptionId: correctOption[q1] })
        .expect(403);
    });

    it('does not audit-log every answer save', async () => {
      const logged = await ctx.prisma.audit_logs.count({
        where: { action: { contains: 'saveAnswer' } },
      });
      expect(logged).toBe(0);
    });

    it('grades on submit with negative marking, hiding the score until release', async () => {
      const res = await http()
        .post(api(`/exam-attempts/${attemptId}/submit`))
        .set(bearer(student.token))
        .expect(200);
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body).not.toHaveProperty('score');
      expect(res.body.results_visible).toBe(false);
      await http()
        .post(api(`/exam-attempts/${attemptId}/submit`))
        .set(bearer(student.token))
        .expect(409);

      const staff = await http()
        .get(api(`/exams/${examId}/attempts`))
        .set(bearer(faculty.token))
        .expect(200);
      expect(staff.body.data[0]).toMatchObject({
        correct_count: 1,
        wrong_count: 1,
        unanswered_count: 1,
      });
      expect(Number(staff.body.data[0].score)).toBe(3); // +4 -1 +0
      expect(Number(staff.body.data[0].percentage)).toBe(25);
    });

    it('locks questions once students have attempted', async () => {
      await http()
        .delete(api(`/exams/${examId}/questions/${questionIds[0]}`))
        .set(bearer(faculty.token))
        .expect(409);
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(faculty.token))
        .send({ status: 'DRAFT' })
        .expect(409);
      await http()
        .delete(api(`/exams/${examId}`))
        .set(bearer(admin.token))
        .expect(409);
      await http()
        .patch(api(`/questions/${questionIds[0]}`))
        .set(bearer(faculty.token))
        .send({
          options: [
            { optionLabel: 'A', optionText: 'x', isCorrect: true },
            { optionLabel: 'B', optionText: 'y', isCorrect: false },
          ],
        })
        .expect(409);
      await http()
        .patch(api(`/questions/${questionIds[0]}`))
        .set(bearer(faculty.token))
        .send({ isActive: false })
        .expect(200);
    });

    it('auto-submits an attempt whose time ran out', async () => {
      const res = await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student2.token))
        .send({})
        .expect(201);
      const [q1] = questionIds;
      await http()
        .put(api(`/exam-attempts/${res.body.id}/answers/${q1}`))
        .set(bearer(student2.token))
        .send({ selectedOptionId: correctOption[q1] })
        .expect(200);
      await ctx.prisma.exam_attempts.update({
        where: { id: BigInt(res.body.id) },
        data: {
          started_at: new Date(Date.now() - 40 * 60_000),
          expires_at: new Date(Date.now() - 10 * 60_000),
        },
      });
      await http()
        .put(api(`/exam-attempts/${res.body.id}/answers/${q1}`))
        .set(bearer(student2.token))
        .send({ selectedOptionId: null })
        .expect(409);
      const view = await http()
        .get(api(`/exam-attempts/${res.body.id}`))
        .set(bearer(faculty.token))
        .expect(200);
      expect(view.body).toMatchObject({
        status: 'AUTO_SUBMITTED',
        correct_count: 1,
      });
      expect(Number(view.body.score)).toBe(4);
    });

    it('enforces the attempt limit and supports invalidation', async () => {
      const second = await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student.token))
        .send({})
        .expect(201);
      expect(second.body.attempt_number).toBe(2);
      for (const id of questionIds) {
        await http()
          .put(api(`/exam-attempts/${second.body.id}/answers/${id}`))
          .set(bearer(student.token))
          .send({ selectedOptionId: correctOption[id] })
          .expect(200);
      }
      await http()
        .post(api(`/exam-attempts/${second.body.id}/submit`))
        .set(bearer(student.token))
        .expect(200);
      await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student.token))
        .send({})
        .expect(409);

      // Invalidating the first attempt frees one attempt.
      await http()
        .post(api(`/exam-attempts/${attemptId}/invalidate`))
        .set(bearer(student.token))
        .expect(403);
      const inv = await http()
        .post(api(`/exam-attempts/${attemptId}/invalidate`))
        .set(bearer(admin.token))
        .expect(200);
      expect(inv.body.status).toBe('INVALIDATED');
      const available = await http()
        .get(api('/exams/available'))
        .set(bearer(student.token))
        .expect(200);
      expect(available.body[0].attempts_remaining).toBe(1);
    });
  });

  describe('results and ranking', () => {
    it('hides the leaderboard from students until results are released', async () => {
      await http()
        .get(api(`/exams/${examId}/leaderboard`))
        .set(bearer(student.token))
        .expect(403);
      const staff = await http()
        .get(api(`/exams/${examId}/leaderboard`))
        .set(bearer(faculty.token))
        .expect(200);
      // BEST attempt per student: Aman 12 (attempt 2), Sara 4 (auto-submitted).
      expect(
        staff.body.entries.map(
          (e: { full_name: string; score: string; rank: number }) => [
            e.rank,
            e.full_name,
            Number(e.score),
          ],
        ),
      ).toEqual([
        [1, 'Aman', 12],
        [2, 'Sara', 4],
      ]);
    });

    it('releases scores, then answers, on schedule', async () => {
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(admin.token))
        .send({ resultsReleaseAt: past() })
        .expect(200);
      const mine = await http()
        .get(api(`/exam-attempts/me?examId=${examId}`))
        .set(bearer(student.token))
        .expect(200);
      expect(mine.body.map((a: { score: string }) => Number(a.score))).toEqual([
        12, 3,
      ]);

      const attempt = await http()
        .get(api(`/exam-attempts/${attemptId}`))
        .set(bearer(student.token))
        .expect(200);
      expect(attempt.body.results_visible).toBe(true);
      expect(attempt.body.review_visible).toBe(false);
      expect(JSON.stringify(attempt.body.questions)).not.toContain(
        'is_correct',
      );

      const board = await http()
        .get(api(`/exams/${examId}/leaderboard`))
        .set(bearer(student.token))
        .expect(200);
      expect(board.body.entries[0]).not.toHaveProperty('attempt_id');
      await http()
        .get(api(`/exams/${examId}/leaderboard`))
        .set(bearer(outsider.token))
        .expect(403);

      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(admin.token))
        .send({ answerReviewReleaseAt: past() })
        .expect(200);
      const reviewed = await http()
        .get(api(`/exam-attempts/${attemptId}`))
        .set(bearer(student.token))
        .expect(200);
      expect(reviewed.body.review_visible).toBe(true);
      const first = reviewed.body.questions.find(
        (q: { question_id: number }) => q.question_id === questionIds[0],
      );
      expect(first).toMatchObject({
        is_correct: true,
        explanation: 'Because 1',
      });
      expect(Number(first.marks_awarded)).toBe(4);
    });

    it('refuses new attempts once the exam has closed', async () => {
      await http()
        .patch(api(`/exams/${examId}`))
        .set(bearer(admin.token))
        .send({ closesAt: past() })
        .expect(200);
      await http()
        .post(api(`/exams/${examId}/attempts`))
        .set(bearer(student.token))
        .send({})
        .expect(400);
      const available = await http()
        .get(api('/exams/available'))
        .set(bearer(student.token))
        .expect(200);
      expect(available.body).toHaveLength(0);
    });
  });
});
