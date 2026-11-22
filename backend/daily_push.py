import json
import os
from pathlib import Path
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from pipeline import generate_daily_briefing

load_dotenv()

SITE_URL = "https://ai-daily-briefing-543.pages.dev"


def export_static_json(report: dict) -> None:
    """将简报按日期归档导出到前端静态目录，供 Cloudflare Pages 直接读取"""
    project_root = Path(__file__).resolve().parent.parent
    data_dir = project_root / "frontend" / "public" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    latest_path = data_dir / "latest.json"
    latest_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    archive_path = data_dir / "briefings.json"
    archive: dict = {}
    if archive_path.exists():
        try:
            archive = json.loads(archive_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            archive = {}

    report_date = report.get("reportDate", "unknown")
    archive[report_date] = report
    sorted_archive = dict(sorted(archive.items(), reverse=True))

    archive_path.write_text(
        json.dumps(sorted_archive, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[导出成功] 静态数据已更新至 {archive_path}")


def build_feedback_url(action: str, item: dict) -> str:
    params = urlencode(
        {
            "action": action,
            "title": item.get("title", ""),
            "category": item.get("category", "AI"),
            "tags": ",".join(item.get("tags", [])),
        }
    )
    return f"{SITE_URL}/api/feedback?{params}"


def format_markdown(report: dict) -> str:
    """把 AI 简报格式化为适合微信阅读、带交互反馈按钮的 Markdown"""
    lines = [
        f"## 📅 AI 每日情报简报（{report.get('reportDate', '')}）",
        "",
        f"> **今日概览**：{report.get('overview', '')}",
        "",
        f"👉 [进入在线网页版（支持搜索与历史回看）]({SITE_URL})",
        "",
        "---",
        "",
    ]

    for idx, item in enumerate(report.get("articles", []), start=1):
        title = item.get("title", "无标题")
        category = item.get("category", "AI")
        summary = item.get("tldr") or item.get("summary", "")
        score = item.get("score")
        url = item.get("url", "")

        score_text = f" · ⭐ {score}" if score else ""
        lines.append(f"### {idx}. [{category}] {title}{score_text}")
        if summary:
            lines.append(f"{summary}")

        like_url = build_feedback_url("like", item)
        dislike_url = build_feedback_url("dislike", item)

        actions = []
        if url:
            actions.append(f"[📖 查看原文]({url})")
        actions.append(f"[👍 感兴趣]({like_url})")
        actions.append(f"[👎 不感兴趣]({dislike_url})")

        lines.append(" ｜ ".join(actions))
        lines.append("")

    return "\n".join(lines)


def push_to_wechat(title: str, content: str) -> None:
    token = os.getenv("PUSHPLUS_TOKEN")
    if not token:
        raise RuntimeError("未配置 PUSHPLUS_TOKEN，请检查环境变量或 .env 文件")

    resp = httpx.post(
        "http://www.pushplus.plus/send",
        json={
            "token": token,
            "title": title,
            "content": content,
            "template": "markdown",
        },
        timeout=20.0,
    )
    resp.raise_for_status()
    result = resp.json()
    if result.get("code") != 200:
        raise RuntimeError(f"PushPlus 推送失败: {result}")
    print("[推送成功] 简报已发送至微信")


if __name__ == "__main__":
    print("[1/3] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/3] 正在导出静态 JSON 数据供前端网页使用...")
    export_static_json(report)

    md_content = format_markdown(report)
    title = f"AI 每日简报 | {report.get('reportDate', '')}"

    print("[3/3] 正在推送到微信...")
    push_to_wechat(title, md_content)