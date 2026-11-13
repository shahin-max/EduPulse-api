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

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const at = (offsetMs: number) => new Date(NOW + offsetMs);

describe('Student portal views (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const faculty = await createUser(ctx, ['FACULTY'], {
      fullName: 'Teacher One',
    });
    const student = await createUser(ctx, ['STUDENT']);
    const outsider = await createUser(ctx, ['STUDENT']);
    t.student = student.token;
    t.outsider = outsider.token;
    t.faculty = faculty.token;

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    const other = await createCourseWithBatch(ctx);
    Object.assign(ids, {
      course: main.courseId,
      otherCourse: other.courseId,
      batch: main.batchId,
    });
    const enrollment = BigInt(await enrol(ctx, student.id, main.batchId));
    await enrol(ctx, outsider.id, other.batchId);
    const p = ctx.prisma;
    const batchId = BigInt(main.batchId);

    const overdue = await p.assignments.create({
      data: {
        batch_id: batchId,
        title: 'Overdue',
        status: 'PUBLISHED',
        due_at: at(-DAY),
      },
    });
    const done = await p.assignments.create({
      data: {
        batch_id: batchId,
        title: 'Done',
        status: 'PUBLISHED',
        due_at: at(-2 * DAY),
        max_marks: 10,
      },
    });
    await p.assignments.create({
      data: {
        batch_id: batchId,
        title: 'Upcoming',
        status: 'PUBLISHED',
        due_at: at(2 * DAY),
      },
    });
    await p.assignments.create({
      data: { batch_id: batchId, title: 'Draft', status: 'DRAFT' },
    });
    await p.assignment_submissions.create({
      data: {
        batch_id: batchId,
        assignment_id: done.id,
        enrollment_id: enrollment,
        response_text: 'x',
        submitted_at: at(-3 * DAY),
        reviewed_at: at(-DAY),
        marks_awarded: 8,
      },
    });
    ids.overdue = Number(overdue.id);

    const chapter = await p.chapters.create({
      data: {
        course_subject_id: BigInt(main.courseSubjectId),
        title: 'Motion',
        is_published: true,
      },
    });
    await p.chapters.create({
      data: {
        course_subject_id: BigInt(main.courseSubjectId),
        title: 'Hidden chapter',
        is_published: false,
      },
    });
    const notes = await p.study_materials.create({
      data: {
        chapter_id: chapter.id,
        title: 'Notes',
        kind: 'PDF_NOTE',
        is_published: true,
        external_url: 'https://example.com/a',
      },
    });
    await p.study_materials.create({
      data: {
        chapter_id: chapter.id,
        title: 'Video',
        kind: 'VIDEO_LINK',
        is_published: true,
        external_url: 'https://example.com/v',
        sort_order: 1,
      },
    });
    await p.study_materials.create({
      data: {
        chapter_id: chapter.id,
        title: 'Unpublished',
        kind: 'OTHER',
        is_published: false,
        external_url: 'https://example.com/u',
      },
    });
    await p.material_progress.create({
      data: {
        enrollment_id: enrollment,
        material_id: notes.id,
        status: 'COMPLETED',
        completed_at: at(-DAY),
      },
    });
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();

  it('lists current courses with teachers and material progress', async () => {
    const res = await http()
      .get(api('/student/courses'))
      .set(bearer(t.student))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      batch: { id: ids.batch, courses: { id: ids.course } },
      teachers: [expect.objectContaining({ full_name: 'Teacher One' })],
      materials: { total: 2, completed: 1 },
    });
  });

  it('lists assignments across batches with a state, hiding drafts', async () => {
    const res = await http()
      .get(api('/student/assignments'))
      .set(bearer(t.student))
      .expect(200);
    expect(
      res.body.map((a: { title: string; state: string }) => [a.title, a.state]),
    ).toEqual([
      ['Done', 'REVIEWED'],
      ['Overdue', 'MISSING'],
      ['Upcoming', 'NOT_DUE'],
    ]);
    expect(res.body[0].my_submission).toMatchObject({
      marks_awarded: '8',
      is_late: false,
    });
    const other = await http()
      .get(api('/student/assignments'))
      .set(bearer(t.outsider))
      .expect(200);
    expect(other.body).toEqual([]);
  });

  it("returns a course's published materials with progress", async () => {
    const res = await http()
      .get(api(`/student/courses/${ids.course}/materials`))
      .set(bearer(t.student))
      .expect(200);
    expect(res.body.course.id).toBe(ids.course);
    expect(res.body.subjects).toHaveLength(1);
    const [chapter] = res.body.subjects[0].chapters;
    expect(chapter.title).toBe('Motion');
    expect(
      chapter.materials.map((m: { title: string; progress: string }) => [
        m.title,
        m.progress,
      ]),
    ).toEqual([
      ['Notes', 'COMPLETED'],
      ['Video', 'NOT_STARTED'],
    ]);
    await http()
      .get(api(`/student/courses/${ids.otherCourse}/materials`))
      .set(bearer(t.student))
      .expect(403);
  });

  it('is for students only', async () => {
    await http()
      .get(api('/student/courses'))
      .set(bearer(t.faculty))
      .expect(403);
    await http().get(api('/student/assignments')).expect(401);
  });
});
