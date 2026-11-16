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

// The smallest valid PNG (1x1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Pictures in test questions (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const faculty = await createUser(ctx, ['FACULTY']);
    const student = await createUser(ctx, ['STUDENT']);
    const outsider = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      faculty: faculty.token,
      student: student.token,
      outsider: outsider.token,
    });
    const main = await createCourseWithBatch(ctx, { facultyId: faculty.id });
    Object.assign(ids, main);
    await enrol(ctx, student.id, main.batchId);
    await enrol(ctx, outsider.id, main.batchId);
  });

  afterAll(() => closeTestApp(ctx));
  const http = () => ctx.http();
  const upload = async (body: Buffer, name: string) =>
    (
      await http()
        .post(api('/files'))
        .set(bearer(t.faculty))
        .attach('file', body, name)
        .expect(201)
    ).body.id as number;

  it('accepts image-only options and refuses non-image files and empty options', async () => {
    ids.figure = await upload(PNG, 'figure.png');
    ids.optA = await upload(PNG, 'a.png');
    ids.optB = await upload(PNG, 'b.png');
    const text = await upload(Buffer.from('not a picture'), 'notes.txt');
    const base = {
      courseId: ids.courseId,
      subjectId: ids.subjectId,
      questionText: 'Which figure comes next? $x^2$',
      marksDefault: 2,
    };

    await http()
      .post(api('/questions'))
      .set(bearer(t.faculty))
      .send({
        ...base,
        imageAssetId: text,
        options: [
          { optionLabel: 'A', optionText: 'One', isCorrect: true },
          { optionLabel: 'B', optionText: 'Two', isCorrect: false },
        ],
      })
      .expect(400);
    await http()
      .post(api('/questions'))
      .set(bearer(t.faculty))
      .send({
        ...base,
        options: [
          { optionLabel: 'A', optionText: '  ', isCorrect: true },
          { optionLabel: 'B', optionText: 'Two', isCorrect: false },
        ],
      })
      .expect(400);

    const q = await http()
      .post(api('/questions'))
      .set(bearer(t.faculty))
      .send({
        ...base,
        imageAssetId: ids.figure,
        options: [
          { optionLabel: 'A', imageAssetId: ids.optA, isCorrect: true },
          {
            optionLabel: 'B',
            optionText: 'Neither',
            imageAssetId: ids.optB,
            isCorrect: false,
          },
        ],
      })
      .expect(201);
    expect(q.body.image_asset_id).toBe(ids.figure);
    expect(
      q.body.question_options.map(
        (o: { option_text: string; image_asset_id: number }) => [
          o.option_text,
          o.image_asset_id,
        ],
      ),
    ).toEqual([
      ['', ids.optA],
      ['Neither', ids.optB],
    ]);
    ids.question = q.body.id;
  });

  it('lets a student open the pictures only once they are taking the test', async () => {
    const exam = await http()
      .post(api('/exams'))
      .set(bearer(t.faculty))
      .send({
        courseId: ids.courseId,
        title: 'Figures',
        kind: 'CHAPTER_TEST',
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
      .send({ questionId: ids.question })
      .expect(201);
    await http()
      .patch(api(`/exams/${exam.body.id}`))
      .set(bearer(t.faculty))
      .send({ status: 'PUBLISHED' })
      .expect(200);

    // Published but not started: the figure stays hidden.
    await http()
      .get(api(`/files/${ids.figure}/content`))
      .set(bearer(t.student))
      .expect(403);

    const attempt = await http()
      .post(api(`/exams/${exam.body.id}/attempts`))
      .set(bearer(t.student))
      .send({})
      .expect(201);
    const [question] = attempt.body.questions;
    expect(question.image_asset_id).toBe(ids.figure);
    expect(
      question.options.map((o: { image_asset_id: number }) => o.image_asset_id),
    ).toEqual([ids.optA, ids.optB]);

    const figure = await http()
      .get(api(`/files/${ids.figure}/content`))
      .set(bearer(t.student))
      .expect(200);
    expect(figure.headers['content-type']).toBe('image/png');
    await http()
      .get(api(`/files/${ids.optA}/content`))
      .set(bearer(t.student))
      .expect(200);
    // A classmate who hasn't started the test still can't.
    await http()
      .get(api(`/files/${ids.figure}/content`))
      .set(bearer(t.outsider))
      .expect(403);
  });

  it('removes a question picture with null', async () => {
    const res = await http()
      .patch(api(`/questions/${ids.question}`))
      .set(bearer(t.faculty))
      .send({ imageAssetId: null })
      .expect(200);
    expect(res.body.image_asset_id).toBeNull();
  });
});
