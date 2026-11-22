import json
import os
from pathlib import Path

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


def push_to_wechat(report: dict) -> None:
    """通过微信测试号发送模板消息，点击卡片直达手机网页版"""
    app_id = os.getenv("WECHAT_APP_ID")
    app_secret = os.getenv("WECHAT_APP_SECRET")
    open_id = os.getenv("WECHAT_OPEN_ID")
    template_id = os.getenv("WECHAT_TEMPLATE_ID")

    if not all([app_id, app_secret, open_id, template_id]):
        raise RuntimeError(
            "未完整配置 WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_OPEN_ID / WECHAT_TEMPLATE_ID"
        )

    # 1. 获取 access_token
    token_url = (
        f"https://api.weixin.qq.com/cgi-bin/token"
        f"?grant_type=client_credential&appid={app_id}&secret={app_secret}"
    )
    token_resp = httpx.get(token_url, timeout=15.0)
    token_resp.raise_for_status()
    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise RuntimeError(f"获取微信 access_token 失败: {token_data}")

    # 2. 发送模板消息
    send_url = (
        f"https://api.weixin.qq.com/cgi-bin/message/template/send"
        f"?access_token={access_token}"
    )
    payload = {
        "touser": open_id,
        "template_id": template_id,
        "url": SITE_URL,
        "data": {
            "date": {"value": str(report.get("reportDate", ""))},
            "overview": {"value": str(report.get("overview", "今日 AI 简报已更新"))},
            "count": {"value": str(len(report.get("articles", [])))},
        },
    }
    res = httpx.post(send_url, json=payload, timeout=15.0)
    res.raise_for_status()
    result = res.json()
    if result.get("errcode") != 0:
        raise RuntimeError(f"微信模板消息发送失败: {result}")

    print("[推送成功] 简报卡片已通过微信测试号发送，点击直达手机网页版")


if __name__ == "__main__":
    print("[1/3] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/3] 正在导出静态 JSON 数据供前端网页使用...")
    export_static_json(report)

    print("[3/3] 正在推送到个人微信...")
    push_to_wechat(report)