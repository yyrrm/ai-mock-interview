"""
web/auth.py — 회원가입 / 로그인 / 로그아웃 API (세션 기반 인증)

비밀번호는 해시로 저장하고, 로그인 상태는 Flask 세션 쿠키로 관리한다.
SPA(React)가 같은 서버에서 서빙되므로 쿠키가 자동으로 전달된다.
"""
from flask import Blueprint, request, jsonify, session

from models import db, User

auth_bp = Blueprint("auth", __name__)


def current_user():
    """세션에 저장된 user_id 로 현재 로그인 사용자를 반환 (없으면 None)."""
    uid = session.get("user_id")
    if not uid:
        return None
    return db.session.get(User, uid)


@auth_bp.post("/api/auth/signup")
def signup():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    name = (data.get("name") or "").strip()

    if not email or not password or not name:
        return jsonify({"ok": False, "msg": "이름·이메일·비밀번호를 모두 입력해 주세요."}), 400
    if len(password) < 4:
        return jsonify({"ok": False, "msg": "비밀번호는 4자 이상이어야 합니다."}), 400
    if len(email) > 255 or len(name) > 100:
        return jsonify({"ok": False, "msg": "이름 또는 이메일이 너무 깁니다."}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({"ok": False, "msg": "이미 가입된 이메일입니다."}), 409

    user = User(email=email, name=name)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    session.permanent = True  # 2시간 만료 타이머 적용 (server.py 설정)
    session["user_id"] = user.id
    return jsonify({"ok": True, "user": user.to_dict()})


@auth_bp.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = User.query.filter_by(email=email).first()
    if user is None or not user.check_password(password):
        return jsonify({"ok": False, "msg": "이메일 또는 비밀번호가 올바르지 않습니다."}), 401

    session.permanent = True  # 2시간 만료 타이머 적용 (server.py 설정)
    session["user_id"] = user.id
    return jsonify({"ok": True, "user": user.to_dict()})


@auth_bp.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.post("/api/auth/delete")
def delete_account():
    """회원 탈퇴: 비밀번호를 확인한 뒤 계정을 삭제하고 세션을 비운다.

    본인 확인을 위해 현재 비밀번호를 다시 입력받아 검증한다.
    면접 기록(interview_records)은 외래키의 ON DELETE CASCADE 로
    회원 삭제 시 DB 가 자동으로 함께 삭제한다.
    """
    user = current_user()
    if user is None:
        return jsonify({"ok": False, "msg": "로그인이 필요합니다."}), 401

    data = request.get_json(silent=True) or {}
    password = data.get("password") or ""
    if not user.check_password(password):
        return jsonify({"ok": False, "msg": "비밀번호가 올바르지 않습니다."}), 403

    db.session.delete(user)
    db.session.commit()
    session.clear()
    return jsonify({"ok": True})


@auth_bp.get("/api/auth/me")
def me():
    user = current_user()
    if user is None:
        return jsonify({"ok": False}), 401
    return jsonify({"ok": True, "user": user.to_dict()})
