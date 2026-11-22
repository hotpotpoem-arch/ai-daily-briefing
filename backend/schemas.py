from typing import Literal

from pydantic import BaseModel

FeedbackAction = Literal["like", "dislike"] | None


class ReportStats(BaseModel):
    scannedCount: int
    selectedCount: int
    durationSeconds: int


class ArticleItem(BaseModel):
    id: str
    category: str
    title: str
    tldr: str
    tags: list[str]
    url: str
    sourceName: str
    score: float
    userFeedback: FeedbackAction = None


class DailyReport(BaseModel):
    reportDate: str
    overview: str
    stats: ReportStats
    articles: list[ArticleItem]


class FeedbackRequest(BaseModel):
    article_id: str
    action: FeedbackAction