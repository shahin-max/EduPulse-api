import type { class_attendance_status } from '../generated/prisma/enums.js';

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  /**
   * (present + late) / (total - excused) x 100, one decimal place.
   * Excused classes do not count against the student. null when nothing countable was marked.
   */
  percentage: number | null;
}

export function summarize(
  statuses: class_attendance_status[],
): AttendanceSummary {
  const count = (status: class_attendance_status) =>
    statuses.filter((s) => s === status).length;
  const present = count('PRESENT');
  const absent = count('ABSENT');
  const late = count('LATE');
  const excused = count('EXCUSED');
  const countable = statuses.length - excused;
  return {
    total: statuses.length,
    present,
    absent,
    late,
    excused,
    percentage:
      countable > 0
        ? Math.round(((present + late) / countable) * 1000) / 10
        : null,
  };
}
