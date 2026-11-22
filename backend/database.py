import json
import sqlite3
from pathlib import Path

DB_FILE = Path(__file__).parent / "briefings.db"
LEGACY_JSON = Path(__file__).parent / "latest_report.json"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """初始化数据库表，并自动迁移旧的 latest_report.json"""
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                report_date TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # 如果数据库为空且存在旧 JSON，自动迁移进来
        count = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        if count == 0 and LEGACY_JSON.exists():
            try:
                old_data = json.loads(LEGACY_JSON.read_text(encoding="utf-8"))
                report_date = old_data.get("reportDate", "2026-11-21")
                conn.execute(
                    "INSERT OR REPLACE INTO reports (report_date, data) VALUES (?, ?)",
                    (report_date, json.dumps(old_data, ensure_ascii=False)),
                )
            except Exception as e:  # noqa: BLE001
                print(f"[数据库迁移跳过] {e}")


def save_report_db(report: dict) -> None:
    """按日期保存或更新简报"""
    report_date = report["reportDate"]
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO reports (report_date, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(report_date) DO UPDATE SET
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
            """,
            (report_date, json.dumps(report, ensure_ascii=False)),
        )


def list_report_dates_db() -> list[str]:
    """返回所有已归档的日期列表（从新到旧）"""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT report_date FROM reports ORDER BY report_date DESC"
        ).fetchall()
    return [row["report_date"] for row in rows]


def get_latest_report_db() -> dict | None:
    """获取最新一天的简报"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT data FROM reports ORDER BY report_date DESC LIMIT 1"
        ).fetchone()
    return json.loads(row["data"]) if row else None


def get_report_by_date_db(report_date: str) -> dict | None:
    """按指定日期获取历史简报"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT data FROM reports WHERE report_date = ?",
            (report_date,),
        ).fetchone()
    return json.loads(row["data"]) if row else None


def update_article_feedback_db(article_id: str, action: str | None) -> dict | None:
    """在数据库中查找对应文章并更新点赞/点踩状态，返回该文章对象"""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT report_date, data FROM reports ORDER BY report_date DESC"
        ).fetchall()
        for row in rows:
            report = json.loads(row["data"])
            for article in report.get("articles", []):
                if article["id"] == article_id:
                    article["userFeedback"] = action
                    conn.execute(
                        "UPDATE reports SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE report_date = ?",
                        (json.dumps(report, ensure_ascii=False), row["report_date"]),
                    )
                    return article
    return None