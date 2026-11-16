-- Pictures in test questions and options (figures, diagrams, non-verbal reasoning). Optional; the
-- files are private file_assets that students can open only through an attempt at an exam using them.
ALTER TABLE `questions`
  ADD COLUMN `image_asset_id` bigint unsigned DEFAULT NULL AFTER `question_text`,
  ADD KEY `fk_question_image` (`image_asset_id`),
  ADD CONSTRAINT `fk_question_image` FOREIGN KEY (`image_asset_id`) REFERENCES `file_assets` (`id`);

ALTER TABLE `question_options`
  ADD COLUMN `image_asset_id` bigint unsigned DEFAULT NULL AFTER `option_text`,
  ADD KEY `fk_option_image` (`image_asset_id`),
  ADD CONSTRAINT `fk_option_image` FOREIGN KEY (`image_asset_id`) REFERENCES `file_assets` (`id`);
