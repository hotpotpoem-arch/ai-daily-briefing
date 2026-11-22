import os

import httpx
from dotenv import load_dotenv

from pipeline import generate_daily_briefing

load_dotenv()


def format_markdown(report: dict) -> str:
    """把 AI 简报格式化为适合微信阅读的 Markdown"""
    lines = [
        f"## 📅 AI 每日情报简报（{report.get('reportDate', '')}）",
        "",
        f"> **今日概览**：{report.get('overview', '')}",
        "",
        "---",
        "",
    ]

    for idx, item in enumerate(report.get("articles", []), start=1):
        title = item.get("title", "无标题")
        category = item.get("category", "AI")
        summary = item.get("summary", "")
        url = item.get("url", "")
        lines.append(f"### {idx}. [{category}] {title}")
        lines.append(f"{summary}")
        if url:
            lines.append(f"[查看原文]({url})")
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
    print("[1/2] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()
    md_content = format_markdown(report)
    title = f"AI 每日简报 | {report.get('reportDate', '')}"

    print("[2/2] 正在推送到微信...")
    push_to_wechat(title, md_content)