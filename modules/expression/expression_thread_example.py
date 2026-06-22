# modules/expression/expression_thread_example.py

import os

os.environ["TQDM_DISABLE"] = "1"
try:
    import tqdm as _tqdm_mod
    _real_tqdm = _tqdm_mod.tqdm
    def _quiet_tqdm(*args, **kwargs):
        kwargs.setdefault("disable", True)
        return _real_tqdm(*args, **kwargs)
    _tqdm_mod.tqdm = _quiet_tqdm
except Exception:
    pass

try:
    import tqdm.auto as _tqdm_auto
    _real_tqdm2 = _tqdm_auto.tqdm
    def _quiet_tqdm2(*args, **kwargs):
        kwargs.setdefault("disable", True)
        return _real_tqdm2(*args, **kwargs)
    _tqdm_auto.tqdm = _quiet_tqdm2
except Exception:
    pass

import cv2
import threading
import queue
import tempfile
import time
import inspect
import numpy as np

try:
    import torch
    torch.set_grad_enabled(False)
except Exception:
    torch = None

from feat import Detector
import modules.shared_flags as flags
from modules.camera.camera_manager import shared_frame_queue
from modules.expression.AU_analyzer import calc_total_expression_score, expression_text_feedback

try:
    from modules.expression.emotion_stabilizer import emo_stabilizer
except Exception:
    emo_stabilizer = None

expression_result_queue = queue.Queue(maxsize=5)
pyfeat_detector = Detector()

USED_AU_LIST = ["AU4", "AU7", "AU23", "AU24", "AU12"]
AU_WINDOW = 60
au_buffer = []

def safe_put_latest(q, item):
    if q.full():
        try:
            q.get_nowait()
        except Exception:
            pass
    q.put(item)

def detect_image_safe(detector: Detector, img_path: str):
    if hasattr(detector, "detect_image"):
        fn = detector.detect_image
        sig = inspect.signature(fn)
        kwargs = {}
        if "batch_size" in sig.parameters:
            kwargs["batch_size"] = 1
        if "output_size" in sig.parameters:
            kwargs["output_size"] = (224, 224)
        if torch is not None:
            with torch.no_grad():
                return fn(img_path, **kwargs)
        return fn(img_path, **kwargs)

    if hasattr(detector, "detect"):
        if torch is not None:
            with torch.no_grad():
                return detector.detect(img_path, data_type="image")
        return detector.detect(img_path, data_type="image")

    if callable(detector):
        if torch is not None:
            with torch.no_grad():
                return detector(img_path)
        return detector(img_path)

    raise AttributeError("py-feat Detector API(detect_image/detect/__call__)를 찾지 못했습니다.")

def _norm_au_key(col: str):
    s = str(col).strip()
    s_up = s.upper()
    if s_up.startswith("AU") and len(s_up) >= 4 and s_up[2:4].isdigit():
        return f"AU{int(s_up[2:4])}"
    if s_up.startswith("AU") and s_up[2:].isdigit():
        return f"AU{int(s_up[2:])}"
    return None

def au_collect_from_fex(fex):
    if fex is None or len(fex) == 0:
        return None

    df_au = getattr(fex, "aus", None)
    if df_au is not None and hasattr(df_au, "empty") and (not df_au.empty):
        row = df_au.iloc[0]
        mapped = {}
        for col in df_au.columns:
            key = _norm_au_key(col)
            if key is not None:
                try:
                    mapped[key] = float(row[col])
                except Exception:
                    mapped[key] = 0.0
        return {au: float(mapped.get(au, 0.0)) for au in USED_AU_LIST}

    cols = getattr(fex, "columns", None)
    if cols is not None:
        row = fex.iloc[0]
        mapped = {}
        for col in cols:
            key = _norm_au_key(col)
            if key is not None:
                try:
                    mapped[key] = float(row[col])
                except Exception:
                    mapped[key] = 0.0
        return {au: float(mapped.get(au, 0.0)) for au in USED_AU_LIST}

    return None

