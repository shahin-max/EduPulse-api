import { allPages, csvCell, toCsv } from './csv.js';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Ali, Sana')).toBe('"Ali, Sana"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(7n)).toBe('7');
  });

  it('neutralises formulas but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91 98765')).toBe("'+91 98765");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-250.00')).toBe('-250.00');
  });

  it('builds rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x'], [2, null]])).toBe('a,b\r\n1,x\r\n2,');
  });

  it('collects every page', async () => {
    const pages = [[1, 2], [3]];
    const rows = await allPages(async (page, limit) => ({
      data: pages[page - 1],
      meta: { page, limit, total: 3, totalPages: 2 },
    }));
    expect(rows).toEqual([1, 2, 3]);
  });
});
