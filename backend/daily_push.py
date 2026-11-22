import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pipeline import generate_daily_briefing

load_dotenv()

SITE_URL = "https://ai-daily-briefing-543.pages.dev"


def export_static_json(report: dict) -> None:
    """将简报按日期归档导出到前端静态目录（作为兜底备份）"""
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
    print(f"[导出成功] 静态备份已更新至 {archive_path}")


def ingest_to_d1(report: dict) -> None:
    """将今日公共文章池写入 Cloudflare D1 数据库"""
    secret = os.getenv("INGEST_SECRET")
    if not secret:
        print("[D1 入库跳过] 未配置 INGEST_SECRET")
        return

    resp = httpx.post(
        f"{SITE_URL}/api/ingest",
        headers={"Authorization": f"Bearer {secret}"},
        json={
            "reportDate": report.get("reportDate"),
            "overview": report.get("overview", ""),
            "articles": report.get("articles", []),
        },
        timeout=20.0,
    )
    resp.raise_for_status()
    result = resp.json()
    if not result.get("ok"):
        raise RuntimeError(f"D1 入库失败: {result}")
    print(f"[D1 入库成功] 已写入 {result.get('count', 0)} 篇公共文章")


def fetch_target_users() -> list[dict]:
    """从 D1 读取所有已绑定微信的用户；若为空则兜底使用环境变量中的个人 OpenID"""
    secret = os.getenv("INGEST_SECRET")
    users: list[dict] = []

    if secret:
        try:
            resp = httpx.get(
                f"{SITE_URL}/api/users",
                headers={"Authorization": f"Bearer {secret}"},
                timeout=15.0,
            )
            if resp.status_code == 200:
                users = resp.json().get("users", [])
        except Exception as e:
            print(f"[警告] 读取 D1 用户列表失败，将使用默认 OpenID: {e}")

    if not users:
        default_openid = os.getenv("WECHAT_OPEN_ID")
        if default_openid:
            users = [{"uid": "default", "nickname": "管理员", "wechat_openid": default_openid}]

    return users


def push_to_wechat(report: dict) -> None:
    """通过微信测试号循环向所有订阅用户发送模板消息，点击直达专属个性化网页"""
    app_id = os.getenv("WECHAT_APP_ID")
    app_secret = os.getenv("WECHAT_APP_SECRET")
    template_id = os.getenv("WECHAT_TEMPLATE_ID")

    if not all([app_id, app_secret, template_id]):
        raise RuntimeError("未完整配置 WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_TEMPLATE_ID")

    users = fetch_target_users()
    if not users:
        print("[微信推送跳过] 未找到任何可推送的用户 OpenID")
        return

    # 1. 获取全局 access_token（一次获取，循环复用）
    token_url = (
        f"https://api.weixin.qq.com/cgi-bin/token"
        f"?grant_type=client_credential&appid={app_id}&secret={app_secret}"
    )
    token_resp = httpx.get(token_url, timeout=15.0)
    token_resp.raise_for_status()
    access_token = token_resp.json().get("access_token")
    if not access_token:
        raise RuntimeError(f"获取微信 access_token 失败: {token_resp.json()}")

    # 2. 逐个用户发送带专属 ?uid= 的模板消息
    send_url = (
        f"https://api.weixin.qq.com/cgi-bin/message/template/send"
        f"?access_token={access_token}"
    )
    success_count = 0
    for user in users:
        uid = user["uid"]
        open_id = user["wechat_openid"]
        payload = {
            "touser": open_id,
            "template_id": template_id,
            "url": f"{SITE_URL}/?uid={uid}",
            "data": {
                "date": {"value": str(report.get("reportDate", ""))},
                "overview": {"value": str(report.get("overview", "今日 AI 简报已更新"))},
                "count": {"value": str(len(report.get("articles", [])))},
            },
        }
        res = httpx.post(send_url, json=payload, timeout=15.0).json()
        if res.get("errcode") == 0:
            success_count += 1
            print(f"[推送成功] uid={uid} ({user.get('nickname') or ''})")
        else:
            print(f"[推送失败] uid={uid}: {res}")

    print(f"[微信推送完成] 共成功推送 {success_count}/{len(users)} 位用户")


if __name__ == "__main__":
    print("[1/4] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/4] 正在导出静态 JSON 备份...")
    export_static_json(report)

    print("[3/4] 正在写入 Cloudflare D1 公共文章池...")
    ingest_to_d1(report)

    print("[4/4] 正在向订阅用户推送微信简报卡片...")
    push_to_wechat(report)