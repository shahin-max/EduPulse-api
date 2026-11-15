-- Call notes on admission enquiries ("called, asked to call back Monday"), written by the admin or the
-- assigned faculty member. Notes go with their enquiry; the author is kept even if the user is removed.
CREATE TABLE `enquiry_notes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `enquiry_id` bigint unsigned NOT NULL,
  `author_id` bigint unsigned DEFAULT NULL,
  `body` text NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_enquiry_notes_enquiry` (`enquiry_id`, `created_at`),
  KEY `fk_enquiry_notes_author` (`author_id`),
  CONSTRAINT `fk_enquiry_notes_enquiry` FOREIGN KEY (`enquiry_id`) REFERENCES `admission_enquiries` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_enquiry_notes_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
