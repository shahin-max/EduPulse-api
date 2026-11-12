// The API runs behind a reverse proxy in production (Railway). With TRUST_PROXY=1, the visitor's
// address from X-Forwarded-For is used for rate limits and audit logs instead of the proxy's.
// Set before the app (and its ConfigModule) is loaded, hence the dynamic import.
process.env.TRUST_PROXY = '1';
const { api, bearer, closeTestApp, createTestApp, createUser } =
  await import('./helpers.js');
type TestContext = Awaited<ReturnType<typeof createTestApp>>;

describe('Behind a reverse proxy (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await closeTestApp(ctx);
  });

  it('records the visitor address the proxy forwards, not the proxy', async () => {
    const admin = await createUser(ctx, ['ADMIN']);
    const target = await createUser(ctx, ['STUDENT']);
    await ctx
      .http()
      .patch(api(`/users/${target.id}`))
      .set(bearer(admin.token))
      // A client-supplied value first, then the address the proxy appended: only the last is trusted.
      .set('X-Forwarded-For', '198.51.100.7, 203.0.113.9')
      .send({ fullName: 'Renamed Through Proxy' })
      .expect(200);
    // The audit row is written after the response is sent, so wait for it briefly.
    await vi.waitFor(
      async () => {
        const entry = await ctx.prisma.audit_logs.findFirst({
          where: { actor_user_id: BigInt(admin.id) },
          orderBy: { id: 'desc' },
          select: { ip_address: true },
        });
        expect(entry?.ip_address).toBe('203.0.113.9');
      },
      { timeout: 3000, interval: 100 },
    );
  });
});
