import numpy as np
import pandas as pd

def mean_if_exist(df, cols):
    cols = [c for c in cols if c in df.columns]
    return df[cols].mean(axis=1) if cols else 0


ANXIETY_AUS = ["AU4", "AU7", "AU23", "AU24"]
def calc_anx_score(df):
    # 핵심 불안 AU 평균 강도
    anxiety_intensity = mean_if_exist(df, ANXIETY_AUS).mean()

    # 0~100 정규화
    anxiety_score = np.clip(anxiety_intensity / 5 * 100, 0, 100)

    return round(anxiety_score, 1)

# POSITIVE_AUS = ["AU12"] #+AU6?
def calc_pos_score(df):
    if "AU12" not in df.columns:
        return 0.0

    au12_mean = df["AU12"].mean()
    # 최소값 제한
    au12_mean = min(au12_mean, 2.0)

    # 최대 +20점
    return round(au12_mean / 2.0 * 20, 1)

def calc_total_expression_score(df):
    anxiety = calc_anx_score(df)
    positive = calc_pos_score(df)

    expression_score = np.clip(80 - anxiety + positive,0, 100)

    return {
        "anxiety_score": anxiety,
        "positive_score": positive,
        "total_expression_score": round(expression_score, 1)
    }

def expression_text_feedback(score):
    if score >= 75:
        return "면접 상황에서 전반적으로 안정적인 표정을 유지했습니다."
    elif score >= 55:
        return "일부 긴장 신호가 있었으나 면접에 부정적인 영향을 주지는 않았습니다."
    else:
        return "긴장 또는 불안 표정이 비교적 많이 관찰되었습니다."