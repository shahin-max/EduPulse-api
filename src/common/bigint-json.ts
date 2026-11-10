/**
 * Every id in the schema is BIGINT UNSIGNED, which Prisma returns as `bigint`, and
 * JSON.stringify throws on bigint. Ids are serialised as plain numbers while they are
 * safe integers (they will be for any realistic row count), otherwise as strings.
 * Money and marks (DECIMAL) are serialised by Prisma's Decimal as strings, e.g. "1500.00".
 */
declare global {
  interface BigInt {
    toJSON(): number | string;
  }
}

BigInt.prototype.toJSON = function (this: bigint): number | string {
  return this <= BigInt(Number.MAX_SAFE_INTEGER) &&
    this >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(this)
    : this.toString();
};

export {};
