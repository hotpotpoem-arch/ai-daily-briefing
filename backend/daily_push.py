import html
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


def format_html(report: dict) -> str:
    """把 AI 简报格式化为适合 WxPusher 微信阅读、带直接可点击反馈按钮的 HTML"""
    report_date = html.escape(str(report.get("reportDate", "")))
    overview = html.escape(str(report.get("overview", "")))

    parts = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1917;line-height:1.6;max-width:640px;margin:0 auto;">',
        f'<h2 style="margin:0 0 12px;font-size:18px;">📅 AI 每日情报简报（{report_date}）</h2>',
        f'<div style="background:#f5f5f4;border-left:4px solid #1c1917;padding:10px 12px;border-radius:6px;margin-bottom:14px;font-size:14px;">'
        f'<strong>今日概览：</strong>{overview}</div>',
        f'<p style="margin:0 0 16px;font-size:14px;">👉 <a href="{SITE_URL}" style="color:#2563eb;text-decoration:none;font-weight:600;">进入在线网页版（支持搜索与历史回看）</a></p>',
        '<hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0;" />',
    ]

    for idx, item in enumerate(report.get("articles", []), start=1):
        title = html.escape(str(item.get("title", "无标题")))
        category = html.escape(str(item.get("category", "AI")))
        summary = html.escape(str(item.get("tldr") or item.get("summary", "")))
        score = item.get("score")
        url = item.get("url", "")

        score_text = f" · ⭐ {score}" if score else ""
        like_url = html.escape(build_feedback_url("like", item))
        dislike_url = html.escape(build_feedback_url("dislike", item))

        actions = []
        if url:
            safe_url = html.escape(str(url))
            actions.append(
                f'<a href="{safe_url}" style="color:#2563eb;text-decoration:none;">📖 查看原文</a>'
            )
        actions.append(
            f'<a href="{like_url}" style="color:#059669;text-decoration:none;font-weight:600;">👍 感兴趣</a>'
        )
        actions.append(
            f'<a href="{dislike_url}" style="color:#dc2626;text-decoration:none;">👎 不感兴趣</a>'
        )

        parts.append('<div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #f5f5f4;">')
        parts.append(
            f'<div style="font-size:15px;font-weight:600;margin-bottom:6px;">{idx}. [{category}] {title}{score_text}</div>'
        )
        if summary:
            parts.append(
                f'<div style="font-size:13.5px;color:#57534e;margin-bottom:8px;">{summary}</div>'
            )
        parts.append(
            f'<div style="font-size:13px;">{" &nbsp;｜&nbsp; ".join(actions)}</div>'
        )
        parts.append("</div>")

    parts.append("</div>")
    return "\n".join(parts)


def push_to_wechat(title: str, html_content: str) -> None:
    app_token = os.getenv("WXPUSHER_APP_TOKEN")
    uid = os.getenv("WXPUSHER_UID")
    if not app_token or not uid:
        raise RuntimeError("未配置 WXPUSHER_APP_TOKEN 或 WXPUSHER_UID，请检查环境变量或 .env 文件")

    resp = httpx.post(
        "https://wxpusher.zjiecode.com/api/send/message",
        json={
            "appToken": app_token,
            "content": html_content,
            "summary": title,
            "contentType": 2,  # 2 表示 HTML 格式，支持直接点击反馈链接
            "uids": [uid],
            "url": SITE_URL,
        },
        timeout=20.0,
    )
    resp.raise_for_status()
    result = resp.json()
    if result.get("code") != 1000:
        raise RuntimeError(f"WxPusher 推送失败: {result}")
    print("[推送成功] 简报已通过 WxPusher 发送至微信")


if __name__ == "__main__":
    print("[1/3] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/3] 正在导出静态 JSON 数据供前端网页使用...")
    export_static_json(report)

    html_content = format_html(report)
    title = f"AI 每日简报 | {report.get('reportDate', '')}"

    print("[3/3] 正在推送到微信...")
    push_to_wechat(title, html_content)