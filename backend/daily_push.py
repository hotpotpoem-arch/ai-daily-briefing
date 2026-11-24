import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pipeline import generate_daily_briefing

load_dotenv()

SITE_URL = "https://ai-daily-briefing-543.pages.dev"

def push_to_wecom(report: dict) -> None:
    """通过企业微信自建应用发送图文卡片到个人微信（支持静态 IP 代理）"""
    corp_id = os.getenv("WECOM_CORP_ID")
    agent_id = os.getenv("WECOM_AGENT_ID")
    secret = os.getenv("WECOM_SECRET")
    base_url = os.getenv("WECOM_BASE_URL", "https://qyapi.weixin.qq.com").rstrip("/")
    proxy_url = os.getenv("WECOM_PROXY") or None  # 新增：读取代理地址

    if not all([corp_id, agent_id, secret]):
        raise RuntimeError("未完整配置 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET")

    with httpx.Client(proxy=proxy_url, timeout=15.0) as client:
        # 1. 获取 access_token
        token_resp = client.get(
            f"{base_url}/cgi-bin/gettoken",
            params={"corpid": corp_id, "corpsecret": secret},
        )
        token_resp.raise_for_status()
        token_data = token_resp.json()
        access_token = token_data.get("access_token")
        if not access_token:
            raise RuntimeError(f"获取企业微信 access_token 失败: {token_data}")

        # 2. 发送图文卡片消息
        report_date = report.get("reportDate", "")
        overview = report.get("overview", "今日前沿 AI 深度资讯已更新，点击阅读全文。")
        count = len(report.get("articles", []))

        payload = {
            "touser": "@all",
            "msgtype": "news",
            "agentid": int(agent_id),
            "news": {
                "articles": [
                    {
                        "title": f"AI 每日简报 · {report_date}（精选 {count} 篇）",
                        "description": overview,
                        "url": f"{SITE_URL}/",
                        "picurl": "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&q=80",
                    }
                ]
            },
        }

        res = client.post(
            f"{base_url}/cgi-bin/message/send",
            params={"access_token": access_token},
            json=payload,
        ).json()

    if res.get("errcode") == 0:
        print("[企业微信推送成功] 图文卡片已送达个人微信")
    else:
        raise RuntimeError(f"企业微信推送失败: {res}")

import re
from concurrent.futures import ThreadPoolExecutor

def _fetch_and_translate_one(article: dict) -> None:
    """抓取单篇文章正文并调用 DeepSeek 预翻译为中文 Markdown"""
    url = article.get("url", "")
    if not url:
        return

    raw_text = ""
    # 1. 优先用 Jina Reader 提取干净正文（无需 Key 也有免费额度）
    try:
        headers = {"Accept": "text/plain", "X-Return-Format": "markdown"}
        jina_key = os.getenv("JINA_API_KEY")
        if jina_key:
            headers["Authorization"] = f"Bearer {jina_key}"
        r = httpx.get(f"https://r.jina.ai/{url}", headers=headers, timeout=25.0, follow_redirects=True)
        if r.status_code == 200 and len(r.text.strip()) > 200:
            raw_text = r.text.strip()
    except Exception:
        pass

    # 2. 兜底：直接抓网页并去标签
    if not raw_text:
        try:
            r = httpx.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
                timeout=20.0,
                follow_redirects=True,
            )
            if r.status_code == 200:
                html = re.sub(r"<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?</\1>", "", r.text, flags=re.I)
                raw_text = re.sub(r"<[^>]+>", "\n", html)
                raw_text = re.sub(r"\n{3,}", "\n\n", raw_text).strip()
        except Exception as e:
            print(f"[预翻译跳过] 抓取失败 {url}: {e}")
            return

    if len(raw_text) < 100:
        return

    # 如果本来就是中文文章，直接保存
    cn_chars = len(re.findall(r"[\u4e00-\u9fa5]", raw_text))
    en_chars = len(re.findall(r"[a-zA-Z]", raw_text))
    if en_chars <= cn_chars * 2:
        article["contentZh"] = raw_text[:15000]
        return

    # 3. 调用 DeepSeek 翻译为中文 Markdown
    api_key = os.getenv("LLM_API_KEY")
    if not api_key:
        return
    base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    model = os.getenv("LLM_MODEL", "deepseek-chat")

    try:
        resp = httpx.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是一位精通人工智能、计算机科学与科技新闻的专业中英译者。请将用户提供的文章正文准确、流畅地翻译为简体中文。\n"
                            "要求：\n"
                            "1. 严格忠实原文，不遗漏关键数据、实验结论与技术细节，不擅自发挥。\n"
                            "2. 保留常见专业英文术语（如 LLM、Agent、Transformer、Benchmark、API、Fine-tuning 等）或采用业内通用译法。\n"
                            "3. 保持原有的段落与小标题结构，使用简洁的 Markdown（如 ## 标题、加粗、列表）输出，不要输出任何开场白或解释，也不要重复输出文章主标题。\n"
                            "4.请务必完整保留原文中的所有 Markdown 图片语法 ![图片说明](图片URL)，绝对不要删除或修改图片链接，只需将括号前的图片说明翻译为中文即可。"
                        ),
                    },
                    {"role": "user", "content": raw_text[:12000]},
                ],
            },
            timeout=90.0,
        )
        resp.raise_for_status()
        translated = resp.json()["choices"][0]["message"]["content"].strip()
        if translated:
            article["contentZh"] = translated
            print(f"[预翻译成功] {article.get('title', '')[:30]}")
    except Exception as e:
        print(f"[预翻译失败] {article.get('title', '')[:30]}: {e}")


def pretranslate_articles(report: dict) -> None:
    """并发预翻译当日入选文章，供纯享模式秒开"""
    articles = report.get("articles", [])
    if not articles:
        return
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(_fetch_and_translate_one, articles))

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
    print("[1/5] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/5] 正在后台预抓取并翻译纯享中文正文...")
    pretranslate_articles(report)

    print("[3/5] 正在导出静态 JSON 备份...")
    export_static_json(report)

    print("[4/5] 正在写入 Cloudflare D1 公共文章池...")
    ingest_to_d1(report)

    print("[5/5] 正在推送企业微信图文卡片...")
    try:
        push_to_wecom(report)
    except Exception as e:
        print(f"[企业微信推送失败] {e}")


    try:
        push_to_wecom(report)
    except Exception as e:
        print(f"[企业微信推送失败] {e}")