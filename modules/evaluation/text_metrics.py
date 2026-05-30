from __future__ import annotations

from dataclasses import dataclass
from typing import List


def _tokenize_ko(text: str) -> List[str]:
    """
    단순 토큰 분리기

    - WER 계산을 위한 기본 토큰화 기능 제공
    - 한국어의 경우 공백 기준 토큰화만으로도
     1차 베이스라인 평가는 가능함

    ※ 향후 형태소 분석기(Mecab 등)로
      교체 가능한 구조로 설계됨
    """
    return [t for t in (text or "").strip().split() if t]


def wer(reference: str, hypothesis: str) -> float:
    """
    발음 정확도 평가를 위해
    기준 문장과 STT 결과 간의 편집 거리를 계산하여
    단어 오류율(WER)을 산출한다.
    """
    ref = _tokenize_ko(reference)
    hyp = _tokenize_ko(hypothesis)

    n = len(ref)
    if n == 0:
        return 0.0 if len(hyp) == 0 else 1.0

    # DP edit distance
    dp = [[0] * (len(hyp) + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(len(hyp) + 1):
        dp[0][j] = j

    for i in range(1, n + 1):
        for j in range(1, len(hyp) + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,      # deletion
                dp[i][j - 1] + 1,      # insertion
                dp[i - 1][j - 1] + cost  # substitution
            )

    return dp[n][len(hyp)] / float(n)
