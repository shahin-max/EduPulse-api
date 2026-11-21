import { StreamableFile } from '@nestjs/common';
import type { Paginated } from './pagination.js';

type Cell = string | number | bigint | boolean | Date | null | undefined | { toString(): string };

/** A date as YYYY-MM-DD (dates are stored as UTC midnight); empty for null. */
export function isoDay(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

/** Most rows an export returns; past this, narrow the filter (dates, branch, batch). */
export const EXPORT_MAX_ROWS = 20_000;

/**
 * One CSV cell. Quoted when needed (comma, quote, newline). A text cell starting with = + - @
 * (or a tab/CR) gets a leading apostrophe, so Excel and Sheets show it instead of running it as a
 * formula ("CSV injection"); numbers stay numbers.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text))
    text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole CSV document: header row, then one row per record, CRLF line ends. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

/**
 * The CSV as a download. Starts with a UTF-8 byte order mark so Excel reads ₹ and Indian names
 * correctly. `name` is the file name without extension; today's date is appended.
 */
export function csvFile(name: string, headers: string[], rows: Cell[][]) {
  const today = new Date().toISOString().slice(0, 10);
  return new StreamableFile(
    Buffer.from(`﻿${toCsv(headers, rows)}\r\n`, 'utf8'),
    {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${name}-${today}.csv"`,
    },
  );
}

/**
 * Collects every row of a paginated list (100 at a time, up to EXPORT_MAX_ROWS), reusing the
 * list's own filters and access rules.
 */
export async function allPages<T>(
  fetchPage: (page: number, limit: number) => Promise<Paginated<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < EXPORT_MAX_ROWS; page += 1) {
    const result = await fetchPage(page, 100);
    rows.push(...result.data);
    if (page >= result.meta.totalPages || result.data.length === 0) break;
  }
  return rows.slice(0, EXPORT_MAX_ROWS);
}
