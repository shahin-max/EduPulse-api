-- Subjects shown as chips on a teacher's public website card, set by an admin (a JSON array of
-- strings). NULL or empty: the website lists the subjects of the teacher's batch assignments instead.
ALTER TABLE `faculty_profiles`
  ADD COLUMN `display_subjects` json DEFAULT NULL AFTER `biography`;
