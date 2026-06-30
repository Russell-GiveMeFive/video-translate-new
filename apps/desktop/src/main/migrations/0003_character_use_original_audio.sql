-- 0003_character_use_original_audio.sql
-- v0.4.16: 用户手动开关：mix-render 用 segments.src_audio_path 代替 TTS 产物
-- 适用：克隆样本太短、克隆失败、或用户就是喜欢原音
ALTER TABLE characters ADD COLUMN use_original_audio INTEGER NOT NULL DEFAULT 0;