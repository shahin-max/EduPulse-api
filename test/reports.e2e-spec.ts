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

describe('Teaching reports and profile photos (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const faculty = await createUser(ctx, ['FACULTY']);
    const outsider = await createUser(ctx, ['FACULTY']);
    const amy = await createUser(ctx, ['STUDENT'], { fullName: 'Amy Student' });
    const ben = await createUser(ctx, ['STUDENT'], { fullName: 'Ben Student' });
    const stranger = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      faculty: faculty.token,
      outsider: outsider.token,
      amy: amy.token,
    });
    Object.assign(ids, { faculty: faculty.id, amy: amy.id, ben: ben.id, stranger: stranger.id });

    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    Object.assign(ids, main);
    const amyEnrollment = BigInt(await enrol(ctx, amy.id, main.batchId));
    const benEnrollment = BigInt(await enrol(ctx, ben.id, main.batchId));
    const batchId = BigInt(main.batchId);
    const p = ctx.prisma;

    // Two past classes (one marked, one not) and one future class.
    const marked = await p.class_sessions.create({
      data: { batch_id: batchId, faculty_user_id: BigInt(faculty.id), title: 'Kinematics', starts_at: at(-2 * DAY), ends_at: at(-2 * DAY + HOUR) },
    });
    await p.class_attendance.createMany({
      data: [
        { batch_id: batchId, class_session_id: marked.id, enrollment_id: amyEnrollment, status: 'PRESENT' },
        { batch_id: batchId, class_session_id: marked.id, enrollment_id: benEnrollment, status: 'ABSENT' },
      ],
    });
    await p.class_sessions.create({
      data: { batch_id: batchId, faculty_user_id: BigInt(faculty.id), title: 'Vectors', starts_at: at(-DAY), ends_at: at(-DAY + HOUR) },
    });
    await p.class_sessions.create({
      data: { batch_id: batchId, title: 'Laws of motion', starts_at: at(DAY), ends_at: at(DAY + HOUR) },
    });

    // A past assignment Amy submitted (not yet reviewed), and one due in three days.
    const past = await p.assignments.create({
      data: { batch_id: batchId, title: 'Worksheet 1', status: 'PUBLISHED', due_at: at(-DAY), max_marks: 10 },
    });
    await p.assignment_submissions.create({
      data: { batch_id: batchId, assignment_id: past.id, enrollment_id: amyEnrollment, response_text: 'Done', submitted_at: at(-2 * DAY) },
    });
    const dueSoon = await p.assignments.create({
      data: { batch_id: batchId, title: 'Worksheet 2', status: 'PUBLISHED', due_at: at(3 * DAY) },
    });
    Object.assign(ids, { past: Number(past.id), dueSoon: Number(dueSoon.id) });

    // A published exam with two graded attempts by Amy (best is 80%).
    const exam = await p.exams.create({
      data: { course_id: BigInt(main.courseId), title: 'Unit test', kind: 'CHAPTER_TEST', duration_minutes: 30, total_marks: 20, max_attempts: 2, status: 'PUBLISHED' },
    });
    await p.exam_batches.create({ data: { exam_id: exam.id, batch_id: batchId } });
    for (const [n, score] of [[1, 10], [2, 16]] as const) {
      await p.exam_attempts.create({
        data: {
          batch_id: batchId, exam_id: exam.id, enrollment_id: amyEnrollment, attempt_number: n,
          started_at: at(-3 * HOUR), expires_at: at(-HOUR), submitted_at: at(-2 * HOUR), status: 'SUBMITTED',
          score, max_score: 20, percentage: (score / 20) * 100,
        },
      });
    }
    ids.exam = Number(exam.id);

    // One published material, completed by Amy.
    const chapter = await p.chapters.create({
      data: { course_subject_id: BigInt(main.courseSubjectId), title: 'Chapter 1', is_published: true },
    });
    const material = await p.study_materials.create({
      data: { chapter_id: chapter.id, title: 'Notes', kind: 'OTHER', is_published: true, external_url: 'https://example.com/notes' },
    });
    await p.material_progress.create({
      data: { enrollment_id: amyEnrollment, material_id: material.id, status: 'COMPLETED', completed_at: at(-HOUR) },
    });

    await p.admission_enquiries.create({
      data: { student_name: 'Walk-in', mobile: '+919876543210', assigned_to: BigInt(faculty.id), status: 'NEW' },
    });
  });

  afterAll(() => closeTestApp(ctx));

  const http = () => ctx.http();

  it('builds the batch gradebook for the assigned faculty', async () => {
    const res = await http().get(api(`/batches/${ids.batchId}/gradebook`)).set(bearer(t.faculty)).expect(200);
    expect(res.body.sessions_held).toBe(2);
    expect(res.body.materials_total).toBe(1);
    expect(res.body.assignments.map((a: { id: number }) => a.id)).toEqual([ids.past, ids.dueSoon]);
    expect(res.body.students.map((s: { full_name: string }) => s.full_name)).toEqual(['Amy Student', 'Ben Student']);

    const [amy, ben] = res.body.students;
    expect(amy.attendance).toMatchObject({ present: 1, absent: 0, percentage: 100 });
    expect(ben.attendance).toMatchObject({ present: 0, absent: 1, percentage: 0 });
    expect(amy.assignments[ids.past]).toEqual({ state: 'SUBMITTED', marks: null });
    expect(ben.assignments[ids.past].state).toBe('MISSING');
    expect(ben.assignments[ids.dueSoon].state).toBe('NOT_DUE');
    expect(amy.exams[ids.exam]).toMatchObject({ attempts: 2, score: '16', percentage: '80' });
    expect(ben.exams[ids.exam]).toMatchObject({ attempts: 0, score: null });
    expect(amy.materials_completed).toBe(1);
    expect(ben.materials_completed).toBe(0);
  });

  it('keeps the gradebook to the batch faculty and admins', async () => {
    await http().get(api(`/batches/${ids.batchId}/gradebook`)).set(bearer(t.admin)).expect(200);
    await http().get(api(`/batches/${ids.batchId}/gradebook`)).set(bearer(t.outsider)).expect(403);
    await http().get(api(`/batches/${ids.batchId}/gradebook`)).set(bearer(t.amy)).expect(403);
    await http().get(api('/batches/999999/gradebook')).set(bearer(t.admin)).expect(404);
  });

  it("reports one student's progress", async () => {
    const res = await http().get(api(`/batches/${ids.batchId}/students/${ids.amy}/report`)).set(bearer(t.faculty)).expect(200);
    expect(res.body.student.users.full_name).toBe('Amy Student');
    expect(res.body.attendance.percentage).toBe(100);
    // Newest first; the unmarked class has no status.
    expect(res.body.attendance.sessions.map((s: { title: string; attendance: string | null }) => [s.title, s.attendance]))
      .toEqual([['Vectors', null], ['Kinematics', 'PRESENT']]);
    const past = res.body.assignments.find((a: { id: number }) => a.id === ids.past);
    expect(past.state).toBe('SUBMITTED');
    expect(past.submission.response_text).toBeUndefined();
    expect(res.body.exams[0].attempts).toHaveLength(2);
    expect(res.body.exams[0].best.percentage).toBe('80');
    expect(res.body.materials).toEqual({ total: 1, completed: 1, in_progress: 0 });

    await http().get(api(`/batches/${ids.batchId}/students/${ids.stranger}/report`)).set(bearer(t.faculty)).expect(404);
    await http().get(api(`/batches/${ids.batchId}/students/${ids.amy}/report`)).set(bearer(t.outsider)).expect(403);
  });

  it("shows faculty the work waiting for them", async () => {
    const res = await http().get(api('/teaching/dashboard')).set(bearer(t.faculty)).expect(200);
    expect(res.body.to_review.total).toBe(1);
    expect(res.body.to_review.items[0]).toMatchObject({ assignment: { id: ids.past }, student: { full_name: 'Amy Student' } });
    expect(res.body.attendance_pending.total).toBe(1);
    expect(res.body.attendance_pending.items[0].title).toBe('Vectors');
    expect(res.body.due_soon).toEqual([expect.objectContaining({ id: ids.dueSoon, submitted: 0, enrolled: 2 })]);
    expect(res.body.upcoming_exams.map((e: { id: number }) => e.id)).toEqual([ids.exam]);
    expect(res.body.enquiries).toEqual({ new: 1, follow_up: 0 });

    const other = await http().get(api('/teaching/dashboard')).set(bearer(t.outsider)).expect(200);
    expect(other.body.to_review.total).toBe(0);
    expect(other.body.upcoming_exams).toEqual([]);
    await http().get(api('/teaching/dashboard')).set(bearer(t.amy)).expect(403);
  });

  it('returns photo_url on the account and refuses photos while Cloudinary is not configured', async () => {
    const me = await http().get(api('/auth/me')).set(bearer(t.amy)).expect(200);
    expect(me.body).toHaveProperty('photo_url', null);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await http().put(api('/me/photo')).set(bearer(t.amy)).attach('photo', png, 'me.png').expect(503);
    await http().put(api(`/users/${ids.amy}/photo`)).set(bearer(t.faculty)).attach('photo', png, 'me.png').expect(403);
    const removed = await http().delete(api('/me/photo')).set(bearer(t.amy)).expect(200);
    expect(removed.body.photo_url).toBeNull();
  });
});
