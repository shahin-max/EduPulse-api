-- Multi-branch support (matches prisma/schema.prisma).
--
-- * New tables: branches, branch_courses, branch_staff, document_sequences.
-- * branch_id on batches, enrollments, fee_invoices and payments (NOT NULL), and on
--   admission_enquiries, announcements, audit_logs and fee_plans (NULL = not branch-specific).
-- * Child rows copy branch_id from their parent and composite foreign keys keep them equal:
--   enrollments(batch_id, branch_id) -> batches(id, branch_id), and so on down to payments.
-- * Existing rows are moved to a "MAIN" branch created here, so the migration works on a
--   database that already has batches, enrollments, invoices and payments.
--
-- CHECK constraints and ON UPDATE timestamps are written by hand here because Prisma cannot
-- express them; do not regenerate this file from schema.prisma.

-- ---------------------------------------------------------------- new tables

CREATE TABLE `branches` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(20) NOT NULL,
  `name` varchar(160) NOT NULL,
  `invoice_prefix` varchar(10) NOT NULL,
  `receipt_prefix` varchar(10) NOT NULL,
  `address` text,
  `city` varchar(80) DEFAULT NULL,
  `state` varchar(80) DEFAULT NULL,
  `pincode` varchar(10) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `email` varchar(254) DEFAULT NULL,
  `gstin` varchar(15) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_branches_code` (`code`),
  CONSTRAINT `chk_branches_code` CHECK (regexp_like(`code`, _utf8mb4'^[A-Z0-9]{2,20}$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `branch_courses` (
  `branch_id` bigint unsigned NOT NULL,
  `course_id` bigint unsigned NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`branch_id`,`course_id`),
  KEY `fk_branch_courses_course` (`course_id`),
  CONSTRAINT `fk_branch_courses_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_branch_courses_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `branch_staff` (
  `user_id` bigint unsigned NOT NULL,
  `branch_id` bigint unsigned NOT NULL,
  `role_id` smallint unsigned NOT NULL,
  `assigned_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`branch_id`,`role_id`),
  KEY `idx_branch_staff_branch` (`branch_id`,`role_id`),
  KEY `fk_branch_staff_role` (`role_id`),
  CONSTRAINT `fk_branch_staff_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_branch_staff_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`),
  CONSTRAINT `fk_branch_staff_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `document_sequences` (
  `branch_id` bigint unsigned NOT NULL,
  `doc_type` enum('INVOICE','RECEIPT','ADMISSION') NOT NULL,
  `fiscal_year` char(7) NOT NULL,
  `next_value` int unsigned NOT NULL DEFAULT '1',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`branch_id`,`doc_type`,`fiscal_year`),
  CONSTRAINT `fk_docseq_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `chk_docseq_fy` CHECK (regexp_like(`fiscal_year`, _utf8mb4'^[0-9]{4}-[0-9]{2}$')),
  CONSTRAINT `chk_docseq_next` CHECK ((`next_value` >= 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every existing batch (and everything under it) is moved to this branch. Rename it later.
INSERT INTO `branches` (`code`, `name`, `invoice_prefix`, `receipt_prefix`) VALUES ('MAIN', 'Main Branch', 'MAIN', 'MAIN');

SET @main_branch = LAST_INSERT_ID();

-- ---------------------------------------------------------------- batches

ALTER TABLE `batches` ADD COLUMN `branch_id` bigint unsigned NULL AFTER `id`;
UPDATE `batches` SET `branch_id` = @main_branch;
ALTER TABLE `batches`
  MODIFY `branch_id` bigint unsigned NOT NULL,
  ADD UNIQUE KEY `uq_batch_branch` (`id`,`branch_id`),
  ADD KEY `idx_batches_branch` (`branch_id`,`status`),
  ADD CONSTRAINT `fk_batches_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`);

-- ---------------------------------------------------------------- enrollments

ALTER TABLE `enrollments` ADD COLUMN `branch_id` bigint unsigned NULL AFTER `batch_id`;
UPDATE `enrollments` e JOIN `batches` b ON b.`id` = e.`batch_id` SET e.`branch_id` = b.`branch_id`;
ALTER TABLE `enrollments` DROP FOREIGN KEY `fk_enrollments_batch`;
ALTER TABLE `enrollments`
  MODIFY `branch_id` bigint unsigned NOT NULL,
  ADD UNIQUE KEY `uq_enrollment_branch` (`id`,`branch_id`),
  ADD KEY `fk_enrollments_batch` (`batch_id`,`branch_id`),
  ADD KEY `idx_enrollments_branch` (`branch_id`,`status`),
  ADD CONSTRAINT `fk_enrollments_batch` FOREIGN KEY (`batch_id`,`branch_id`) REFERENCES `batches` (`id`,`branch_id`);

-- ---------------------------------------------------------------- fee plans (branch optional)

ALTER TABLE `fee_plans` ADD COLUMN `branch_id` bigint unsigned NULL AFTER `course_id`;
-- A batch-specific plan belongs to its batch's branch, so the composite key below can check it.
UPDATE `fee_plans` p JOIN `batches` b ON b.`id` = p.`batch_id` SET p.`branch_id` = b.`branch_id`;
ALTER TABLE `fee_plans` DROP FOREIGN KEY `fk_fee_plan_batch`;
ALTER TABLE `fee_plans` DROP KEY `fk_fee_plan_batch`;
ALTER TABLE `fee_plans`
  ADD KEY `fk_fee_plan_batch` (`batch_id`,`branch_id`),
  ADD KEY `fk_fee_plan_branch` (`branch_id`,`course_id`),
  ADD CONSTRAINT `fk_fee_plan_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  ADD CONSTRAINT `fk_fee_plan_batch` FOREIGN KEY (`batch_id`,`branch_id`) REFERENCES `batches` (`id`,`branch_id`),
  -- MySQL skips a composite FK when any column is NULL, so a batch plan must name its branch.
  ADD CONSTRAINT `chk_fee_plan_batch_branch` CHECK (((`batch_id` is null) or (`branch_id` is not null)));

-- ---------------------------------------------------------------- invoices

ALTER TABLE `fee_invoices` ADD COLUMN `branch_id` bigint unsigned NULL AFTER `enrollment_id`;
UPDATE `fee_invoices` i JOIN `enrollments` e ON e.`id` = i.`enrollment_id` SET i.`branch_id` = e.`branch_id`;
ALTER TABLE `fee_invoices` DROP FOREIGN KEY `fk_invoice_enrollment`;
ALTER TABLE `fee_invoices`
  MODIFY `branch_id` bigint unsigned NOT NULL,
  ADD UNIQUE KEY `uq_invoice_branch` (`id`,`branch_id`),
  ADD KEY `fk_invoice_enrollment` (`enrollment_id`,`branch_id`),
  ADD KEY `idx_invoice_branch` (`branch_id`,`status`,`due_date`),
  ADD CONSTRAINT `fk_invoice_enrollment` FOREIGN KEY (`enrollment_id`,`branch_id`) REFERENCES `enrollments` (`id`,`branch_id`);

-- ---------------------------------------------------------------- payments

ALTER TABLE `payments` ADD COLUMN `branch_id` bigint unsigned NULL AFTER `invoice_id`;
UPDATE `payments` p JOIN `fee_invoices` i ON i.`id` = p.`invoice_id` SET p.`branch_id` = i.`branch_id`;
ALTER TABLE `payments` DROP FOREIGN KEY `fk_payment_invoice`;
ALTER TABLE `payments`
  MODIFY `branch_id` bigint unsigned NOT NULL,
  ADD KEY `fk_payment_invoice` (`invoice_id`,`branch_id`),
  ADD KEY `idx_payments_branch` (`branch_id`,`status`,`paid_at`),
  ADD CONSTRAINT `fk_payment_invoice` FOREIGN KEY (`invoice_id`,`branch_id`) REFERENCES `fee_invoices` (`id`,`branch_id`);

-- ---------------------------------------------------------------- optional branch columns

ALTER TABLE `admission_enquiries`
  ADD COLUMN `branch_id` bigint unsigned NULL AFTER `interested_course_id`,
  ADD KEY `idx_enquiries_branch` (`branch_id`,`status`,`created_at`),
  ADD CONSTRAINT `fk_enquiries_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`);

