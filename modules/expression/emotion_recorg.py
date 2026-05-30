def emotion_detect(frame_path, detector=None):
    emotion_cols = ['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise', 'neutral']

    fex = detector.detect_image(frame_path)

    if fex is not None and not fex.empty:
        float_fex = fex.emotions.astype(float)
        float_fex = float_fex[emotion_cols].round(4)
        dominant = float_fex.idxmax(axis=1).values[0]

        return {
            "emotions": float_fex[emotion_cols].iloc[0].to_dict(),
            "dominant": dominant
        }
    else:
        return None