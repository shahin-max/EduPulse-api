import { Prisma } from '../generated/prisma/client.js';
import {
  documentNumber,
  invoiceState,
  money,
  MONEY_REGEX,
  netPaid,
  PaymentMoney,
} from './invoice-math.js';

const d = (v: string | number) => new Prisma.Decimal(v);
const invoice = (
  status: 'DRAFT' | 'ISSUED' | 'PART_PAID' | 'PAID' | 'VOID' = 'ISSUED',
) => ({
  status,
  gross_amount: d('3500.00'),
  discount_amount: d('500.00'),
});
const pay = (
  amount: string,
  status: PaymentMoney['status'],
  refunds: [string, 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'][] = [],
) => ({
  amount: d(amount),
  status,
  payment_refunds: refunds.map(([a, s]) => ({ amount: d(a), status: s })),
});

describe('invoiceState', () => {
  it('is ISSUED with the full payable amount due when nothing is paid', () => {
    const { balanceDue, status } = invoiceState(invoice(), []);
    expect(balanceDue.toFixed(2)).toBe('3000.00');
    expect(status).toBe('ISSUED');
  });

  it('only counts CONFIRMED payments', () => {
    const state = invoiceState(invoice(), [
      pay('1000', 'CONFIRMED'),
      pay('500', 'PENDING'),
      pay('700', 'FAILED'),
    ]);
    expect(state.balanceDue.toFixed(2)).toBe('2000.00');
    expect(state.status).toBe('PART_PAID');
  });

  it('is PAID once payments cover the payable amount', () => {
    const state = invoiceState(invoice('PART_PAID'), [
      pay('1000.10', 'CONFIRMED'),
      pay('1999.90', 'CONFIRMED'),
    ]);
    expect(state.balanceDue.toFixed(2)).toBe('0.00');
    expect(state.status).toBe('PAID');
  });

  it('adds confirmed refunds back to the amount due', () => {
    const state = invoiceState(invoice('PAID'), [
      pay('3000', 'CONFIRMED', [
        ['1000', 'CONFIRMED'],
        ['200', 'PENDING'],
      ]),
    ]);
    expect(state.balanceDue.toFixed(2)).toBe('1000.00');
    expect(state.status).toBe('PART_PAID');
  });

  it('goes back to ISSUED when everything was refunded', () => {
    const state = invoiceState(invoice('PAID'), [
      pay('3000', 'CONFIRMED', [['3000', 'CONFIRMED']]),
    ]);
    expect(state.status).toBe('ISSUED');
  });

  it('never derives a new status for DRAFT or VOID invoices', () => {
    expect(invoiceState(invoice('DRAFT'), []).status).toBe('DRAFT');
    expect(
      invoiceState(invoice('VOID'), [pay('100', 'CONFIRMED')]).status,
    ).toBe('VOID');
  });

  it('uses exact decimal arithmetic (no float drift)', () => {
    const payments = Array.from({ length: 10 }, () => pay('0.10', 'CONFIRMED'));
    expect(netPaid(payments).toFixed(2)).toBe('1.00');
  });
});

describe('money', () => {
  it('accepts at most 2 decimals and 10 integer digits', () => {
    expect(MONEY_REGEX.test('1500')).toBe(true);
    expect(MONEY_REGEX.test('1500.5')).toBe(true);
    expect(MONEY_REGEX.test('1500.505')).toBe(false);
    expect(MONEY_REGEX.test('-5')).toBe(false);
    expect(MONEY_REGEX.test('12345678901')).toBe(false);
    expect(money('12.5').toFixed(2)).toBe('12.50');
  });
});

describe('documentNumber', () => {
  it('formats prefix, year-month and padded id', () => {
    expect(documentNumber('INV', 123n, new Date('2027-04-09T10:00:00Z'))).toBe(
      'INV-202704-000123',
    );
    expect(
      documentNumber('RCT', 1234567n, new Date('2027-12-01T00:00:00Z')),
    ).toBe('RCT-202712-1234567');
  });
});