ALTER TABLE `announcements`
  MODIFY `audience` enum('ALL','ADMINS','FACULTY','STUDENTS','BATCH','BRANCH') NOT NULL DEFAULT 'ALL',
  ADD COLUMN `branch_id` bigint unsigned NULL AFTER `batch_id`,
  ADD KEY `idx_announcements_branch` (`branch_id`,`status`,`publish_at`),
  ADD CONSTRAINT `fk_announcement_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  ADD CONSTRAINT `chk_announcement_branch` CHECK ((((`audience` = _utf8mb4'BRANCH') and (`branch_id` is not null)) or ((`audience` <> _utf8mb4'BRANCH') and (`branch_id` is null))));

ALTER TABLE `audit_logs`
  ADD COLUMN `branch_id` bigint unsigned NULL AFTER `actor_user_id`,
  ADD KEY `idx_audit_branch` (`branch_id`,`created_at`),
  ADD CONSTRAINT `fk_audit_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`);

ALTER TABLE `student_profiles`
  ADD COLUMN `home_branch_id` bigint unsigned NULL AFTER `user_id`,
  ADD KEY `idx_student_home_branch` (`home_branch_id`),
  ADD CONSTRAINT `fk_student_home_branch` FOREIGN KEY (`home_branch_id`) REFERENCES `branches` (`id`);
