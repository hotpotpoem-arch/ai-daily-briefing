import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from database import (
    get_latest_report_db,
    get_report_by_date_db,
    init_db,
    list_report_dates_db,
    save_report_db,
    update_article_feedback_db,
)
from pipeline import generate_daily_briefing
from schemas import DailyReport, FeedbackRequest

app = FastAPI(title="AI Daily Briefing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PREF_FILE = Path(__file__).parent / "preferences.json"

# 启动时自动初始化 SQLite 数据库
init_db()


def update_preferences(article: dict, action: str | None) -> None:
    """将用户的点赞/点踩记录持久化，供大模型下次筛选参考"""
    if PREF_FILE.exists():
        prefs = json.loads(PREF_FILE.read_text(encoding="utf-8"))
    else:
        prefs = {"liked": [], "disliked": []}

    title = article.get("title", "")
    prefs["liked"] = [x for x in prefs["liked"] if x["title"] != title]
    prefs["disliked"] = [x for x in prefs["disliked"] if x["title"] != title]

    record = {
        "title": title,
        "category": article.get("category", ""),
        "tags": article.get("tags", []),
    }

    if action == "like":
        prefs["liked"].append(record)
        prefs["liked"] = prefs["liked"][-15:]
    elif action == "dislike":
        prefs["disliked"].append(record)
        prefs["disliked"] = prefs["disliked"][-15:]

    PREF_FILE.write_text(
        json.dumps(prefs, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.get("/api/reports/dates")
async def get_report_dates():
    """获取所有历史简报的日期列表"""
    return {"dates": list_report_dates_db()}


@app.get("/api/reports/latest", response_model=DailyReport)
async def get_latest_report():
    report = get_latest_report_db()
    if not report:
        raise HTTPException(status_code=404, detail="暂无简报，请先点击刷新生成")
    return report


@app.get("/api/reports/{report_date}", response_model=DailyReport)
async def get_report_by_date(report_date: str):
    """按日期查询历史简报，如 2026-11-21"""
    report = get_report_by_date_db(report_date)
    if not report:
        raise HTTPException(status_code=404, detail=f"未找到 {report_date} 的简报")
    return report


@app.post("/api/feedback")
async def submit_feedback(payload: FeedbackRequest):
    article = update_article_feedback_db(payload.article_id, payload.action)
    if not article:
        raise HTTPException(status_code=404, detail="未找到对应的文章")
    update_preferences(article, payload.action)
    return {
        "status": "success",
        "article_id": payload.article_id,
        "action": payload.action,
    }


@app.post("/api/reports/generate", response_model=DailyReport)
async def trigger_generate_report():
    try:
        new_report = generate_daily_briefing()
        save_report_db(new_report)
        return new_report
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e))