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

describe('Fees (e2e)', () => {
  let ctx: TestContext;
  const t: Record<string, string> = {};
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await createUser(ctx, ['ADMIN']);
    const student = await createUser(ctx, ['STUDENT']);
    const other = await createUser(ctx, ['STUDENT']);
    Object.assign(t, {
      admin: admin.token,
      student: student.token,
      other: other.token,
    });
    const { courseId, batchId } = await createCourseWithBatch(ctx);
    Object.assign(ids, { courseId, batchId });
    ids.enrollment = await enrol(ctx, student.id, batchId);
  });

  afterAll(() => closeTestApp(ctx));

  const http = () => ctx.http();
  const as = (who: string) => ({ ...bearer(t[who]) });

  it('creates a fee plan for the course', async () => {
    const res = await http()
      .post(api('/fee-plans'))
      .set(as('admin'))
      .send({ courseId: ids.courseId, title: 'Monthly fee', amount: 3500 })
      .expect(201);
    expect(res.body).toMatchObject({
      amount: '3500',
      currency: 'INR',
      is_active: true,
    });
    ids.plan = res.body.id;
    await http()
      .post(api('/fee-plans'))
      .set(as('admin'))
      .send({ courseId: ids.courseId, title: 'Bad', amount: '12.345' })
      .expect(400);
    await http()
      .post(api('/fee-plans'))
      .set(as('student'))
      .send({ courseId: ids.courseId, title: 'X', amount: 1 })
      .expect(403);
  });

  it('raises and issues an invoice from the plan with a discount', async () => {
    await http()
      .post(api('/fee-invoices'))
      .set(as('admin'))
      .send({
        enrollmentId: ids.enrollment,
        grossAmount: '100',
        discountAmount: '100.01',
      })
      .expect(400);

    const res = await http()
      .post(api('/fee-invoices'))
      .set(as('admin'))
      .send({
        enrollmentId: ids.enrollment,
        feePlanId: ids.plan,
        discountAmount: '500',
        dueDate: '2027-04-10',
        issue: true,
      })
      .expect(201);
    expect(res.body.invoice_number).toMatch(/^TST\/\d{2}-\d{2}\/\d{4,}$/);
    expect(res.body).toMatchObject({
      status: 'ISSUED',
      gross_amount: '3500',
      discount_amount: '500',
      amount_due: '3000',
      amount_paid: '0.00',
      balance_due: '3000.00',
      description: 'Monthly fee',
    });
    ids.invoice = res.body.id;
  });

  it('records a payment, idempotently', async () => {
    const body = {
      amount: '1000',
      method: 'UPI',
      idempotencyKey: 'pay-key-0001',
      externalReference: 'UPI123',
    };
    const first = await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('admin'))
      .send(body)
      .expect(201);
    expect(first.body).toMatchObject({ status: 'CONFIRMED', amount: '1000' });
    expect(first.body.receipt_number).toMatch(/^TST\/\d{2}-\d{2}\/\d{4,}$/);
    ids.payment = first.body.id;

    const replay = await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('admin'))
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(ids.payment);
    await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('admin'))
      .send({ ...body, amount: '999' })
      .expect(409);

    const invoice = await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('admin'))
      .expect(200);
    expect(invoice.body).toMatchObject({
      status: 'PART_PAID',
      amount_due: '3000',
      amount_paid: '1000.00',
      balance_due: '2000.00',
    });
    expect(invoice.body.payments).toHaveLength(1);
  });

  it('refuses overpayment', async () => {
    await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('admin'))
      .send({
        amount: '2000.01',
        method: 'CASH',
        idempotencyKey: 'pay-key-0002',
      })
      .expect(400);
  });

  it('settles a pending payment to PAID', async () => {
    const pending = await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('admin'))
      .send({
        amount: '2000',
        method: 'BANK_TRANSFER',
        idempotencyKey: 'pay-key-0003',
        status: 'PENDING',
      })
      .expect(201);
    expect(pending.body.receipt_number).toBeNull();
    let invoice = await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('admin'))
      .expect(200);
    expect(invoice.body.status).toBe('PART_PAID');

    const confirmed = await http()
      .patch(api(`/payments/${pending.body.id}/status`))
      .set(as('admin'))
      .send({ status: 'CONFIRMED' })
      .expect(200);
    expect(confirmed.body.receipt_number).toMatch(/^TST\//);
    await http()
      .patch(api(`/payments/${pending.body.id}/status`))
      .set(as('admin'))
      .send({ status: 'FAILED' })
      .expect(400);
    invoice = await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('admin'))
      .expect(200);
    expect(invoice.body).toMatchObject({ status: 'PAID', balance_due: '0.00' });
  });

  it('refunds part of a payment and reopens the balance', async () => {
    await http()
      .post(api(`/payments/${ids.payment}/refunds`))
      .set(as('admin'))
      .send({
        amount: '1000.01',
        reason: 'Too much',
        idempotencyKey: 'ref-key-0001',
      })
      .expect(400);
    const refund = await http()
      .post(api(`/payments/${ids.payment}/refunds`))
      .set(as('admin'))
      .send({
        amount: '500',
        reason: 'Scholarship adjustment',
        idempotencyKey: 'ref-key-0002',
      })
      .expect(201);
    expect(refund.body).toMatchObject({ status: 'CONFIRMED', amount: '500' });
    const replay = await http()
      .post(api(`/payments/${ids.payment}/refunds`))
      .set(as('admin'))
      .send({
        amount: '500',
        reason: 'Scholarship adjustment',
        idempotencyKey: 'ref-key-0002',
      })
      .expect(201);
    expect(replay.body.id).toBe(refund.body.id);

    const invoice = await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('admin'))
      .expect(200);
    expect(invoice.body).toMatchObject({
      status: 'PART_PAID',
      amount_paid: '2500.00',
      balance_due: '500.00',
    });
  });

  it('shows students only their own issued invoices', async () => {
    const mine = await http()
      .get(api('/fee-invoices/me'))
      .set(as('student'))
      .expect(200);
    expect(mine.body.map((i: { id: number }) => i.id)).toEqual([ids.invoice]);
    await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('student'))
      .expect(200);
    await http()
      .get(api(`/fee-invoices/${ids.invoice}`))
      .set(as('other'))
      .expect(404);
    await http()
      .get(api(`/payments/${ids.payment}`))
      .set(as('other'))
      .expect(404);
    await http()
      .post(api(`/fee-invoices/${ids.invoice}/payments`))
      .set(as('student'))
      .send({})
      .expect(403);
    expect(
      (await http().get(api('/fee-invoices/me')).set(as('other')).expect(200))
        .body,
    ).toEqual([]);
  });

  it('only voids invoices nothing is paid on, and drafts take no payments', async () => {
    await http()
      .post(api(`/fee-invoices/${ids.invoice}/void`))
      .set(as('admin'))
      .expect(400);

    const draft = await http()
      .post(api('/fee-invoices'))
      .set(as('admin'))
      .send({ enrollmentId: ids.enrollment, grossAmount: '1200' })
      .expect(201);
    expect(draft.body).toMatchObject({
      status: 'DRAFT',
      amount_due: '1200',
      balance_due: '1200.00',
    });
    await http()
      .post(api(`/fee-invoices/${draft.body.id}/payments`))
      .set(as('admin'))
      .send({ amount: '100', method: 'CASH', idempotencyKey: 'pay-key-0004' })
      .expect(400);
    const edited = await http()
      .patch(api(`/fee-invoices/${draft.body.id}`))
      .set(as('admin'))
      .send({ discountAmount: '200' })
      .expect(200);
    expect(edited.body).toMatchObject({
      amount_due: '1000',
      balance_due: '1000.00',
    });
    // Students never see drafts.
    await http()
      .get(api(`/fee-invoices/${draft.body.id}`))
      .set(as('student'))
      .expect(404);
    const voided = await http()
      .post(api(`/fee-invoices/${draft.body.id}/void`))
      .set(as('admin'))
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    await http()
      .patch(api(`/fee-invoices/${draft.body.id}`))
      .set(as('admin'))
      .send({ discountAmount: '0' })
      .expect(400);
  });

  it('filters invoices for admins', async () => {
    const res = await http()
      .get(api(`/fee-invoices?status=PART_PAID&batchId=${ids.batchId}`))
      .set(as('admin'))
      .expect(200);
    expect(res.body.data.map((i: { id: number }) => i.id)).toEqual([
      ids.invoice,
    ]);
  });

  it('numbers invoices consecutively per branch and year, only when issued', async () => {
    const sequence = (n: string) => Number(n.split('/')[2]);
    const draft = async () =>
      (
        await http()
          .post(api('/fee-invoices'))
          .set(as('admin'))
          .send({ enrollmentId: ids.enrollment, grossAmount: '500' })
          .expect(201)
      ).body;
    const a = await draft();
    const b = await draft();
    expect(a.invoice_number).toBe(`DRAFT-${a.id}`);
    // Issued out of creation order: the numbers follow the order of issuing, with no gaps.
    const issuedB = await http()
      .post(api(`/fee-invoices/${b.id}/issue`))
      .set(as('admin'))
      .expect(201);
    const issuedA = await http()
      .post(api(`/fee-invoices/${a.id}/issue`))
      .set(as('admin'))
      .expect(201);
    expect(issuedB.body.invoice_number).toMatch(/^TST\/\d{2}-\d{2}\/\d{4,}$/);
    expect(sequence(issuedA.body.invoice_number)).toBe(
      sequence(issuedB.body.invoice_number) + 1,
    );
    await http()
      .post(api(`/fee-invoices/${a.id}/issue`))
      .set(as('admin'))
      .expect(400);
    ids.searchInvoice = a.id;
    ids.searchNumber = issuedA.body.invoice_number;
  });

  it('searches invoices and totals the whole filter', async () => {
    const found = await http()
      .get(
        api(
          `/fee-invoices?search=${encodeURIComponent(String(ids.searchNumber))}`,
        ),
      )
      .set(as('admin'))
      .expect(200);
    expect(found.body.data.map((i: { id: number }) => i.id)).toEqual([
      ids.searchInvoice,
    ]);
    const all = await http()
      .get(api(`/fee-invoices?batchId=${ids.batchId}&limit=1`))
      .set(as('admin'))
      .expect(200);
    const { summary } = all.body;
    // Totals cover every matching invoice, not the one row on this page.
    expect(all.body.data).toHaveLength(1);
    expect(summary.invoices).toBeGreaterThan(1);
    expect(Number(summary.billed) - Number(summary.collected)).toBeCloseTo(
      Number(summary.outstanding),
      2,
    );
    expect(Number(summary.collected)).toBeGreaterThan(0);
    await http()
      .get(api('/fee-invoices?search=nobody-matches-this'))
      .set(as('admin'))
      .expect(200)
      .expect((res) => expect(res.body.summary.invoices).toBe(0));
  });

  it('lists payments with collection totals by method', async () => {
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await http()
      .get(api(`/payments?from=${from}&to=${to}&status=CONFIRMED`))
      .set(as('admin'))
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({
      fee_invoices: { invoice_number: expect.any(String) },
    });
    const { summary } = res.body;
    const byMethod = summary.byMethod.reduce(
      (n: number, m: { amount: string }) => n + Number(m.amount),
      0,
    );
    expect(byMethod).toBeCloseTo(Number(summary.collected), 2);
    expect(Number(summary.net)).toBeCloseTo(
      Number(summary.collected) - Number(summary.refunded),
      2,
    );
    expect(summary.byMethod.map((m: { method: string }) => m.method)).toContain(
      'UPI',
    );
    // Nothing was paid in a period long ago.
    const empty = await http()
      .get(api('/payments?from=2001-01-01T00:00:00Z&to=2001-01-02T00:00:00Z'))
      .set(as('admin'))
      .expect(200);
    expect(empty.body.summary).toMatchObject({
      payments: 0,
      collected: '0.00',
    });
    await http().get(api('/payments')).set(as('student')).expect(403);
  });

  it('refuses a branch prefix another branch already uses', async () => {
    await http()
      .post(api('/branches'))
      .set(as('admin'))
      .send({
        code: 'DUPE',
        name: 'Dupe',
        invoicePrefix: 'TST',
        receiptPrefix: 'DUPR',
      })
      .expect(409);
  });
});
