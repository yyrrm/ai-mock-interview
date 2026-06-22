import numpy as np
emotion_buffer = []

def emo_stabilizer(data, window_size = 5):
    if data is None:
        return None
    else:
        # 현재 프레임 감정 확률 추가
        emotion_buffer.append(data["emotions"])
        if len(emotion_buffer) > window_size:
            emotion_buffer.pop(0)

        # 각 감정 컬럼별 이동평균 계산
        smoothed_emotions = {}
        emotions = data["emotions"].keys()

        for col in emotions:
            values = [item[col] for item in emotion_buffer]
            kernel = np.ones(len(values)) / len(values)

            avg = np.convolve(values, kernel, mode="valid")[-1]
            smoothed_emotions[col] = round(avg, 4)

        return {
            "smoothed": smoothed_emotions
        }
