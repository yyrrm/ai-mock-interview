from __future__ import annotations

import wave
from dataclasses import dataclass
from typing import Tuple

import numpy as np


@dataclass
class AudioStats:
    duration_sec: float
    mean_db: float
    std_db: float
    silence_segments_2s: int


def _read_wav_mono_int16(path: str) -> Tuple[np.ndarray, int]:
    """Read a mono WAV file into int16 numpy array and return (samples, sample_rate)."""
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth != 2:
        raise ValueError(f"Only 16-bit PCM WAV is supported. sampwidth={sampwidth}")

    audio = np.frombuffer(raw, dtype=np.int16)
    if nch > 1:
        audio = audio.reshape(-1, nch).mean(axis=1).astype(np.int16)

    return audio, sr


def compute_audio_stats(
    wav_path: str,
    frame_ms: int = 30,
    silence_db_threshold: float = -45.0,
    min_silence_sec: float = 2.0,
) -> AudioStats:
    """
    음성 평가지표 계산에 필요한 기본 통계값을 산출하는 클래스

    - 짧은 프레임 단위로 음량(dB)의 평균 및 변동성 계산
    - 일정 시간 이상 지속된 침묵 구간의 개수 계산

    참고:
    - int16 형식 음성 신호의 RMS 값을 기반으로 dB를 추정한다.
    - 침묵 판단 기준값은 실험 환경에 따라 조정 가능하다.
    """
    samples, sr = _read_wav_mono_int16(wav_path)
    duration_sec = float(len(samples)) / float(sr) if sr > 0 else 0.0

    if len(samples) == 0 or sr <= 0:
        return AudioStats(duration_sec=0.0, mean_db=-120.0, std_db=0.0, silence_segments_2s=0)

    frame_len = int(sr * (frame_ms / 1000.0))
    if frame_len <= 0:
        frame_len = 1

    # Pad to full frames
    pad = (-len(samples)) % frame_len
    if pad:
        samples = np.pad(samples, (0, pad), mode="constant")

    frames = samples.reshape(-1, frame_len).astype(np.float32)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    # Convert to dBFS-ish relative to int16 full-scale.
    db = 20.0 * np.log10(rms / 32768.0 + 1e-12)

    mean_db = float(np.mean(db))
    std_db = float(np.std(db))

    # Silence segment counting (continuous frames below threshold)
    silence_mask = db < silence_db_threshold
    min_frames = int((min_silence_sec * 1000.0) / frame_ms)
    silence_segments = 0

    run = 0
    for is_sil in silence_mask:
        if is_sil:
            run += 1
        else:
            if run >= min_frames:
                silence_segments += 1
            run = 0
    if run >= min_frames:
        silence_segments += 1

    return AudioStats(
        duration_sec=duration_sec,
        mean_db=mean_db,
        std_db=std_db,
        silence_segments_2s=silence_segments,
    )
