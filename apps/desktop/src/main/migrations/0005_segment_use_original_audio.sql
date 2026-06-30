-- 0005_segment_use_original_audio.sql
-- v0.4.22: 「使用原音」从 character 级降到 segment 级
-- 用户只想让"这一句"用原音 → mix-render 这一句跳过 TTS、用 src_audio_path
-- character 级的 use_original_audio 字段保留作为"一键全开"的隐式默认
ALTER TABLE segments ADD COLUMN use_original_audio INTEGER NOT NULL DEFAULT 0;
