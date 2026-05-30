# main.py
import time
import cv2
import numpy as np

# ===============================
# 한글 출력(PIL)
# ===============================
from PIL import ImageFont, ImageDraw, Image

# ===============================
# OPENAI 질문생성
# ===============================
from modules.question.question_module import make_question

# ===============================
# 공유 RUNNING 플래그
# ===============================
from modules.shared_flags import RUNNING

# ===============================
# 단일 카메라 스레드
# ===============================
from modules.camera.camera_manager import start_camera_thread

# ===============================
# 모듈별 스레드 & 큐
# ===============================
from modules.pose.pose_thread_example import start_pose_thread, result_queue as pose_result_queue
from modules.gaze.gaze_thread_example import start_gaze_thread, gaze_result_queue, request_gaze_calibration
from modules.expression.expression_thread_example import start_expression_thread, expression_result_queue
from modules.hands.hand_thread_example import start_hands_thread, hands_result_queue
from modules.voice.voice_thread_example import start_voice_thread, voice_result_queue


# ===============================
# 최신 값만 가져오기
# ===============================
def drain_queue(q):
    latest = None
    while not q.empty():
        latest = q.get()
    return latest


# ===============================
# 한글 텍스트 출력 함수
# ===============================
def put_korean_text(
    img_bgr,
    text,
    x,
    y,
    font_size=28,
    color=(0, 255, 255),
    font_path=r"C:\Windows\Fonts\malgun.ttf",
):
    if text is None:
        return img_bgr

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(img_rgb)
    draw = ImageDraw.Draw(pil_img)

    try:
        font = ImageFont.truetype(font_path, font_size)
    except Exception:
        font = ImageFont.load_default()

    draw.text((x, y), str(text), font=font, fill=(color[2], color[1], color[0]))
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


# ===============================
# 메인 실행부
# ===============================
def main():
    emotion_detector = None

    start_camera_thread()
    start_pose_thread()
    start_gaze_thread()
    start_expression_thread(emotion_detector)
    start_hands_thread()
    start_voice_thread()

    print("================================================")
    print("AI Mock Interview — Main Started (q 또는 X로 종료)\n")
    print("키 안내: [c] 시선 보정  |  [n] 다음 질문  |  [q] 종료")
    print("================================================\n")

    latest_pose = None
    latest_gaze = None
    latest_expr = None
    latest_hands = None
    latest_voice = None

    window_name = "AI Mock Interview - Dashboard"

    last_voice_text = None
    last_question_time = 0.0
    QUESTION_COOLDOWN = 3.0

    latest_question = "간단히 자기소개 부탁드립니다."
    printed_start_question = False

    # 이미 물어본 질문 이력(중복 질문 방지용)
    asked_questions = [latest_question]

    while True:

        pose_data = drain_queue(pose_result_queue)
        gaze_data = drain_queue(gaze_result_queue)
        expr_data = drain_queue(expression_result_queue)
        hands_data = drain_queue(hands_result_queue)
        voice_data = drain_queue(voice_result_queue)

        if pose_data is not None:
            latest_pose = pose_data
        if gaze_data is not None:
            latest_gaze = gaze_data
        if expr_data is not None:
            latest_expr = expr_data
        if hands_data is not None:
            latest_hands = hands_data
        if voice_data is not None:
            latest_voice = voice_data

        dashboard = np.zeros((800, 1200, 3), dtype=np.uint8)

        cv2.putText(
            dashboard,
            "AI Mock Interview Dashboard",
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.0,
            (0, 255, 0),
            2,
        )

        # ===== Pose =====
        if latest_pose is not None:
            frame, motion, _ = latest_pose
            f = cv2.resize(frame, (350, 250))
            dashboard[80:330, 20:370] = f

        # ===== Gaze =====
        if latest_gaze is not None:
            frame, g = latest_gaze
            f = cv2.resize(frame, (350, 250))
            dashboard[80:330, 400:750] = f

        # ===== Hands =====
        if isinstance(latest_hands, np.ndarray):
            f = cv2.resize(latest_hands, (350, 250))
            dashboard[350:600, 400:750] = f

        # ===== Voice =====
        if latest_voice is not None:
            text = latest_voice.get("text") if isinstance(latest_voice, dict) else None

            if text:
                safe_text = text[:50]
            else:
                safe_text = "(음성 인식 실패)"

            cv2.putText(
                dashboard,
                f"Voice: {safe_text}",
                (20, 520),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (255, 255, 255),
                2,
            )

            now = time.time()
            if text and (text != last_voice_text) and ((now - last_question_time) > QUESTION_COOLDOWN):

                try:
                    latest_question = make_question(text, previous_questions=asked_questions)
                    asked_questions.append(latest_question)
                    print("생성된 질문(자동):", latest_question)

                    last_voice_text = text
                    last_question_time = now

                except Exception as e:
                    latest_question = "(질문 생성 실패)"
                    print("질문 생성 오류:", e)

        # ===== 질문 표시 =====
        if latest_question:
            q = latest_question[:70]
            dashboard = put_korean_text(
                dashboard,
                f"Next Q: {q}",
                20,
                600,
                font_size=30,
                color=(0, 255, 255),
            )

        try:
            cv2.imshow(window_name, dashboard)
        except cv2.error:
            break

        if not printed_start_question:
            print("시작 질문:", latest_question)
            printed_start_question = True

        if cv2.getWindowProperty(window_name, cv2.WND_PROP_VISIBLE) < 1:
            break

        # ============================
        # 키 입력 처리 (대소문자 모두 인식)
        # ============================
        key = cv2.waitKey(1) & 0xFF

        if key != 255:
            ch = chr(key).lower()
        else:
            ch = ""

        if ch == "c":
            request_gaze_calibration()
            print("'c/C' pressed → Gaze center calibration requested")

        elif ch == "n":
            now = time.time()
            try:
                base_text = last_voice_text if last_voice_text else ""
                latest_question = make_question(base_text, previous_questions=asked_questions)
                asked_questions.append(latest_question)
                print("(n/N) 다음 질문:", latest_question)
                last_question_time = now
            except Exception as e:
                latest_question = "(질문 생성 실패)"
                print("질문 생성 오류:", e)

        elif ch == "q":
            print("'q/Q' pressed. Exiting.")
            break

        time.sleep(0.01)

    import modules.shared_flags as flags
    flags.RUNNING = False

    cv2.destroyAllWindows()
    print("Threads stopped.")


if __name__ == "__main__":
    main()