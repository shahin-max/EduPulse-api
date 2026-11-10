-- Baseline: the original edupulse_lms schema, exported verbatim with SHOW CREATE TABLE.
-- It was already applied to edupulse_lms by hand and is marked applied there via `prisma migrate resolve`.

CREATE TABLE `users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `public_id` char(36) NOT NULL,
  `full_name` varchar(160) NOT NULL,
  `email` varchar(254) DEFAULT NULL,
  `mobile` varchar(20) DEFAULT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `status` enum('PENDING','ACTIVE','SUSPENDED','DISABLED') NOT NULL DEFAULT 'PENDING',
  `email_verified_at` datetime(3) DEFAULT NULL,
  `mobile_verified_at` datetime(3) DEFAULT NULL,
  `last_login_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_public` (`public_id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_mobile` (`mobile`),
  KEY `idx_users_status` (`status`),
  KEY `idx_users_created` (`created_at`),
  CONSTRAINT `chk_users_contact` CHECK (((`email` is not null) or (`mobile` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `file_assets` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `bucket` varchar(128) NOT NULL,
  `object_key` varchar(512) NOT NULL,
  `original_filename` varchar(255) NOT NULL,
  `mime_type` varchar(120) NOT NULL,
  `size_bytes` bigint unsigned NOT NULL,
  `visibility` enum('PRIVATE','PUBLIC') NOT NULL DEFAULT 'PRIVATE',
  `uploaded_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assets_object` (`bucket`,`object_key`),
  KEY `fk_assets_uploader` (`uploaded_by`),
  CONSTRAINT `fk_assets_uploader` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `courses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(40) NOT NULL,
  `slug` varchar(160) NOT NULL,
  `title` varchar(200) NOT NULL,
  `description` text,
  `thumbnail_asset_id` bigint unsigned DEFAULT NULL,
  `status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_courses_code` (`code`),
  UNIQUE KEY `uq_courses_slug` (`slug`),
  KEY `idx_courses_status` (`status`,`sort_order`),
  KEY `fk_courses_creator` (`created_by`),
  KEY `fk_course_thumbnail` (`thumbnail_asset_id`),
  CONSTRAINT `fk_course_thumbnail` FOREIGN KEY (`thumbnail_asset_id`) REFERENCES `file_assets` (`id`),
  CONSTRAINT `fk_courses_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admission_enquiries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `student_name` varchar(160) NOT NULL,
  `email` varchar(254) DEFAULT NULL,
  `mobile` varchar(20) NOT NULL,
  `interested_course_id` bigint unsigned DEFAULT NULL,
  `message` text,
  `source` varchar(64) DEFAULT NULL,
  `status` enum('NEW','CONTACTED','FOLLOW_UP','CONVERTED','CLOSED') NOT NULL DEFAULT 'NEW',
  `assigned_to` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_enquiries_status` (`status`,`created_at`),
  KEY `idx_enquiries_course` (`interested_course_id`),
  KEY `fk_enquiries_assignee` (`assigned_to`),
  CONSTRAINT `fk_enquiries_assignee` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_enquiries_course` FOREIGN KEY (`interested_course_id`) REFERENCES `courses` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `batches` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_id` bigint unsigned NOT NULL,
  `code` varchar(50) NOT NULL,
  `name` varchar(160) NOT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `capacity` int unsigned DEFAULT NULL,
  `status` enum('PLANNED','ACTIVE','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PLANNED',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batches_code` (`code`),
  KEY `idx_batches_course` (`course_id`,`status`),
  CONSTRAINT `fk_batches_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`),
  CONSTRAINT `chk_batch_dates` CHECK (((`end_date` is null) or (`start_date` is null) or (`end_date` >= `start_date`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `announcements` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL,
  `body` text NOT NULL,
  `audience` enum('ALL','ADMINS','FACULTY','STUDENTS','BATCH') NOT NULL DEFAULT 'ALL',
  `batch_id` bigint unsigned DEFAULT NULL,
  `status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `publish_at` datetime(3) DEFAULT NULL,
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_announcements_status` (`status`,`publish_at`),
  KEY `fk_announcement_batch` (`batch_id`),
  KEY `fk_announcement_creator` (`created_by`),
  CONSTRAINT `fk_announcement_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_announcement_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_announcement_batch` CHECK ((((`audience` = _utf8mb4'BATCH') and (`batch_id` is not null)) or ((`audience` <> _utf8mb4'BATCH') and (`batch_id` is null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `subjects` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) NOT NULL,
  `name` varchar(120) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subjects_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `assignments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` bigint unsigned NOT NULL,
  `subject_id` bigint unsigned DEFAULT NULL,
  `title` varchar(200) NOT NULL,
  `instructions` text,
  `attachment_asset_id` bigint unsigned DEFAULT NULL,
  `due_at` datetime(3) DEFAULT NULL,
  `max_marks` decimal(8,2) DEFAULT NULL,
  `status` enum('DRAFT','PUBLISHED','CLOSED') NOT NULL DEFAULT 'DRAFT',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assignment_batch` (`id`,`batch_id`),
  KEY `idx_assignment_batch` (`batch_id`,`due_at`),
  KEY `fk_assignment_subject` (`subject_id`),
  KEY `fk_assignment_asset` (`attachment_asset_id`),
  KEY `fk_assignment_creator` (`created_by`),
  CONSTRAINT `fk_assignment_asset` FOREIGN KEY (`attachment_asset_id`) REFERENCES `file_assets` (`id`),
  CONSTRAINT `fk_assignment_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_assignment_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_assignment_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`),
  CONSTRAINT `chk_assignment_max` CHECK (((`max_marks` is null) or (`max_marks` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `student_profiles` (
  `user_id` bigint unsigned NOT NULL,
  `admission_number` varchar(40) DEFAULT NULL,
  `date_of_birth` date DEFAULT NULL,
  `grade` varchar(30) DEFAULT NULL,
  `school_name` varchar(160) DEFAULT NULL,
  `guardian_name` varchar(160) DEFAULT NULL,
  `guardian_mobile` varchar(20) DEFAULT NULL,
  `address` text,
  `joined_on` date DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_student_admission` (`admission_number`),
  CONSTRAINT `fk_student_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `enrollments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `student_user_id` bigint unsigned NOT NULL,
  `batch_id` bigint unsigned NOT NULL,
  `status` enum('PENDING','ACTIVE','PAUSED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `enrolled_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) DEFAULT NULL,
  `access_starts_at` datetime(3) DEFAULT NULL,
  `access_ends_at` datetime(3) DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `created_by` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_enrollment` (`student_user_id`,`batch_id`),
  UNIQUE KEY `uq_enrollment_batch` (`id`,`batch_id`),
  KEY `idx_enrollments_batch` (`batch_id`,`status`),
  KEY `fk_enrollments_creator` (`created_by`),
  CONSTRAINT `fk_enrollments_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_enrollments_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_enrollments_student` FOREIGN KEY (`student_user_id`) REFERENCES `student_profiles` (`user_id`),
  CONSTRAINT `chk_enrollment_access` CHECK (((`access_ends_at` is null) or (`access_starts_at` is null) or (`access_ends_at` > `access_starts_at`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `assignment_submissions` (
  `batch_id` bigint unsigned NOT NULL,
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `assignment_id` bigint unsigned NOT NULL,
  `enrollment_id` bigint unsigned NOT NULL,
  `asset_id` bigint unsigned DEFAULT NULL,
  `response_text` text,
  `submitted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `marks_awarded` decimal(8,2) DEFAULT NULL,
  `feedback` text,
  `reviewed_by` bigint unsigned DEFAULT NULL,
  `reviewed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_submission` (`assignment_id`,`enrollment_id`),
  KEY `fk_submission_assignment` (`assignment_id`,`batch_id`),
  KEY `fk_submission_enrollment` (`enrollment_id`,`batch_id`),
  KEY `fk_submission_asset` (`asset_id`),
  KEY `fk_submission_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_submission_asset` FOREIGN KEY (`asset_id`) REFERENCES `file_assets` (`id`),
  CONSTRAINT `fk_submission_assignment` FOREIGN KEY (`assignment_id`, `batch_id`) REFERENCES `assignments` (`id`, `batch_id`),
  CONSTRAINT `fk_submission_enrollment` FOREIGN KEY (`enrollment_id`, `batch_id`) REFERENCES `enrollments` (`id`, `batch_id`),
  CONSTRAINT `fk_submission_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_submission_content` CHECK (((`asset_id` is not null) or (`response_text` is not null))),
  CONSTRAINT `chk_submission_score` CHECK (((`marks_awarded` is null) or (`marks_awarded` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `exams` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_id` bigint unsigned NOT NULL,
  `subject_id` bigint unsigned DEFAULT NULL,
  `title` varchar(200) NOT NULL,
  `kind` enum('DAILY_PRACTICE','CHAPTER_TEST','MOCK_TEST','OMR_PRACTICE') NOT NULL,
  `duration_minutes` int unsigned NOT NULL,
  `total_marks` decimal(10,2) NOT NULL DEFAULT '0.00',
  `negative_marks_per_wrong` decimal(8,2) NOT NULL DEFAULT '0.00',
  `max_attempts` smallint unsigned NOT NULL DEFAULT '1',
  `opens_at` datetime(3) DEFAULT NULL,
  `closes_at` datetime(3) DEFAULT NULL,
  `results_release_at` datetime(3) DEFAULT NULL,
  `answer_review_release_at` datetime(3) DEFAULT NULL,
  `ranking_attempt_policy` enum('FIRST','BEST','LATEST') NOT NULL DEFAULT 'FIRST',
  `show_result_immediately` tinyint(1) NOT NULL DEFAULT '1',
  `status` enum('DRAFT','PUBLISHED','CLOSED') NOT NULL DEFAULT 'DRAFT',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_exam_course` (`course_id`,`status`),
  KEY `fk_exam_subject` (`subject_id`),
  KEY `fk_exam_creator` (`created_by`),
  CONSTRAINT `fk_exam_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`),
  CONSTRAINT `fk_exam_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_exam_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`),
  CONSTRAINT `chk_exam_duration` CHECK ((`duration_minutes` > 0)),
  CONSTRAINT `chk_exam_values` CHECK (((`max_attempts` > 0) and (`total_marks` >= 0) and (`negative_marks_per_wrong` >= 0))),
  CONSTRAINT `chk_exam_window` CHECK (((`closes_at` is null) or (`opens_at` is null) or (`closes_at` > `opens_at`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `exam_batches` (
  `exam_id` bigint unsigned NOT NULL,
  `batch_id` bigint unsigned NOT NULL,
  PRIMARY KEY (`exam_id`,`batch_id`),
  KEY `fk_exam_batches_batch` (`batch_id`),
  CONSTRAINT `fk_exam_batches_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_exam_batches_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `exam_attempts` (
  `batch_id` bigint unsigned NOT NULL,
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `exam_id` bigint unsigned NOT NULL,
  `enrollment_id` bigint unsigned NOT NULL,
  `attempt_number` smallint unsigned NOT NULL,
  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `submitted_at` datetime(3) DEFAULT NULL,
  `expires_at` datetime(3) NOT NULL,
  `status` enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','INVALIDATED') NOT NULL DEFAULT 'IN_PROGRESS',
  `correct_count` int unsigned NOT NULL DEFAULT '0',
  `wrong_count` int unsigned NOT NULL DEFAULT '0',
  `unanswered_count` int unsigned NOT NULL DEFAULT '0',
  `score` decimal(10,2) DEFAULT NULL,
  `max_score` decimal(10,2) NOT NULL,
  `percentage` decimal(8,2) DEFAULT NULL,
  `graded_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attempt_exam` (`id`,`exam_id`),
  UNIQUE KEY `uq_exam_attempt` (`exam_id`,`enrollment_id`,`attempt_number`),
  KEY `idx_attempt_enrollment` (`enrollment_id`,`submitted_at`),
  KEY `idx_attempt_exam_rank` (`exam_id`,`status`,`score`,`submitted_at`),
  KEY `fk_attempt_batch` (`exam_id`,`batch_id`),
  KEY `fk_attempt_enrollment` (`enrollment_id`,`batch_id`),
  CONSTRAINT `fk_attempt_batch` FOREIGN KEY (`exam_id`, `batch_id`) REFERENCES `exam_batches` (`exam_id`, `batch_id`),
  CONSTRAINT `fk_attempt_enrollment` FOREIGN KEY (`enrollment_id`, `batch_id`) REFERENCES `enrollments` (`id`, `batch_id`),
  CONSTRAINT `fk_attempt_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`),
  CONSTRAINT `chk_attempt_max` CHECK ((`max_score` > 0)),
  CONSTRAINT `chk_attempt_number` CHECK ((`attempt_number` > 0)),
  CONSTRAINT `chk_attempt_percentage` CHECK (((`percentage` is null) or (`percentage` <= 100))),
  CONSTRAINT `chk_attempt_times` CHECK (((`expires_at` > `started_at`) and ((`submitted_at` is null) or (`submitted_at` >= `started_at`))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `course_subjects` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_id` bigint unsigned NOT NULL,
  `subject_id` bigint unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_course_subject` (`course_id`,`subject_id`),
  KEY `fk_course_subjects_subject` (`subject_id`),
  CONSTRAINT `fk_course_subjects_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`),
  CONSTRAINT `fk_course_subjects_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `chapters` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_subject_id` bigint unsigned NOT NULL,
  `title` varchar(200) NOT NULL,
  `description` text,
  `sort_order` int NOT NULL DEFAULT '0',
  `is_published` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_chapters_parent` (`course_subject_id`,`sort_order`),
  CONSTRAINT `fk_chapters_course_subject` FOREIGN KEY (`course_subject_id`) REFERENCES `course_subjects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `questions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_subject_id` bigint unsigned NOT NULL,
  `chapter_id` bigint unsigned DEFAULT NULL,
  `question_text` text NOT NULL,
  `explanation` text,
  `difficulty` enum('EASY','MEDIUM','HARD') NOT NULL DEFAULT 'MEDIUM',
  `kind` enum('SINGLE_CHOICE') NOT NULL DEFAULT 'SINGLE_CHOICE',
  `marks_default` decimal(8,2) NOT NULL DEFAULT '1.00',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_questions_course_subject` (`course_subject_id`,`chapter_id`),
  KEY `fk_question_chapter` (`chapter_id`),
  KEY `fk_question_creator` (`created_by`),
  CONSTRAINT `fk_question_chapter` FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`),
  CONSTRAINT `fk_question_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_question_cs` FOREIGN KEY (`course_subject_id`) REFERENCES `course_subjects` (`id`),
  CONSTRAINT `chk_question_marks` CHECK ((`marks_default` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `question_options` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `question_id` bigint unsigned NOT NULL,
  `option_text` text NOT NULL,
  `option_label` varchar(8) NOT NULL,
  `is_correct` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_option_question` (`id`,`question_id`),
  UNIQUE KEY `uq_question_option_label` (`question_id`,`option_label`),
  KEY `idx_options_question` (`question_id`,`sort_order`),
  CONSTRAINT `fk_option_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `exam_questions` (
  `exam_id` bigint unsigned NOT NULL,
  `question_id` bigint unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `marks` decimal(8,2) NOT NULL DEFAULT '1.00',
  `negative_marks` decimal(8,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`exam_id`,`question_id`),
  UNIQUE KEY `uq_exam_question_order` (`exam_id`,`sort_order`),
  KEY `idx_exam_questions_order` (`exam_id`,`sort_order`),
  KEY `fk_exam_questions_question` (`question_id`),
  CONSTRAINT `fk_exam_questions_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`),
  CONSTRAINT `fk_exam_questions_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`),
  CONSTRAINT `chk_exam_question_marks` CHECK ((`marks` >= 0)),
  CONSTRAINT `chk_exam_question_negative` CHECK ((`negative_marks` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `attempt_answers` (
  `exam_id` bigint unsigned NOT NULL,
  `display_order` int unsigned NOT NULL,
  `is_marked_for_review` tinyint(1) NOT NULL DEFAULT '0',
  `attempt_id` bigint unsigned NOT NULL,
  `question_id` bigint unsigned NOT NULL,
  `selected_option_id` bigint unsigned DEFAULT NULL,
  `is_correct` tinyint(1) DEFAULT NULL,
  `marks_awarded` decimal(8,2) DEFAULT NULL,
  `answered_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`attempt_id`,`question_id`),
  KEY `fk_answer_attempt` (`attempt_id`,`exam_id`),
  KEY `fk_answer_question` (`exam_id`,`question_id`),
  KEY `fk_answer_option` (`selected_option_id`,`question_id`),
  CONSTRAINT `fk_answer_attempt` FOREIGN KEY (`attempt_id`, `exam_id`) REFERENCES `exam_attempts` (`id`, `exam_id`),
  CONSTRAINT `fk_answer_option` FOREIGN KEY (`selected_option_id`, `question_id`) REFERENCES `question_options` (`id`, `question_id`),
  CONSTRAINT `fk_answer_question` FOREIGN KEY (`exam_id`, `question_id`) REFERENCES `exam_questions` (`exam_id`, `question_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `audit_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `actor_user_id` bigint unsigned DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `entity_type` varchar(80) NOT NULL,
  `entity_id` varchar(80) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_audit_entity` (`entity_type`,`entity_id`),
  KEY `idx_audit_actor` (`actor_user_id`,`created_at`),
  CONSTRAINT `fk_audit_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `auth_sessions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `token_hash` char(64) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `revoked_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_auth_sessions_hash` (`token_hash`),
  KEY `idx_auth_sessions_user` (`user_id`),
  KEY `idx_auth_sessions_exp` (`expires_at`),
  CONSTRAINT `fk_auth_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `auth_tokens` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `purpose` enum('PASSWORD_RESET','EMAIL_VERIFY','MOBILE_VERIFY') NOT NULL,
  `token_hash` char(64) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `used_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_auth_tokens_hash` (`token_hash`),
  KEY `idx_auth_tokens_user` (`user_id`,`purpose`),
  CONSTRAINT `fk_auth_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `faculty_profiles` (
  `user_id` bigint unsigned NOT NULL,
  `employee_code` varchar(40) DEFAULT NULL,
  `qualification` varchar(255) DEFAULT NULL,
  `specialization` varchar(255) DEFAULT NULL,
  `biography` text,
  `joined_on` date DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_faculty_code` (`employee_code`),
  CONSTRAINT `fk_faculty_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `batch_faculty` (
  `batch_id` bigint unsigned NOT NULL,
  `faculty_user_id` bigint unsigned NOT NULL,
  `subject_id` bigint unsigned NOT NULL,
  `assigned_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`batch_id`,`faculty_user_id`,`subject_id`),
  KEY `idx_batch_faculty_user` (`faculty_user_id`),
  KEY `fk_batch_faculty_subject` (`subject_id`),
  CONSTRAINT `fk_batch_faculty_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_batch_faculty_faculty` FOREIGN KEY (`faculty_user_id`) REFERENCES `faculty_profiles` (`user_id`),
  CONSTRAINT `fk_batch_faculty_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `class_sessions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` bigint unsigned NOT NULL,
  `subject_id` bigint unsigned DEFAULT NULL,
  `faculty_user_id` bigint unsigned DEFAULT NULL,
  `title` varchar(200) NOT NULL,
  `starts_at` datetime(3) NOT NULL,
  `ends_at` datetime(3) NOT NULL,
  `meeting_url` varchar(2048) DEFAULT NULL,
  `recording_url` varchar(2048) DEFAULT NULL,
  `status` enum('SCHEDULED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_session_batch` (`id`,`batch_id`),
  KEY `idx_class_batch_time` (`batch_id`,`starts_at`),
  KEY `fk_class_subject` (`subject_id`),
  KEY `fk_class_faculty` (`faculty_user_id`),
  CONSTRAINT `fk_class_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_class_faculty` FOREIGN KEY (`faculty_user_id`) REFERENCES `faculty_profiles` (`user_id`),
  CONSTRAINT `fk_class_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`),
  CONSTRAINT `chk_class_time` CHECK ((`ends_at` > `starts_at`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `class_attendance` (
  `batch_id` bigint unsigned NOT NULL,
  `class_session_id` bigint unsigned NOT NULL,
  `enrollment_id` bigint unsigned NOT NULL,
  `status` enum('PRESENT','ABSENT','LATE','EXCUSED') NOT NULL,
  `marked_by` bigint unsigned DEFAULT NULL,
  `marked_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`class_session_id`,`enrollment_id`),
  KEY `idx_attendance_enrollment` (`enrollment_id`),
  KEY `fk_attendance_session` (`class_session_id`,`batch_id`),
  KEY `fk_attendance_enrollment` (`enrollment_id`,`batch_id`),
  KEY `fk_attendance_marker` (`marked_by`),
  CONSTRAINT `fk_attendance_enrollment` FOREIGN KEY (`enrollment_id`, `batch_id`) REFERENCES `enrollments` (`id`, `batch_id`),
  CONSTRAINT `fk_attendance_marker` FOREIGN KEY (`marked_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_attendance_session` FOREIGN KEY (`class_session_id`, `batch_id`) REFERENCES `class_sessions` (`id`, `batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `fee_plans` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `course_id` bigint unsigned NOT NULL,
  `batch_id` bigint unsigned DEFAULT NULL,
  `title` varchar(160) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'INR',
  `amount` decimal(12,2) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_fee_plans_course` (`course_id`,`batch_id`),
  KEY `fk_fee_plan_batch` (`batch_id`),
  CONSTRAINT `fk_fee_plan_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_fee_plan_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`),
  CONSTRAINT `chk_fee_amount` CHECK ((`amount` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `fee_invoices` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `invoice_number` varchar(50) NOT NULL,
  `enrollment_id` bigint unsigned NOT NULL,
  `fee_plan_id` bigint unsigned DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `gross_amount` decimal(12,2) NOT NULL,
  `amount_due` decimal(12,2) GENERATED ALWAYS AS ((`gross_amount` - `discount_amount`)) STORED,
  `discount_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `due_date` date DEFAULT NULL,
  `status` enum('DRAFT','ISSUED','PART_PAID','PAID','VOID') NOT NULL DEFAULT 'DRAFT',
  `issued_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_number` (`invoice_number`),
  KEY `idx_invoice_enrollment` (`enrollment_id`,`status`),
  KEY `fk_invoice_plan` (`fee_plan_id`),
  CONSTRAINT `fk_invoice_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`id`),
  CONSTRAINT `fk_invoice_plan` FOREIGN KEY (`fee_plan_id`) REFERENCES `fee_plans` (`id`),
  CONSTRAINT `chk_invoice_amount` CHECK (((`gross_amount` >= 0) and (`discount_amount` >= 0) and (`discount_amount` <= `gross_amount`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `study_materials` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `chapter_id` bigint unsigned NOT NULL,
  `title` varchar(200) NOT NULL,
  `kind` enum('PDF_NOTE','WORKSHEET','PREVIOUS_PAPER','VIDEO_LINK','OTHER') NOT NULL,
  `asset_id` bigint unsigned DEFAULT NULL,
  `external_url` varchar(2048) DEFAULT NULL,
  `is_downloadable` tinyint(1) NOT NULL DEFAULT '0',
  `is_published` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_material_chapter` (`chapter_id`,`is_published`,`sort_order`),
  KEY `fk_material_asset` (`asset_id`),
  KEY `fk_material_creator` (`created_by`),
  CONSTRAINT `fk_material_asset` FOREIGN KEY (`asset_id`) REFERENCES `file_assets` (`id`),
  CONSTRAINT `fk_material_chapter` FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`),
  CONSTRAINT `fk_material_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_material_location` CHECK (((`asset_id` is not null) or (`external_url` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `material_progress` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `enrollment_id` bigint unsigned NOT NULL,
  `material_id` bigint unsigned NOT NULL,
  `status` enum('NOT_STARTED','IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'NOT_STARTED',
  `last_accessed_at` datetime(3) DEFAULT NULL,
  `completed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_material_progress` (`enrollment_id`,`material_id`),
  KEY `fk_progress_material` (`material_id`),
  CONSTRAINT `fk_progress_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`id`),
  CONSTRAINT `fk_progress_material` FOREIGN KEY (`material_id`) REFERENCES `study_materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notifications` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `title` varchar(200) NOT NULL,
  `message` text NOT NULL,
  `link_url` varchar(2048) DEFAULT NULL,
  `read_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user` (`user_id`,`read_at`,`created_at`),
  CONSTRAINT `fk_notification_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `payments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `invoice_id` bigint unsigned NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'INR',
  `method` enum('CASH','BANK_TRANSFER','UPI','CARD','OTHER') NOT NULL,
  `provider` varchar(40) DEFAULT NULL,
  `external_reference` varchar(120) DEFAULT NULL,
  `idempotency_key` varchar(100) NOT NULL,
  `receipt_number` varchar(50) DEFAULT NULL,
  `status` enum('PENDING','CONFIRMED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `paid_at` datetime(3) DEFAULT NULL,
  `recorded_by` bigint unsigned DEFAULT NULL,
  `notes` text,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_idempotency` (`idempotency_key`),
  UNIQUE KEY `uq_payment_provider_ref` (`provider`,`external_reference`),
  UNIQUE KEY `uq_payment_receipt` (`receipt_number`),
  KEY `idx_payments_invoice` (`invoice_id`,`status`),
  KEY `idx_payments_ref` (`external_reference`),
  KEY `fk_payment_recorder` (`recorded_by`),
  CONSTRAINT `fk_payment_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `fee_invoices` (`id`),
  CONSTRAINT `fk_payment_recorder` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_payment_amount` CHECK ((`amount` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `payment_refunds` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `payment_id` bigint unsigned NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `status` enum('PENDING','CONFIRMED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `idempotency_key` varchar(100) NOT NULL,
  `external_reference` varchar(120) DEFAULT NULL,
  `reason` varchar(500) NOT NULL,
  `refunded_at` datetime(3) DEFAULT NULL,
  `recorded_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refund_idempotency` (`idempotency_key`),
  KEY `idx_refunds_payment` (`payment_id`,`status`),
  KEY `fk_refund_recorder` (`recorded_by`),
  CONSTRAINT `fk_refund_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`),
  CONSTRAINT `fk_refund_recorder` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_refund_amount` CHECK ((`amount` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `roles` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL,
  `label` varchar(80) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `user_roles` (
  `user_id` bigint unsigned NOT NULL,
  `role_id` smallint unsigned NOT NULL,
  `assigned_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`role_id`),
  KEY `fk_user_roles_role` (`role_id`),
  CONSTRAINT `fk_user_roles_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`),
  CONSTRAINT `fk_user_roles_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `website_content` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `content_key` varchar(100) NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `body` longtext,
  `image_asset_id` bigint unsigned DEFAULT NULL,
  `is_published` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `updated_by` bigint unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_website_content_key` (`content_key`),
  KEY `fk_content_asset` (`image_asset_id`),
  KEY `fk_content_editor` (`updated_by`),
  CONSTRAINT `fk_content_asset` FOREIGN KEY (`image_asset_id`) REFERENCES `file_assets` (`id`),
  CONSTRAINT `fk_content_editor` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Reference data the application depends on.
INSERT INTO `roles` (`id`, `code`, `label`) VALUES (1, 'ADMIN', 'Administrator'), (2, 'FACULTY', 'Faculty'), (3, 'STUDENT', 'Student');
