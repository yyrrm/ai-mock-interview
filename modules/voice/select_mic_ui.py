# select_mic_ui.py — FINAL VERSION
import tkinter as tk
from tkinter import ttk, messagebox
import pyaudio


def list_microphones():
    """사용 가능한 입력 장치 목록 반환"""
    p = pyaudio.PyAudio()
    mics = []

    for i in range(p.get_device_count()):
        info = p.get_device_info_by_index(i)
        # 입력 가능한 장치만
        if info["maxInputChannels"] > 0:
            mics.append((i, info["name"]))

    return mics


def select_microphone_ui():
    """사용자가 UI 팝업에서 마이크 선택하도록 함"""
    mics = list_microphones()

    # 마이크가 하나도 없는 경우 처리
    if not mics:
        messagebox.showerror("에러", "사용 가능한 마이크를 찾을 수 없습니다.")
        return None

    # Tkinter 메인 창 생성
    root = tk.Tk()
    root.title("마이크 선택")
    root.geometry("420x260")
    root.resizable(False, False)

    ttk.Label(root, text="사용할 마이크를 선택하세요:", font=("Arial", 12)).pack(pady=10)

    mic_var = tk.StringVar()

    combo = ttk.Combobox(root, textvariable=mic_var, state="readonly", width=55)
    combo["values"] = [f"[{idx}] {name}" for idx, name in mics]
    combo.current(0)
    combo.pack(pady=10)

    selected_index = {"value": None}

    def confirm():
        selected_text = mic_var.get()
        idx = int(selected_text.split("]")[0].replace("[", ""))
        selected_index["value"] = idx
        root.destroy()

    ttk.Button(root, text="확인", command=confirm).pack(pady=20)

    root.mainloop()

    return selected_index["value"]
