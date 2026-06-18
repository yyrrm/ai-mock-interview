"""
web/models.py — 데이터베이스 모델 및 연결 설정 (MySQL + SQLAlchemy ORM)

회원/면접기록 등 영속 데이터를 MySQL에 저장한다.
연결 정보는 .env 에서 읽는다 (비밀번호를 코드에 두지 않기 위함).
"""
import os
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


def _mysql_params():
    return {
        "host": os.getenv("MYSQL_HOST", "localhost"),
        "port": int(os.getenv("MYSQL_PORT", "3306")),
        "user": os.getenv("MYSQL_USER", "root"),
        "password": os.getenv("MYSQL_PASSWORD", ""),
        "db": os.getenv("MYSQL_DB", "ai_interview"),
    }


def database_url():
    """SQLAlchemy 연결 문자열 (PyMySQL 드라이버, utf8mb4)."""
    p = _mysql_params()
    return (
        f"mysql+pymysql://{p['user']}:{p['password']}"
        f"@{p['host']}:{p['port']}/{p['db']}?charset=utf8mb4"
    )


def ensure_database():
    """앱 전용 데이터베이스(스키마)가 없으면 생성한다 (best-effort).

    SQLAlchemy 의 create_all() 은 테이블만 만들 뿐 데이터베이스 자체는
    만들지 못하므로, 서버에 직접 접속해 CREATE DATABASE 를 먼저 시도한다.

    단, 최소 권한으로 분리된 전용 계정(aiuser)은 DB 생성 권한이 없을 수
    있다. 그 경우 DB 는 이미 만들어져 있으므로, 권한 오류는 무시하고 넘어간다.
    """
    import pymysql

    p = _mysql_params()
    try:
        conn = pymysql.connect(
            host=p["host"], port=p["port"], user=p["user"],
            password=p["password"], charset="utf8mb4",
        )
    except Exception as e:
        print(f"[db] 서버 접속 확인 실패: {e}")
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{p['db']}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
    except Exception as e:
        # 전용 계정은 DB 생성 권한이 없을 수 있음 → 이미 존재하면 그대로 사용
        print(f"[db] CREATE DATABASE 건너뜀(이미 존재/권한 없음): {e}")
    finally:
        conn.close()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    def set_password(self, raw_password):
        # 비밀번호는 평문이 아니라 해시로 저장한다.
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)

    def to_dict(self):
        """클라이언트로 보낼 안전한 표현 (비밀번호 해시 제외)."""
        return {"id": self.id, "email": self.email, "name": self.name}


class InterviewRecord(db.Model):
    """완료한 면접 1회의 결과 기록 (회원과 외래키로 연결)."""

    __tablename__ = "interview_records"

    id = db.Column(db.Integer, primary_key=True)
    # 회원 삭제 시 해당 기록도 함께 삭제(ON DELETE CASCADE)
    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    overall = db.Column(db.Integer, nullable=False)
    # 항목별 점수 [{"name": "표정 분석", "score": 82}, ...] 를 JSON 으로 저장
    scores = db.Column(db.JSON, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    user = db.relationship(
        "User", backref=db.backref("records", lazy=True, passive_deletes=True)
    )

    # 사용자별 최신순 조회(filter user_id + order created_at desc) 최적화용 복합 인덱스
    __table_args__ = (
        db.Index("idx_records_user_created", "user_id", "created_at"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.created_at.isoformat() if self.created_at else None,
            "overall": self.overall,
            "scores": self.scores or [],
        }
