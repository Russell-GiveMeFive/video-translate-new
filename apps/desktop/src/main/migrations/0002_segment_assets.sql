-- v0.5 segments 加列：TTS 调用快照 + 用户手动 override + segment 代表帧
-- 目的：让"工作台"面板能展示每个 segment 实际用了什么参数生成，让用户可手动覆写

ALTER TABLE segments ADD COLUMN thumb_path TEXT;

-- TTS 调用快照（每次合成后写）
ALTER TABLE segments ADD COLUMN tts_input_text TEXT;
ALTER TABLE segments ADD COLUMN tts_voice_id   TEXT;
ALTER TABLE segments ADD COLUMN tts_emotion    TEXT;
ALTER TABLE segments ADD COLUMN tts_intensity  REAL;
ALTER TABLE segments ADD COLUMN tts_speed      REAL;
ALTER TABLE segments ADD COLUMN tts_vol        REAL;
ALTER TABLE segments ADD COLUMN tts_pitch      INTEGER;

-- 用户手动 override（非 NULL 时优先于自动推断）
ALTER TABLE segments ADD COLUMN user_emotion       TEXT;
ALTER TABLE segments ADD COLUMN user_voice_id      TEXT;
ALTER TABLE segments ADD COLUMN user_intensity     REAL;
ALTER TABLE segments ADD COLUMN user_speed         REAL;
