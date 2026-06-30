-- 0004_segment_src_audio.sql
-- v0.4.16: 段原音路径（每段从 demix vocals.wav 切出来的 wav）
-- "使用原音"开关启用时，mix-render 用这个文件替 TTS 产物
ALTER TABLE segments ADD COLUMN src_audio_path TEXT;