-- Profile photos (stored on Cloudinary). Additive: existing rows get NULL.
ALTER TABLE `users`
  ADD COLUMN `photo_url` varchar(512) DEFAULT NULL AFTER `last_login_at`,
  ADD COLUMN `photo_public_id` varchar(255) DEFAULT NULL AFTER `photo_url`;
