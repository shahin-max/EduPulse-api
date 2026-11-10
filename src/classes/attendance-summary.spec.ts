import { summarize } from './attendance-summary.js';

describe('summarize (attendance)', () => {
  it('counts each status and treats LATE as attended', () => {
    expect(summarize(['PRESENT', 'PRESENT', 'LATE', 'ABSENT'])).toEqual({
      total: 4,
      present: 2,
      absent: 1,
      late: 1,
      excused: 0,
      percentage: 75,
    });
  });

  it('leaves EXCUSED out of the percentage', () => {
    // 2 attended out of 3 countable (one excused) = 66.7%
    expect(
      summarize(['PRESENT', 'PRESENT', 'ABSENT', 'EXCUSED']).percentage,
    ).toBe(66.7);
  });

  it('has no percentage when nothing countable was marked', () => {
    expect(summarize([]).percentage).toBeNull();
    expect(summarize(['EXCUSED', 'EXCUSED']).percentage).toBeNull();
  });

  it('rounds to one decimal place', () => {
    expect(summarize(['PRESENT', 'ABSENT', 'ABSENT']).percentage).toBe(33.3);
  });
});
