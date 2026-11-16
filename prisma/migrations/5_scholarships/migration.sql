-- Scholarship Tests. Each test owns a candidates batch and an exam (in the hidden "Scholarship Tests"
-- course), so registration, the online test, marking and ranking reuse the batch and exam engine.
-- Awards record each candidate's result and the % off course fees they won; an award is used once,
-- by the fee invoice it was applied to (released again if that invoice is voided).
CREATE TABLE `scholarship_tests` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL,
  `description` text,
  `exam_id` bigint unsigned NOT NULL,
  `batch_id` bigint unsigned NOT NULL,
  `eligible_grades` varchar(255) DEFAULT NULL,
  `slabs` json NOT NULL,
  `registration_closes_at` datetime(3) DEFAULT NULL,
  `valid_until` date DEFAULT NULL,
  `status` enum('DRAFT','OPEN','RESULTS_PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  `results_published_at` datetime(3) DEFAULT NULL,
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_scholarship_exam` (`exam_id`),
  UNIQUE KEY `uq_scholarship_batch` (`batch_id`),
  KEY `idx_scholarship_status` (`status`),
  KEY `fk_scholarship_creator` (`created_by`),
  CONSTRAINT `fk_scholarship_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`),
  CONSTRAINT `fk_scholarship_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_scholarship_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `scholarship_awards` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `scholarship_test_id` bigint unsigned NOT NULL,
  `student_user_id` bigint unsigned NOT NULL,
  `percentage` decimal(8,2) DEFAULT NULL,
  `rank` int unsigned DEFAULT NULL,
  `discount_percent` decimal(5,2) NOT NULL DEFAULT '0.00',
  `is_override` tinyint(1) NOT NULL DEFAULT '0',
  `note` varchar(500) DEFAULT NULL,
  `used_invoice_id` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_scholarship_award` (`scholarship_test_id`, `student_user_id`),
  KEY `fk_award_student` (`student_user_id`),
  KEY `fk_award_invoice` (`used_invoice_id`),
  CONSTRAINT `fk_award_test` FOREIGN KEY (`scholarship_test_id`) REFERENCES `scholarship_tests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_award_student` FOREIGN KEY (`student_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_award_invoice` FOREIGN KEY (`used_invoice_id`) REFERENCES `fee_invoices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_award_discount` CHECK ((`discount_percent` >= 0) AND (`discount_percent` <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
