import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  api,
  bearer,
  closeTestApp,
  createCourseWithBatch,
  createTestApp,
  createUser,
  enrol,
  type TestContext,
} from './helpers.js';

type U = Awaited<ReturnType<typeof createUser>>;

/** Files, study materials, progress, assignments and submissions, end to end. */
describe('Learning (e2e)', () => {
  let ctx: TestContext;
  let admin: U, faculty: U, outsiderFaculty: U, student: U, outsider: U;
  let ids: {
    courseId: number;
    subjectId: number;
    courseSubjectId: number;
    batchId: number;
  };
  let chapterId: number;
  let draftChapterId: number;
  const state: Record<string, number> = {};

  const upload = (
    token: string,
    name: string,
    content: string,
    visibility?: string,
    type = 'application/pdf',
  ) => {
    const req = ctx
      .http()
      .post(api('/files'))
      .set(bearer(token))
      .attach('file', Buffer.from(content), {
        filename: name,
        contentType: type,
      });
    return visibility ? req.field('visibility', visibility) : req;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx, ['ADMIN']);
    faculty = await createUser(ctx, ['FACULTY']);
    outsiderFaculty = await createUser(ctx, ['FACULTY']);
    student = await createUser(ctx, ['STUDENT']);
    outsider = await createUser(ctx, ['STUDENT']);
    ids = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    await enrol(ctx, student.id, ids.batchId);
    chapterId = Number(
      (
        await ctx.prisma.chapters.create({
          data: {
            course_subject_id: BigInt(ids.courseSubjectId),
            title: 'Kinematics',
            is_published: true,
          },
        })
      ).id,
    );
    draftChapterId = Number(
      (
        await ctx.prisma.chapters.create({
          data: {
            course_subject_id: BigInt(ids.courseSubjectId),
            title: 'Draft chapter',
          },
        })
      ).id,
    );
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('files', () => {
    it('stores an upload on disk under yyyy/mm with a safe key', async () => {
      const res = await upload(
        faculty.token,
        '../../notes.pdf',
        'PDF-CONTENT-1',
        'PRIVATE',
      ).expect(201);
      expect(res.body).toMatchObject({
        bucket: 'local',
        visibility: 'PRIVATE',
        original_filename: 'notes.pdf',
        size_bytes: 13,
      });
      expect(res.body.object_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
      const root = resolve(process.env.UPLOAD_DIR ?? './uploads');
      expect(statSync(join(root, res.body.object_key)).size).toBe(13);
      state.privateFile = res.body.id;
    });

    it('rejects uploads without a file, and PUBLIC uploads by students', async () => {
      await ctx
        .http()
        .post(api('/files'))
        .set(bearer(faculty.token))
        .field('visibility', 'PRIVATE')
        .expect(400);
      await upload(student.token, 'x.png', 'img', 'PUBLIC', 'image/png').expect(
        403,
      );
      await upload(faculty.token, 'x.pdf', 'x', 'SECRET').expect(400);
      await ctx
        .http()
        .post(api('/files'))
        .attach('file', Buffer.from('x'), 'x.txt')
        .expect(401);
    });

    it('serves PUBLIC files to anyone and inline for images', async () => {
      const res = await upload(
        admin.token,
        'logo.png',
        'PNGDATA',
        'PUBLIC',
        'image/png',
      ).expect(201);
      state.publicFile = res.body.id;
      const content = await ctx
        .http()
        .get(api(`/files/${state.publicFile}/content`))
        .expect(200);
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.headers['content-disposition']).toMatch(/^inline/);
      expect(content.body.toString()).toBe('PNGDATA');
    });

    it('guards PRIVATE files', async () => {
      await ctx
        .http()
        .get(api(`/files/${state.privateFile}/content`))
        .expect(401);
      await ctx
        .http()
        .get(api(`/files/${state.privateFile}`))
        .set(bearer(outsider.token))
        .expect(403);
      const res = await ctx
        .http()
        .get(api(`/files/${state.privateFile}/content`))
        .set(bearer(admin.token))
        .expect(200);
      expect(res.body.toString()).toBe('PDF-CONTENT-1');
    });

    it('downloads non-image types as attachments', async () => {
      const res = await upload(
        faculty.token,
        'page.html',
        '<script>x</script>',
        'PUBLIC',
        'text/html',
      ).expect(201);
      const content = await ctx
        .http()
        .get(api(`/files/${res.body.id}/content`))
        .expect(200);
      expect(content.headers['content-type']).toMatch(
        /application\/octet-stream/,
      );
      expect(content.headers['content-disposition']).toMatch(/^attachment/);
      await ctx
        .http()
        .delete(api(`/files/${res.body.id}`))
        .set(bearer(outsiderFaculty.token))
        .expect(403);
      await ctx
        .http()
        .delete(api(`/files/${res.body.id}`))
        .set(bearer(faculty.token))
        .expect(204);
      await ctx
        .http()
        .get(api(`/files/${res.body.id}`))
        .expect(404);
    });
  });

  describe('study materials', () => {
    it('requires a file or a link', async () => {
      await ctx
        .http()
        .post(api('/study-materials'))
        .set(bearer(faculty.token))
        .send({ chapterId, title: 'Nothing', kind: 'PDF_NOTE' })
        .expect(400);
      await ctx
        .http()
        .post(api('/study-materials'))
        .set(bearer(student.token))
        .send({
          chapterId,
          title: 'x',
          kind: 'OTHER',
          externalUrl: 'https://a.b',
        })
        .expect(403);
    });

    it('lets faculty add published and draft materials', async () => {
      const notes = await ctx
        .http()
        .post(api('/study-materials'))
        .set(bearer(faculty.token))
        .send({
          chapterId,
          title: 'Class notes',
          kind: 'PDF_NOTE',
          assetId: state.privateFile,
          isPublished: true,
        })
        .expect(201);
      state.material = notes.body.id;
      const video = await ctx
        .http()
        .post(api('/study-materials'))
        .set(bearer(faculty.token))
        .send({
          chapterId,
          title: 'Lecture video',
          kind: 'VIDEO_LINK',
          externalUrl: 'https://youtu.be/abc',
        })
        .expect(201);
      state.draftMaterial = video.body.id;
      await ctx
        .http()
        .patch(api(`/study-materials/${state.draftMaterial}`))
        .set(bearer(faculty.token))
        .send({ externalUrl: null })
        .expect(400);
    });

    it('shows students only published materials of enrolled courses', async () => {
      const staffView = await ctx
        .http()
        .get(api(`/study-materials?chapterId=${chapterId}`))
        .set(bearer(outsiderFaculty.token))
        .expect(200);
      expect(staffView.body).toHaveLength(2);
      const studentView = await ctx
        .http()
        .get(api(`/study-materials?chapterId=${chapterId}`))
        .set(bearer(student.token))
        .expect(200);
      expect(studentView.body.map((m: { id: number }) => m.id)).toEqual([
        state.material,
      ]);
      await ctx
        .http()
        .get(api(`/study-materials?chapterId=${chapterId}`))
        .set(bearer(outsider.token))
        .expect(403);
      await ctx
        .http()
        .get(api(`/study-materials?chapterId=${draftChapterId}`))
        .set(bearer(student.token))
        .expect(404);
      await ctx
        .http()
        .get(api(`/study-materials/${state.draftMaterial}`))
        .set(bearer(student.token))
        .expect(404);
    });

    it('opens the material file to enrolled students only', async () => {
      const res = await ctx
        .http()
        .get(api(`/files/${state.privateFile}/content`))
        .set(bearer(student.token))
        .expect(200);
      expect(res.body.toString()).toBe('PDF-CONTENT-1');
      await ctx
        .http()
        .get(api(`/files/${state.privateFile}/content`))
        .set(bearer(outsider.token))
        .expect(403);
    });

    it('records progress and shows it to the student and the batch faculty', async () => {
      const done = await ctx
        .http()
        .put(api(`/study-materials/${state.material}/progress`))
        .set(bearer(student.token))
        .send({ status: 'COMPLETED' })
        .expect(200);
      expect(done.body.completed_at).toBeTruthy();
      await ctx
        .http()
        .put(api(`/study-materials/${state.material}/progress`))
        .set(bearer(outsider.token))
        .send({ status: 'IN_PROGRESS' })
        .expect(403);
      await ctx
        .http()
        .put(api(`/study-materials/${state.draftMaterial}/progress`))
        .set(bearer(student.token))
        .send({ status: 'IN_PROGRESS' })
        .expect(404);

      const mine = await ctx
        .http()
        .get(api('/study-materials/progress/me'))
        .set(bearer(student.token))
        .expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).toMatchObject({
        status: 'COMPLETED',
        study_materials: { id: state.material },
      });

      const batch = await ctx
        .http()
        .get(api(`/study-materials/progress?batchId=${ids.batchId}`))
        .set(bearer(faculty.token))
        .expect(200);
      expect(batch.body.meta.total).toBe(1);
      await ctx
        .http()
        .get(api(`/study-materials/progress?batchId=${ids.batchId}`))
        .set(bearer(outsiderFaculty.token))
        .expect(403);
    });

    it('refuses to delete a file a material still uses', async () => {
      await ctx
        .http()
        .delete(api(`/files/${state.privateFile}`))
        .set(bearer(faculty.token))
        .expect(409);
    });
  });

  describe('assignments', () => {
    it('lets only the batch faculty create assignments, for the course subjects', async () => {
      const base = { batchId: ids.batchId, title: 'Worksheet 1' };
      await ctx
        .http()
        .post(api('/assignments'))
        .set(bearer(outsiderFaculty.token))
        .send(base)
        .expect(403);
      const otherSubject = await ctx.prisma.subjects.create({
        data: { code: `OTHER${Date.now() % 100000}`, name: 'Other' },
      });
      await ctx
        .http()
        .post(api('/assignments'))
        .set(bearer(faculty.token))
        .send({ ...base, subjectId: Number(otherSubject.id) })
        .expect(400);
      await ctx
        .http()
        .post(api('/assignments'))
        .set(bearer(faculty.token))
        .send({ ...base, maxMarks: 1.234 })
        .expect(400);

      const published = await ctx
        .http()
        .post(api('/assignments'))
        .set(bearer(faculty.token))
        .send({
          ...base,
          subjectId: ids.subjectId,
          maxMarks: 10,
          status: 'PUBLISHED',
          dueAt: new Date(Date.now() - 3600_000).toISOString(),
        })
        .expect(201);
      expect(published.body.max_marks).toBe('10');
      state.assignment = published.body.id;
      const draft = await ctx
        .http()
        .post(api('/assignments'))
        .set(bearer(faculty.token))
        .send({ ...base, title: 'Draft' })
        .expect(201);
      state.draftAssignment = draft.body.id;
    });

    it('shows students published assignments of their batch only', async () => {
      const list = await ctx
        .http()
        .get(api(`/assignments?batchId=${ids.batchId}`))
        .set(bearer(student.token))
        .expect(200);
      expect(list.body.map((a: { id: number }) => a.id)).toEqual([
        state.assignment,
      ]);
      expect(list.body[0].my_submission).toBeNull();
      await ctx
        .http()
        .get(api(`/assignments?batchId=${ids.batchId}`))
        .set(bearer(outsider.token))
        .expect(403);
      await ctx
        .http()
        .get(api(`/assignments/${state.draftAssignment}`))
        .set(bearer(student.token))
        .expect(404);
      const staff = await ctx
        .http()
        .get(api(`/assignments?batchId=${ids.batchId}`))
        .set(bearer(faculty.token))
        .expect(200);
      expect(staff.body).toHaveLength(2);
    });

    it('validates submissions', async () => {
      await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .send({})
        .expect(400);
      // Someone else's file must not be attachable (it would leak access to it).
      await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .send({ assetId: state.privateFile })
        .expect(400);
      await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(outsider.token))
        .send({ responseText: 'hi' })
        .expect(403);
      await ctx
        .http()
        .put(api(`/assignments/${state.draftAssignment}/submission`))
        .set(bearer(student.token))
        .send({ responseText: 'hi' })
        .expect(404);
    });

    it("accepts a late submission with the student's own file, flags it, and allows resubmission", async () => {
      const file = await upload(
        student.token,
        'answer.pdf',
        'MY-ANSWER',
      ).expect(201);
      state.studentFile = file.body.id;
      const first = await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .send({ assetId: state.studentFile })
        .expect(200);
      expect(first.body).toMatchObject({
        is_late: true,
        asset_id: state.studentFile,
      });
      const again = await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .send({ responseText: 'Typed answer', assetId: state.studentFile })
        .expect(200);
      expect(again.body.id).toBe(first.body.id);
      state.submission = again.body.id;

      await ctx
        .http()
        .get(api(`/files/${state.studentFile}/content`))
        .set(bearer(faculty.token))
        .expect(200);
      await ctx
        .http()
        .get(api(`/files/${state.studentFile}/content`))
        .set(bearer(outsider.token))
        .expect(403);
    });

    it('lets the batch faculty review, keeping marks within maxMarks', async () => {
      const list = await ctx
        .http()
        .get(api(`/assignments/${state.assignment}/submissions`))
        .set(bearer(faculty.token))
        .expect(200);
      expect(list.body).toHaveLength(1);
      await ctx
        .http()
        .get(api(`/assignments/${state.assignment}/submissions`))
        .set(bearer(student.token))
        .expect(403);

      await ctx
        .http()
        .patch(api(`/assignment-submissions/${state.submission}/review`))
        .set(bearer(faculty.token))
        .send({ marksAwarded: 11 })
        .expect(400);
      await ctx
        .http()
        .patch(api(`/assignment-submissions/${state.submission}/review`))
        .set(bearer(outsiderFaculty.token))
        .send({ marksAwarded: 5 })
        .expect(403);
      const reviewed = await ctx
        .http()
        .patch(api(`/assignment-submissions/${state.submission}/review`))
        .set(bearer(faculty.token))
        .send({ marksAwarded: 8.5, feedback: 'Good work' })
        .expect(200);
      expect(reviewed.body).toMatchObject({
        marks_awarded: '8.5',
        feedback: 'Good work',
        reviewed_by: faculty.id,
      });
    });

    it('shows the student their reviewed work and blocks resubmission', async () => {
      const mine = await ctx
        .http()
        .get(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .expect(200);
      expect(mine.body).toMatchObject({
        marks_awarded: '8.5',
        feedback: 'Good work',
      });
      await ctx
        .http()
        .put(api(`/assignments/${state.assignment}/submission`))
        .set(bearer(student.token))
        .send({ responseText: 'v3' })
        .expect(409);
    });

    it('stops lowering maxMarks below awarded marks, and closing stops submissions', async () => {
      await ctx
        .http()
        .patch(api(`/assignments/${state.assignment}`))
        .set(bearer(faculty.token))
        .send({ maxMarks: 5 })
        .expect(400);
      await ctx
        .http()
        .patch(api(`/assignments/${state.draftAssignment}`))
        .set(bearer(faculty.token))
        .send({ status: 'CLOSED' })
        .expect(200);
      await ctx
        .http()
        .put(api(`/assignments/${state.draftAssignment}/submission`))
        .set(bearer(student.token))
        .send({ responseText: 'x' })
        .expect(400);
    });

    it('refuses to delete an assignment with submissions, but deletes an empty one', async () => {
      await ctx
        .http()
        .delete(api(`/assignments/${state.assignment}`))
        .set(bearer(faculty.token))
        .expect(409);
      await ctx
        .http()
        .delete(api(`/assignments/${state.draftAssignment}`))
        .set(bearer(faculty.token))
        .expect(204);
    });
  });

  it('keeps every stored object inside the upload directory', () => {
    const root = resolve(process.env.UPLOAD_DIR ?? './uploads');
    const years = readdirSync(root);
    expect(years.every((y) => /^\d{4}$/.test(y))).toBe(true);
  });
});
