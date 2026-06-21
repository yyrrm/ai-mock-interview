import librosa
import numpy as np


# import 시점에 sample.wav 를 읽다가 파일이 없으면 크래시 → 단독 실행시에만 동작하도록 가드
if __name__ == "__main__":
    # 오디오 로드
    y, sr = librosa.load("sample.wav")

    # 음량 계산 (RMS → dB)
    rms = librosa.feature.rms(y=y)
    db = librosa.amplitude_to_db(rms, ref=np.max)
    print("평균 음량 (dB):", np.mean(db))

    # 피치(기본 주파수) 추정
    pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
    pitch_mean = np.mean(pitches[pitches > 0])
    print("평균 피치 (Hz):", pitch_mean)
