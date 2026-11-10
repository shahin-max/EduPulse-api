import {
  api,
  bearer,
  closeTestApp,
  createTestApp,
  createUser,
  type TestContext,
} from './helpers.js';

/**
 * Accounts, roles, sessions, catalog, batches, enrollments, enquiries, website content
 * and the audit log, end to end against a real MySQL test database. Tests build on each other.
 */
describe('Foundation (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const t: Record<string, string> = {};
  const id: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    t.admin = (
      await createUser(ctx, ['ADMIN'], { email: 'admin@test.local' })
    ).token;
  });

  afterAll(async () => closeTestApp(ctx));

  describe('platform', () => {
    it('reports health and serves the OpenAPI document', async () => {
      await http().get(api('/health')).expect(200);
      const doc = await http().get('/docs-json').expect(200);
      expect(doc.body.paths).toHaveProperty('/api/v1/auth/login');
      expect(doc.body.paths).toHaveProperty('/api/v1/batches/{id}/faculty');
    });

    it('requires a token on protected routes', async () => {
      await http().get(api('/auth/me')).expect(401);
      await http().get(api('/users')).set(bearer('x.y.z')).expect(401);
    });
  });

  describe('accounts', () => {
    it('lets a student register by mobile only and serialises bigint ids as numbers', async () => {
      await http()
        .post(api('/auth/register'))
        .send({ fullName: 'No Contact', password: 'Secret123' })
        .expect(400);
      await http()
        .post(api('/auth/register'))
        .send({
          fullName: 'Sneaky',
          mobile: '9000000001',
          password: 'Secret123',
          roles: ['ADMIN'],
        })
        .expect(400);

      const res = await http()
        .post(api('/auth/register'))
        .send({
          fullName: 'Aman Khan',
          mobile: '+91 98765 43210',
          password: 'Secret123',
          grade: '11',
          guardianName: 'Imran Khan',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        mobile: '+919876543210',
        roles: ['STUDENT'],
        status: 'ACTIVE',
      });
      expect(typeof res.body.user.id).toBe('number');
      expect(res.body.user).not.toHaveProperty('password_hash');
      id.student = res.body.user.id;
      t.student = res.body.accessToken;
      t.studentRefresh = res.body.refreshToken;

      const me = await http()
        .get(api('/auth/me'))
        .set(bearer(t.student))
        .expect(200);
      expect(me.body.student_profiles).toMatchObject({
        grade: '11',
        guardian_name: 'Imran Khan',
      });
    });

    it('logs in with the mobile number written differently', async () => {
      const res = await http()
        .post(api('/auth/login'))
        .send({ login: '+919876543210', password: 'Secret123' })
        .expect(200);
      expect(res.body.user.id).toBe(id.student);
      await http()
        .post(api('/auth/login'))
        .send({ login: '+919876543210', password: 'wrong' })
        .expect(401);
    });

    it('lets an admin create a multi-role user and invite one without a password', async () => {
      const both = await http()
        .post(api('/users'))
        .set(bearer(t.admin))
        .send({
          fullName: 'Dr Rehana',
          email: 'rehana@test.local',
          password: 'Passw0rd!',
          roles: ['FACULTY', 'ADMIN'],
        })
        .expect(201);
      expect(both.body.roles.sort()).toEqual(['ADMIN', 'FACULTY']);
      expect(both.body.faculty_profiles).toBeTruthy();

      const invited = await http()
        .post(api('/users'))
        .set(bearer(t.admin))
        .send({
          fullName: 'Mr Faisal',
          email: 'faisal@test.local',
          roles: ['FACULTY'],
        })
        .expect(201);
      expect(invited.body.status).toBe('PENDING');
      expect(invited.body.setupToken).toMatch(/^[0-9a-f]{64}$/);
      id.faculty = invited.body.id;

      await http()
        .post(api('/auth/login'))
        .send({ login: 'faisal@test.local', password: 'Anything1' })
        .expect(401);
      await http()
        .post(api('/auth/password/reset'))
        .send({ token: invited.body.setupToken, newPassword: 'Faisal123' })
        .expect(204);
      await http()
        .post(api('/auth/password/reset'))
        .send({ token: invited.body.setupToken, newPassword: 'Again1234' })
        .expect(400);
      const login = await http()
        .post(api('/auth/login'))
        .send({ login: 'faisal@test.local', password: 'Faisal123' })
        .expect(200);
      expect(login.body.user.status).toBe('ACTIVE');
      t.faculty = login.body.accessToken;
    });

    it('rejects duplicate contacts and enforces roles', async () => {
      await http()
        .post(api('/users'))
        .set(bearer(t.admin))
        .send({ fullName: 'Dup', mobile: '+91 9876543210', roles: ['STUDENT'] })
        .expect(409);
      await http().get(api('/users')).set(bearer(t.faculty)).expect(403);
      await http().get(api('/users')).set(bearer(t.student)).expect(403);
      const list = await http()
        .get(api('/users?role=FACULTY'))
        .set(bearer(t.admin))
        .expect(200);
      expect(list.body.meta.total).toBe(2);
    });

    it('runs the forgot-password flow without revealing whether an account exists', async () => {
      const unknown = await http()
        .post(api('/auth/password/forgot'))
        .send({ login: 'nobody@test.local' })
        .expect(202);
      expect(unknown.body.devToken).toBeUndefined();
      const known = await http()
        .post(api('/auth/password/forgot'))
        .send({ login: '9876543210' })
        .expect(202);
      expect(known.body.message).toBe(unknown.body.message);
      // EXPOSE_DEV_TOKENS=true in .env.test returns the token so the flow can be tested.
      expect(known.body.devToken).toMatch(/^[0-9a-f]{64}$/);
      await http()
        .post(api('/auth/password/reset'))
        .send({ token: known.body.devToken, newPassword: 'Changed123' })
        .expect(204);
      // Reset ends every session.
      await http().get(api('/auth/me')).set(bearer(t.student)).expect(401);
      t.student = (
        await http()
          .post(api('/auth/login'))
          .send({ login: '9876543210', password: 'Changed123' })
          .expect(200)
      ).body.accessToken;
    });

    it('verifies a mobile number', async () => {
      const req = await http()
        .post(api('/auth/verify/request'))
        .set(bearer(t.student))
        .send({ channel: 'MOBILE' })
        .expect(202);
      await http()
        .post(api('/auth/verify/request'))
        .set(bearer(t.student))
        .send({ channel: 'EMAIL' })
        .expect(400);
      const res = await http()
        .post(api('/auth/verify/confirm'))
        .send({ token: req.body.devToken })
        .expect(200);
      expect(res.body.mobile_verified_at).toBeTruthy();
    });

    it('rotates refresh tokens and revokes the session on reuse', async () => {
      const session = await http()
        .post(api('/auth/login'))
        .send({ login: 'rehana@test.local', password: 'Passw0rd!' })
        .expect(200);
      const next = await http()
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.body.refreshToken })
        .expect(200);
      await http()
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.body.refreshToken })
        .expect(401);
      await http()
        .post(api('/auth/refresh'))
        .send({ refreshToken: next.body.refreshToken })
        .expect(401);
      await http()
        .get(api('/auth/me'))
        .set(bearer(next.body.accessToken))
        .expect(401);
    });

    it('applies suspension and role changes immediately', async () => {
      const temp = await createUser(ctx, ['STUDENT']);
      await http()
        .patch(api(`/users/${temp.id}`))
        .set(bearer(t.admin))
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await http().get(api('/auth/me')).set(bearer(temp.token)).expect(401);
      await http()
        .post(api('/auth/login'))
        .send({ login: temp.email, password: temp.password })
        .expect(403);

      const other = await createUser(ctx, ['STUDENT']);
      await http()
        .get(api('/students/me'))
        .set(bearer(other.token))
        .expect(200);
      await http()
        .put(api(`/users/${other.id}/roles`))
        .set(bearer(t.admin))
        .send({ roles: ['FACULTY'] })
        .expect(200);
      await http()
        .get(api('/students/me'))
        .set(bearer(other.token))
        .expect(403);
      await http().get(api('/faculty/me')).set(bearer(other.token)).expect(200);
    });

    it('stops admins from locking themselves out', async () => {
      const me = await http()
        .get(api('/auth/me'))
        .set(bearer(t.admin))
        .expect(200);
      await http()
        .patch(api(`/users/${me.body.id}`))
        .set(bearer(t.admin))
        .send({ status: 'DISABLED' })
        .expect(400);
      await http()
        .put(api(`/users/${me.body.id}/roles`))
        .set(bearer(t.admin))
        .send({ roles: ['FACULTY'] })
        .expect(400);
      await http()
        .delete(api(`/users/${me.body.id}`))
        .set(bearer(t.admin))
        .expect(400);
    });
  });

  describe('catalog', () => {
    it('builds a course with subjects and chapters', async () => {
      id.physics = (
        await http()
          .post(api('/subjects'))
          .set(bearer(t.admin))
          .send({ code: 'phy', name: 'Physics' })
          .expect(201)
      ).body.id;
      id.maths = (
        await http()
          .post(api('/subjects'))
          .set(bearer(t.admin))
          .send({ code: 'MATH', name: 'Mathematics' })
          .expect(201)
      ).body.id;
      await http()
        .post(api('/subjects'))
        .set(bearer(t.admin))
        .send({ code: 'PHY', name: 'Dup' })
        .expect(409);

      const course = await http()
        .post(api('/courses'))
        .set(bearer(t.admin))
        .send({
          code: 'jee',
          slug: 'jee',
          title: 'JEE Main & Advanced',
          status: 'DRAFT',
        })
        .expect(201);
      expect(course.body.code).toBe('JEE');
      id.course = course.body.id;

      await http()
        .put(api(`/courses/${id.course}/subjects/${id.physics}`))
        .set(bearer(t.admin))
        .send({ sortOrder: 1 })
        .expect(200);
      await http()
        .put(api(`/courses/${id.course}/subjects/${id.maths}`))
        .set(bearer(t.admin))
        .send({ sortOrder: 2 })
        .expect(200);

      await http()
        .post(api('/chapters'))
        .set(bearer(t.faculty))
        .send({
          courseId: id.course,
          subjectId: id.physics,
          title: 'Laws of Motion',
          isPublished: true,
        })
        .expect(201);
      await http()
        .post(api('/chapters'))
        .set(bearer(t.faculty))
        .send({
          courseId: id.course,
          subjectId: id.physics,
          title: 'Draft chapter',
        })
        .expect(201);
      const unrelated = (
        await http()
          .post(api('/subjects'))
          .set(bearer(t.admin))
          .send({ code: 'BIO', name: 'Biology' })
          .expect(201)
      ).body.id;
      await http()
        .post(api('/chapters'))
        .set(bearer(t.admin))
        .send({ courseId: id.course, subjectId: unrelated, title: 'Cells' })
        .expect(400);
    });

    it('hides draft courses and chapters from visitors', async () => {
      await http().get(api('/courses/jee')).expect(404);
      await http()
        .patch(api(`/courses/${id.course}`))
        .set(bearer(t.admin))
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const list = await http().get(api('/courses')).expect(200);
      expect(list.body.map((c: { slug: string }) => c.slug)).toEqual(['jee']);
      const publicSyllabus = await http()
        .get(api('/courses/jee/curriculum'))
        .expect(200);
      expect(
        publicSyllabus.body.subjects[0].chapters.map(
          (c: { title: string }) => c.title,
        ),
      ).toEqual(['Laws of Motion']);
      const staffSyllabus = await http()
        .get(api('/courses/jee/curriculum'))
        .set(bearer(t.faculty))
        .expect(200);
      expect(staffSyllabus.body.subjects[0].chapters).toHaveLength(2);
    });

    it('refuses to detach a subject that has chapters', async () => {
      await http()
        .delete(api(`/courses/${id.course}/subjects/${id.physics}`))
        .set(bearer(t.admin))
        .expect(409);
    });
  });

  describe('batches and enrollments', () => {
    it('creates a batch and assigns faculty per subject', async () => {
      await http()
        .post(api('/batches'))
        .set(bearer(t.admin))
        .send({
          courseId: id.course,
          code: 'bad',
          name: 'Bad dates',
          startDate: '2027-05-01',
          endDate: '2027-04-01',
        })
        .expect(400);
      const batch = await http()
        .post(api('/batches'))
        .set(bearer(t.admin))
        .send({
          courseId: id.course,
          code: 'jee-27-m',
          name: 'JEE 2027 Morning',
          startDate: '2027-04-01',
          capacity: 1,
          status: 'ACTIVE',
        })
        .expect(201);
      expect(batch.body).toMatchObject({
        code: 'JEE-27-M',
        enrolled: 0,
        seatsAvailable: 1,
      });
      id.batch = batch.body.id;

      const assigned = await http()
        .post(api(`/batches/${id.batch}/faculty`))
        .set(bearer(t.admin))
        .send({ facultyUserId: id.faculty, subjectId: id.physics })
        .expect(201);
      expect(assigned.body.faculty).toEqual([
        expect.objectContaining({
          userId: id.faculty,
          subject: expect.objectContaining({ code: 'PHY' }),
        }),
      ]);
      await http()
        .post(api(`/batches/${id.batch}/faculty`))
        .set(bearer(t.admin))
        .send({ facultyUserId: id.student, subjectId: id.physics })
        .expect(400);
      await http()
        .post(api(`/batches/${id.batch}/faculty`))
        .set(bearer(t.admin))
        .send({ facultyUserId: id.faculty, subjectId: id.physics })
        .expect(409);
    });

    it('enrols with a seat limit and shows students their batches', async () => {
      const e = await http()
        .post(api('/enrollments'))
        .set(bearer(t.admin))
        .send({ studentUserId: id.student, batchId: id.batch })
        .expect(201);
      id.enrollment = e.body.id;
      const second = await createUser(ctx, ['STUDENT']);
      await http()
        .post(api('/enrollments'))
        .set(bearer(t.admin))
        .send({ studentUserId: second.id, batchId: id.batch })
        .expect(409);
      await http()
        .post(api('/enrollments'))
        .set(bearer(t.admin))
        .send({ studentUserId: id.faculty, batchId: id.batch })
        .expect(400);

      const mine = await http()
        .get(api('/enrollments/me'))
        .set(bearer(t.student))
        .expect(200);
      expect(mine.body[0].batches).toMatchObject({
        id: id.batch,
        courses: { slug: 'jee' },
      });
      const myBatches = await http()
        .get(api('/batches?mine=true'))
        .set(bearer(t.student))
        .expect(200);
      expect(myBatches.body.data.map((b: { id: number }) => b.id)).toEqual([
        id.batch,
      ]);
    });

    it('limits rosters and student profiles to the batch faculty', async () => {
      const roster = await http()
        .get(api(`/batches/${id.batch}/students`))
        .set(bearer(t.faculty))
        .expect(200);
      expect(roster.body[0].student_profiles.user_id).toBe(id.student);
      await http()
        .get(api(`/students/${id.student}`))
        .set(bearer(t.faculty))
        .expect(200);

      const outsider = await createUser(ctx, ['FACULTY']);
      await http()
        .get(api(`/batches/${id.batch}/students`))
        .set(bearer(outsider.token))
        .expect(403);
      await http()
        .get(api(`/students/${id.student}`))
        .set(bearer(outsider.token))
        .expect(403);
    });

    it('honours the enrollment access window', async () => {
      const ended = new Date(Date.now() - 86_400_000).toISOString();
      await http()
        .patch(api(`/enrollments/${id.enrollment}`))
        .set(bearer(t.admin))
        .send({ accessEndsAt: ended })
        .expect(200);
      const none = await http()
        .get(api('/batches?mine=true'))
        .set(bearer(t.student))
        .expect(200);
      expect(none.body.data).toEqual([]);
      await http()
        .patch(api(`/enrollments/${id.enrollment}`))
        .set(bearer(t.admin))
        .send({ accessEndsAt: null })
        .expect(200);
      const back = await http()
        .get(api('/batches?mine=true'))
        .set(bearer(t.student))
        .expect(200);
      expect(back.body.data).toHaveLength(1);
    });

    it('frees the seat on cancel and rejects lowering capacity under the enrolled count', async () => {
      await http()
        .patch(api(`/batches/${id.batch}`))
        .set(bearer(t.admin))
        .send({ capacity: 0 })
        .expect(400);
      await http()
        .patch(api(`/enrollments/${id.enrollment}`))
        .set(bearer(t.admin))
        .send({ status: 'CANCELLED' })
        .expect(200);
      expect(
        (
          await http()
            .get(api(`/batches/${id.batch}`))
            .expect(200)
        ).body.seatsAvailable,
      ).toBe(1);
      const back = await http()
        .post(api('/enrollments'))
        .set(bearer(t.admin))
        .send({ studentUserId: id.student, batchId: id.batch })
        .expect(201);
      expect(back.body.id).toBe(id.enrollment);
    });

    it('refuses to delete a batch with enrollments', async () => {
      await http()
        .delete(api(`/batches/${id.batch}`))
        .set(bearer(t.admin))
        .expect(409);
    });
  });

  describe('website', () => {
    it('takes callback requests and lets admins assign them to faculty', async () => {
      const res = await http()
        .post(api('/admission-enquiries'))
        .send({
          studentName: 'Sana Ali',
          mobile: '+91 91234 56789',
          interestedCourseId: id.course,
          message: 'Class 11',
        })
        .expect(201);
      expect(Object.keys(res.body).sort()).toEqual([
        'created_at',
        'id',
        'status',
      ]);
      await http()
        .post(api('/admission-enquiries'))
        .send({ studentName: 'X', mobile: '1' })
        .expect(400);

      await http()
        .get(api(`/admission-enquiries/${res.body.id}`))
        .set(bearer(t.faculty))
        .expect(404);
      await http()
        .patch(api(`/admission-enquiries/${res.body.id}`))
        .set(bearer(t.admin))
        .send({ status: 'CONTACTED', assignedTo: id.faculty })
        .expect(200);
      const facultyView = await http()
        .get(api('/admission-enquiries'))
        .set(bearer(t.faculty))
        .expect(200);
      expect(facultyView.body.data[0]).toMatchObject({
        source: 'WEBSITE',
        status: 'CONTACTED',
        courses: { code: 'JEE' },
      });
      await http()
        .patch(api(`/admission-enquiries/${res.body.id}`))
        .set(bearer(t.faculty))
        .send({ assignedTo: null })
        .expect(400);
      await http()
        .get(api('/admission-enquiries'))
        .set(bearer(t.student))
        .expect(403);
    });

    it('publishes website content by key', async () => {
      await http()
        .put(api('/website-content/home.hero'))
        .set(bearer(t.admin))
        .send({ title: 'A new chapter', body: 'Welcome' })
        .expect(200);
      await http().get(api('/website-content/home.hero')).expect(404);
      await http()
        .put(api('/website-content/home.hero'))
        .set(bearer(t.admin))
        .send({ isPublished: true })
        .expect(200);
      const hero = await http()
        .get(api('/website-content/home.hero'))
        .expect(200);
      expect(hero.body).toMatchObject({
        title: 'A new chapter',
        is_published: true,
      });
      await http()
        .put(api('/website-content/Bad Key'))
        .set(bearer(t.admin))
        .send({})
        .expect(400);
    });

    it('lists active faculty publicly', async () => {
      const res = await http().get(api('/faculty')).expect(200);
      expect(
        res.body.map(
          (f: { users: { full_name: string } }) => f.users.full_name,
        ),
      ).toContain('Mr Faisal');
    });
  });

  describe('audit log', () => {
    it('records who changed what, without request bodies', async () => {
      const res = await http()
        .get(api('/audit-logs?entityType=Batches'))
        .set(bearer(t.admin))
        .expect(200);
      const actions = res.body.data.map(
        (row: { action: string }) => row.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['Batches.create', 'Batches.assignFaculty']),
      );
      expect(JSON.stringify(res.body)).not.toContain('Passw0rd');
      await http().get(api('/audit-logs')).set(bearer(t.faculty)).expect(403);
    });
  });
});