def calc_live_au_score():
    if len(au_buffer) == 0:
        return None
    try:
        import pandas as pd
        df_au = pd.DataFrame(au_buffer)
        scores = calc_total_expression_score(df_au)
        total = scores.get("total_expression_score", None)
        if total is not None:
            scores["feedback"] = expression_text_feedback(total)
        return scores
    except Exception as e:
        return {"error": str(e)}

def extract_emotions(fex):
    try:
        emo_df = getattr(fex, "emotions", None)
        if emo_df is None or emo_df.empty:
            return None
        emo_df = emo_df.astype(float)
        preferred_cols = ["anger", "disgust", "fear", "happiness", "sadness", "surprise", "neutral"]
        cols = [c for c in preferred_cols if c in emo_df.columns]
        if cols:
            emo_df = emo_df[cols]
        emotions = emo_df.iloc[0].round(4).to_dict()
        if not emotions:
            return None
        dominant = max(emotions, key=emotions.get)
        data = {"emotions": emotions, "dominant": dominant}
        if emo_stabilizer is not None:
            try:
                sm = emo_stabilizer(data)
                if isinstance(sm, dict) and "smoothed" in sm:
                    data["smoothed"] = sm["smoothed"]
            except Exception:
                pass
        return data
    except Exception:
        return None

def expression_worker(padding=20, analyze_every_n_frames=3):
    print("Expression Thread Started")

    frame_idx = 0
    last_result_data = {
        "dominant": "ANALYZING...",
        "raw": None,
        "smooth": None,
        "bbox": None,
        "au_scores": None,
    }

    last_err = ""
    last_err_time = 0.0

    # 종료 시 1회 출력용: 최종 점수 저장만 해둠
    last_au_score_total = None

    while flags.RUNNING:
        if shared_frame_queue.empty():
            continue

        frame = shared_frame_queue.get()
        frame_idx += 1

        try:
            frame = cv2.resize(frame, (640, 480))
        except Exception:
            pass

        result_data = None
        do_analyze = (frame_idx % max(1, int(analyze_every_n_frames)) == 0)

        if do_analyze:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(prefix="exp_", suffix=".jpg")
                os.close(fd)
                cv2.imwrite(tmp_path, frame)

                fex = detect_image_safe(pyfeat_detector, tmp_path)

                if fex is None or len(fex) == 0:
                    result_data = dict(last_result_data)
                    result_data["dominant"] = "NO FACE"
                else:
                    emo = extract_emotions(fex)
                    if emo is None:
                        result_data = dict(last_result_data)
                        result_data["dominant"] = "NO FACE"
                    else:
                        au_scores = None
                        au_dict = au_collect_from_fex(fex)
                        if au_dict is not None:
                            au_buffer.append(au_dict)
                            if len(au_buffer) > AU_WINDOW:
                                au_buffer.pop(0)

                            au_scores = calc_live_au_score()
                            if isinstance(au_scores, dict) and "error" not in au_scores:
                                # print는 하지 않고, 최종 점수만 저장
                                last_au_score_total = au_scores.get("total_expression_score")

                        result_data = {
                            "dominant": emo.get("dominant"),
                            "raw": emo.get("emotions"),
                            "smooth": emo.get("smoothed", emo.get("emotions")),
                            "bbox": None,
                            "au_scores": au_scores,
                        }

            except Exception as e:
                msg = str(e)
                now = time.time()
                if (msg != last_err) or ((now - last_err_time) > 5.0):
                    print(f"Expression detect error: {msg}")
                    last_err = msg
                    last_err_time = now

                result_data = dict(last_result_data)
                result_data["dominant"] = "ERROR"

            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass

        if isinstance(result_data, dict):
            last_result_data = result_data

        safe_put_latest(expression_result_queue, (frame, last_result_data))

    # RUNNING=False로 루프가 끝난 뒤에만 1회 출력
    if last_au_score_total is not None:
        print("================================================")
        print("- 표정 분야 평가 결과 -")
        print("최종 AU 점수: ", last_au_score_total)
        print(expression_text_feedback(last_au_score_total))

    print("Expression Thread Stopped")

def start_expression_thread(_emotion_detector=None):
    t = threading.Thread(target=expression_worker, daemon=False)
    t.start()
    print("expression_thread_example 실행됨! (Camera 공유 버전)")
    return t