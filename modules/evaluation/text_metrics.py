from __future__ import annotations

from typing import List


def _tokenize_ko(text: str) -> List[str]:
    """
    단어 토큰 분리기 (WER용)

    - 한국어의 경우 공백 기준 토큰화만으로도 1차 베이스라인 평가는 가능함
    ※ 향후 형태소 분석기(Mecab 등)로 교체 가능한 구조로 설계됨
    """
    return [t for t in (text or "").strip().split() if t]


def _chars_ko(text: str) -> List[str]:
    """
    글자 토큰 분리기 (CER용)

    - 한국어 CER 은 띄어쓰기 차이를 무시하는 것이 일반적이라 공백을 제거하고
      글자 단위로 나눈다.
    """
    return [c for c in (text or "").replace(" ", "") if c.strip()]


def _edit_distance(ref: List[str], hyp: List[str]) -> int:
    """두 토큰열(단어/글자) 사이의 Levenshtein 편집 거리."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,        # deletion
                dp[i][j - 1] + 1,        # insertion
                dp[i - 1][j - 1] + cost,  # substitution
            )
    return dp[n][m]


def wer(reference: str, hypothesis: str) -> float:
    """
    단어 오류율(Word Error Rate) — 기준 문장과 STT 결과의 '단어 단위' 편집 거리.

    참고 지표로 유지한다. 한국어는 띄어쓰기가 불안정해 WER 이 과대평가되는
    경향이 있어, 발음 점수는 글자 단위 CER 을 사용한다. (WER 은 비교용)
    """
    ref = _tokenize_ko(reference)
    hyp = _tokenize_ko(hypothesis)
    n = len(ref)
    if n == 0:
        return 0.0 if len(hyp) == 0 else 1.0
    return _edit_distance(ref, hyp) / float(n)


def cer(reference: str, hypothesis: str) -> float:
    """
    글자 오류율(Character Error Rate) — 기준 문장과 STT 결과의 '글자 단위' 편집 거리.

    한국어는 띄어쓰기가 불안정해 단어 단위(WER)보다 글자 단위(CER)가
    발음 정확도를 더 공정하게 반영한다. → 발음 점수 산출의 주 지표.
    """
    ref = _chars_ko(reference)
    hyp = _chars_ko(hypothesis)
    n = len(ref)
    if n == 0:
        return 0.0 if len(hyp) == 0 else 1.0
    return _edit_distance(ref, hyp) / float(n)
