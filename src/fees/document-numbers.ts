import { Prisma } from '../generated/prisma/client.js';
import { fiscalYear, sequenceNumber } from './invoice-math.js';

type Tx = Prisma.TransactionClient;

/**
 * Takes the next invoice or receipt number of a branch for the financial year of `at`, e.g.
 * "ALG/26-27/0001", from document_sequences. Must run inside the transaction that stores the number:
 * the sequence row stays locked until it commits, so concurrent callers get consecutive numbers, and
 * a rolled-back transaction gives its number back.
 */
export async function nextDocumentNumber(
  tx: Tx,
  branchId: bigint,
  docType: 'INVOICE' | 'RECEIPT',
  at: Date,
): Promise<string> {
  const fy = fiscalYear(at);
  // The first document of a branch and year creates its row; concurrent creators wait on the key lock.
  await tx.$executeRaw`
    INSERT IGNORE INTO document_sequences (branch_id, doc_type, fiscal_year, next_value)
    VALUES (${branchId}, ${docType}, ${fy}, 1)`;
  const rows = await tx.$queryRaw<{ next_value: number | bigint }[]>`
    SELECT next_value FROM document_sequences
    WHERE branch_id = ${branchId} AND doc_type = ${docType} AND fiscal_year = ${fy}
    FOR UPDATE`;
  const value = Number(rows[0].next_value);
  await tx.$executeRaw`
    UPDATE document_sequences SET next_value = next_value + 1
    WHERE branch_id = ${branchId} AND doc_type = ${docType} AND fiscal_year = ${fy}`;
  const branch = await tx.branches.findUniqueOrThrow({
    where: { id: branchId },
    select: { invoice_prefix: true, receipt_prefix: true },
  });
  return sequenceNumber(
    docType === 'INVOICE' ? branch.invoice_prefix : branch.receipt_prefix,
    fy,
    value,
  );
}
