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
 * Branch admins: head office (global ADMIN) puts someone on a branch's staff as ADMIN; they sign
 * in on the normal login page and only see and change their own branch.
 */
describe('Branch admins (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const id: Record<string, number> = {};
  const as = (who: string) => bearer(t[who]);

  beforeAll(async () => {
    ctx = await createTestApp();
    const p = ctx.prisma;
    const head = await createUser(ctx, ['ADMIN']);
    const manager = await createUser(ctx, ['FACULTY']); // becomes branch admin of A below
    const amy = await createUser(ctx, ['STUDENT'], { fullName: 'Amy at A' });
    const ben = await createUser(ctx, ['STUDENT'], { fullName: 'Ben at B' });
    const newcomer = await createUser(ctx, ['STUDENT']);
    const teacher = await createUser(ctx, ['FACULTY']);
    Object.assign(t, { head: head.token, amy: amy.token, ben: ben.token });
    Object.assign(id, {
      manager: manager.id,
      amy: amy.id,
      ben: ben.id,
      newcomer: newcomer.id,
      teacher: teacher.id,
    });
    t.managerPassword = manager.password;
    t.managerEmail = manager.email;

    const a = await p.branches.create({
      data: { code: 'BRA', name: 'Branch A', invoice_prefix: 'BRA', receipt_prefix: 'BRAR' },
    });
    const b = await p.branches.create({
      data: { code: 'BRB', name: 'Branch B', invoice_prefix: 'BRB', receipt_prefix: 'BRBR' },
    });
    id.a = Number(a.id);
    id.b = Number(b.id);

    // One course with a batch at each branch.
    const atA = await createCourseWithBatch(ctx);
    await p.batches.update({
      where: { id: BigInt(atA.batchId) },
      data: { branch_id: a.id },
    });
    const atB = await createCourseWithBatch(ctx);
    await p.batches.update({
      where: { id: BigInt(atB.batchId) },
      data: { branch_id: b.id },
    });
    Object.assign(id, {
      courseA: atA.courseId,
      batchA: atA.batchId,
      courseB: atB.courseId,
      batchB: atB.batchId,
    });
    id.enrolA = await enrol(ctx, amy.id, atA.batchId);
    id.enrolB = await enrol(ctx, ben.id, atB.batchId);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('head office sets up the branch: offers a course and adds a branch admin', async () => {
    await ctx
      .http()
      .put(api(`/branches/${id.a}/courses/${id.courseA}`))
      .set(as('head'))
      .expect(200);
    const staff = await ctx
      .http()
      .post(api(`/branches/${id.a}/staff`))
      .set(as('head'))
      .send({ userId: id.manager, role: 'ADMIN' })
      .expect(201);
    expect(staff.body).toContainEqual(
      expect.objectContaining({ role: 'ADMIN' }),
    );
    // Same person twice is a conflict.
    await ctx
      .http()
      .post(api(`/branches/${id.a}/staff`))
      .set(as('head'))
      .send({ userId: id.manager, role: 'ADMIN' })
      .expect(409);
  });

  it('the branch admin signs in on the normal login and is told their branch', async () => {
    const login = await ctx
      .http()
      .post(api('/auth/login'))
      .send({ login: t.managerEmail, password: t.managerPassword })
      .expect(200);
    t.manager = login.body.accessToken;
    expect(login.body.user.roles).toEqual(
      expect.arrayContaining(['FACULTY', 'BRANCH_ADMIN']),
    );
    const me = await ctx.http().get(api('/auth/me')).set(as('manager')).expect(200);
    expect(me.body.is_head_office).toBe(false);
    expect(me.body.admin_branches).toEqual([
      expect.objectContaining({ id: id.a, code: 'BRA' }),
    ]);
    const head = await ctx.http().get(api('/auth/me')).set(as('head')).expect(200);
    expect(head.body.is_head_office).toBe(true);
  });

  it('sees only their own branch and its batches', async () => {
    const branches = await ctx.http().get(api('/branches')).set(as('manager')).expect(200);
    expect(branches.body.map((b: { id: number }) => b.id)).toEqual([id.a]);
    await ctx.http().get(api(`/branches/${id.b}`)).set(as('manager')).expect(404);

    const batches = await ctx.http().get(api('/batches')).set(as('manager')).expect(200);
    const ids = batches.body.data.map((b: { id: number }) => b.id);
    expect(ids).toContain(id.batchA);
    expect(ids).not.toContain(id.batchB);
    await ctx
      .http()
      .get(api(`/batches?branchId=${id.b}`))
      .set(as('manager'))
      .expect(403);
    await ctx.http().get(api(`/batches/${id.batchA}/students`)).set(as('manager')).expect(200);
    await ctx.http().get(api(`/batches/${id.batchB}/students`)).set(as('manager')).expect(403);
  });

  it('opens batches only at their branch, for courses it offers', async () => {
    await ctx
      .http()
      .post(api('/batches'))
      .set(as('manager'))
      .send({ branchId: id.a, courseId: id.courseA, code: 'BA-NEW', name: 'New at A' })
      .expect(201);
    await ctx
      .http()
      .post(api('/batches'))
      .set(as('manager'))
      .send({ branchId: id.a, courseId: id.courseB, code: 'BA-NO', name: 'Not offered' })
      .expect(400);
    await ctx
      .http()
      .post(api('/batches'))
      .set(as('manager'))
      .send({ branchId: id.b, courseId: id.courseB, code: 'BB-NO', name: 'Other branch' })
      .expect(403);
    await ctx
      .http()
      .patch(api(`/batches/${id.batchB}`))
      .set(as('manager'))
      .send({ name: 'Renamed' })
      .expect(403);
  });

  it('sees their students and unenrolled ones, never other branches or admins', async () => {
    const users = await ctx.http().get(api('/users?limit=100')).set(as('manager')).expect(200);
    const seen = users.body.data.map((u: { id: number }) => u.id);
    expect(seen).toEqual(expect.arrayContaining([id.amy, id.newcomer]));
    expect(seen).not.toContain(id.ben);
    expect(seen).not.toContain(id.manager);
    await ctx.http().get(api(`/users/${id.ben}`)).set(as('manager')).expect(404);
    await ctx
      .http()
      .patch(api(`/users/${id.ben}`))
      .set(as('manager'))
      .send({ fullName: 'Hijacked' })
      .expect(404);
    // Roles and deletion stay with head office.
    await ctx
      .http()
      .put(api(`/users/${id.amy}/roles`))
      .set(as('manager'))
      .send({ roles: ['STUDENT'] })
      .expect(403);

    // Enrolling a newcomer moves them into the branch.
    await ctx
      .http()
      .post(api('/enrollments'))
      .set(as('manager'))
      .send({ studentUserId: id.newcomer, batchId: id.batchA })
      .expect(201);
    await ctx
      .http()
      .post(api('/enrollments'))
      .set(as('manager'))
      .send({ studentUserId: id.ben, batchId: id.batchA })
      .expect(404);
    const enrollments = await ctx.http().get(api('/enrollments')).set(as('manager')).expect(200);
    expect(
      enrollments.body.data.every(
        (e: { batches: { id: number } }) => e.batches.id === id.batchA,
      ),
    ).toBe(true);
  });

  it('creates student and faculty accounts but not admins; faculty join the branch', async () => {
    await ctx
      .http()
      .post(api('/users'))
      .set(as('manager'))
      .send({ fullName: 'Sneaky Admin', email: 'sneaky@test.local', roles: ['ADMIN'] })
      .expect(403);
    const created = await ctx
      .http()
      .post(api('/users'))
      .set(as('manager'))
      .send({ fullName: 'New Teacher', email: 'teacher-a@test.local', roles: ['FACULTY'] })
      .expect(201);
    const staff = await ctx.http().get(api(`/branches/${id.a}/staff`)).set(as('manager')).expect(200);
    expect(staff.body).toContainEqual(
      expect.objectContaining({
        role: 'FACULTY',
        user: expect.objectContaining({ id: created.body.id }),
      }),
    );
    // A branch admin adds faculty to their branch, but not admins.
    await ctx
      .http()
      .post(api(`/branches/${id.a}/staff`))
      .set(as('manager'))
      .send({ userId: id.teacher, role: 'FACULTY' })
      .expect(201);
    await ctx
      .http()
      .post(api(`/branches/${id.a}/staff`))
      .set(as('manager'))
      .send({ userId: id.teacher, role: 'ADMIN' })
      .expect(403);
  });

  it('assigns only faculty of the branch to its batches', async () => {
    const subject = await ctx.prisma.course_subjects.findFirstOrThrow({
      where: { course_id: BigInt(id.courseA) },
    });
    const outsider = await createUser(ctx, ['FACULTY']);
    await ctx
      .http()
      .post(api(`/batches/${id.batchA}/faculty`))
      .set(as('manager'))
      .send({ facultyUserId: outsider.id, subjectId: Number(subject.subject_id) })
      .expect(400);
    await ctx
      .http()
      .post(api(`/batches/${id.batchA}/faculty`))
      .set(as('manager'))
      .send({ facultyUserId: id.teacher, subjectId: Number(subject.subject_id) })
      .expect(201);
  });

  it('handles fees of their branch only', async () => {
    const mine = await ctx
      .http()
      .post(api('/fee-invoices'))
      .set(as('manager'))
      .send({ enrollmentId: id.enrolA, grossAmount: '5000', issue: true })
      .expect(201);
    expect(mine.body.invoice_number).toMatch(/^BRA\//);
    await ctx
      .http()
      .post(api('/fee-invoices'))
      .set(as('manager'))
      .send({ enrollmentId: id.enrolB, grossAmount: '5000' })
      .expect(403);
    const theirs = await ctx
      .http()
      .post(api('/fee-invoices'))
      .set(as('head'))
      .send({ enrollmentId: id.enrolB, grossAmount: '7000', issue: true })
      .expect(201);

    const list = await ctx.http().get(api('/fee-invoices')).set(as('manager')).expect(200);
    expect(list.body.data.map((i: { id: number }) => i.id)).toEqual([mine.body.id]);
    await ctx.http().get(api(`/fee-invoices/${theirs.body.id}`)).set(as('manager')).expect(403);
    await ctx
      .http()
      .post(api(`/fee-invoices/${theirs.body.id}/payments`))
      .set(as('manager'))
      .send({ amount: '100', method: 'CASH', idempotencyKey: 'branch-test-0001' })
      .expect(403);
    const all = await ctx.http().get(api('/fee-invoices')).set(as('head')).expect(200);
    expect(all.body.data).toHaveLength(2);

    // A fee plan for every branch is head office's.
    await ctx
      .http()
      .post(api('/fee-plans'))
      .set(as('manager'))
      .send({ courseId: id.courseA, title: 'Everywhere', amount: '100' })
      .expect(403);
    await ctx
      .http()
      .post(api('/fee-plans'))
      .set(as('manager'))
      .send({ courseId: id.courseA, branchId: id.a, title: 'At A', amount: '100' })
      .expect(201);

    await ctx.http().get(api('/reports/admin-summary')).set(as('manager')).expect(200);
    await ctx
      .http()
      .get(api(`/reports/admin-summary?branchId=${id.b}`))
      .set(as('manager'))
      .expect(403);
  });

  it('lists active branches publicly, without office details', async () => {
    const res = await ctx.http().get(api('/branches/public')).expect(200);
    const codes = res.body.map((b: { code: string }) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['BRA', 'BRB']));
    expect(res.body[0]).not.toHaveProperty('invoice_prefix');
    expect(res.body[0]).not.toHaveProperty('gstin');
  });

  it('works enquiries of their branch; head office routes the rest', async () => {
    const atB = await ctx
      .http()
      .post(api('/admission-enquiries'))
      .send({ studentName: 'Visitor B', mobile: '9876500001', branchId: id.b })
      .expect(201);
    const unrouted = await ctx
      .http()
      .post(api('/admission-enquiries'))
      .send({ studentName: 'Visitor ?', mobile: '9876500002' })
      .expect(201);
    const list = await ctx.http().get(api('/admission-enquiries')).set(as('manager')).expect(200);
    expect(list.body.data).toHaveLength(0);
    await ctx
      .http()
      .get(api(`/admission-enquiries/${atB.body.id}`))
      .set(as('manager'))
      .expect(404);

    const waiting = await ctx
      .http()
      .get(api('/admission-enquiries?unrouted=true'))
      .set(as('head'))
      .expect(200);
    expect(waiting.body.data.map((e: { id: number }) => e.id)).toEqual([unrouted.body.id]);
    await ctx
      .http()
      .patch(api(`/admission-enquiries/${unrouted.body.id}`))
      .set(as('head'))
      .send({ branchId: id.a })
      .expect(200);
    const routed = await ctx.http().get(api('/admission-enquiries')).set(as('manager')).expect(200);
    expect(routed.body.data.map((e: { id: number }) => e.id)).toEqual([unrouted.body.id]);
    await ctx
      .http()
      .post(api(`/admission-enquiries/${unrouted.body.id}/notes`))
      .set(as('manager'))
      .send({ body: 'Called, coming on Monday' })
      .expect(201);
  });

  it('posts to their branch; only that branch reads it', async () => {
    await ctx
      .http()
      .post(api('/announcements'))
      .set(as('manager'))
      .send({ title: 'Everyone', body: 'x', audience: 'ALL', publish: true })
      .expect(403);
    await ctx
      .http()
      .post(api('/announcements'))
      .set(as('manager'))
      .send({ title: 'Other branch', body: 'x', audience: 'BRANCH', branchId: id.b, publish: true })
      .expect(403);
    const posted = await ctx
      .http()
      .post(api('/announcements'))
      .set(as('manager'))
      .send({
        title: 'Branch A closed Friday',
        body: 'Classes resume Saturday.',
        audience: 'BRANCH',
        branchId: id.a,
        publish: true,
      })
      .expect(201);
    const feed = async (who: string) =>
      (await ctx.http().get(api('/announcements/feed')).set(as(who)).expect(200)).body.data.map(
        (a: { id: number }) => a.id,
      );
    expect(await feed('amy')).toContain(posted.body.id);
    expect(await feed('ben')).not.toContain(posted.body.id);
    expect(await feed('head')).toContain(posted.body.id);
    const note = await ctx.prisma.notifications.findFirst({
      where: { user_id: BigInt(id.amy), link_url: `/announcements/${posted.body.id}` },
    });
    expect(note).not.toBeNull();
  });

  it('head office creates an office manager as branch admin, with no other role', async () => {
    const created = await ctx
      .http()
      .post(api('/users'))
      .set(as('head'))
      .send({
        fullName: 'Office Manager',
        email: 'office-a@test.local',
        password: 'Passw0rd!',
        roles: [],
        adminBranchId: id.a,
      })
      .expect(201);
    expect(created.body.roles).toEqual(['BRANCH_ADMIN']);
    const login = await ctx
      .http()
      .post(api('/auth/login'))
      .send({ login: 'office-a@test.local', password: 'Passw0rd!' })
      .expect(200);
    const me = await ctx
      .http()
      .get(api('/auth/me'))
      .set(bearer(login.body.accessToken))
      .expect(200);
    expect(me.body.admin_branches).toEqual([expect.objectContaining({ id: id.a })]);
    // Not on the website's faculty page.
    const faculty = await ctx.http().get(api('/faculty')).expect(200);
    expect(JSON.stringify(faculty.body)).not.toContain('Office Manager');
    // No role and no branch is refused; branch admins can't create branch admins.
    await ctx
      .http()
      .post(api('/users'))
      .set(as('head'))
      .send({ fullName: 'Nobody', email: 'nobody@test.local', roles: [] })
      .expect(400);
    await ctx
      .http()
      .post(api('/users'))
      .set(as('manager'))
      .send({ fullName: 'Deputy', email: 'deputy@test.local', roles: [], adminBranchId: id.a })
      .expect(403);
  });

  it('cannot touch head office settings', async () => {
    await ctx
      .http()
      .post(api('/courses'))
      .set(as('manager'))
      .send({ code: 'NOPE', slug: 'nope', title: 'Nope' })
      .expect(403);
    await ctx
      .http()
      .patch(api(`/branches/${id.a}`))
      .set(as('manager'))
      .send({ name: 'Mine now' })
      .expect(403);
    await ctx.http().get(api('/audit-logs')).set(as('manager')).expect(403);
    await ctx
      .http()
      .put(api(`/branches/${id.a}/courses/${id.courseB}`))
      .set(as('manager'))
      .expect(403);
  });

  it('exports CSVs of their own branch only', async () => {
    const invoices = await ctx
      .http()
      .get(api('/fee-invoices/export'))
      .set(as('manager'))
      .expect(200);
    expect(invoices.headers['content-type']).toMatch(/text\/csv/);
    expect(invoices.headers['content-disposition']).toMatch(
      /attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const lines = invoices.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^Invoice,Status,Student/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^BRA\//);
    expect(invoices.text).not.toContain('Ben at B');

    const all = await ctx.http().get(api('/fee-invoices/export')).set(as('head')).expect(200);
    expect(all.text).toContain('Ben at B');

    await ctx.http().get(api('/payments/export')).set(as('manager')).expect(200);
    await ctx
      .http()
      .get(api(`/payments/export?branchId=${id.b}`))
      .set(as('manager'))
      .expect(403);
    const enquiries = await ctx
      .http()
      .get(api('/admission-enquiries/export'))
      .set(as('manager'))
      .expect(200);
    expect(enquiries.text).toContain('Visitor ?');
    expect(enquiries.text).not.toContain('Visitor B');

    const book = await ctx
      .http()
      .get(api(`/batches/${id.batchA}/gradebook/export`))
      .set(as('manager'))
      .expect(200);
    expect(book.text).toContain('Amy at A');
    await ctx
      .http()
      .get(api(`/batches/${id.batchB}/gradebook/export`))
      .set(as('manager'))
      .expect(403);
    // Students can't export.
    await ctx.http().get(api('/payments/export')).set(as('amy')).expect(403);
  });

  it('loses access as soon as head office removes them', async () => {
    await ctx
      .http()
      .delete(api(`/branches/${id.a}/staff/${id.manager}/ADMIN`))
      .set(as('head'))
      .expect(204);
    await ctx.http().get(api('/fee-invoices')).set(as('manager')).expect(403);
    const me = await ctx.http().get(api('/auth/me')).set(as('manager')).expect(200);
    expect(me.body.roles).not.toContain('BRANCH_ADMIN');
    expect(me.body.admin_branches).toEqual([]);
  });
});
