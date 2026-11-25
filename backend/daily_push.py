import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pipeline import generate_daily_briefing

load_dotenv()

SITE_URL = os.getenv("SITE_URL", "https://dailypush.dpdns.org").rstrip("/")


def _fetch_and_translate_one(article: dict) -> None:
    """抓取单篇文章正文并调用 DeepSeek 预翻译为中文 Markdown"""
    url = article.get("url", "")
    if not url:
        return

    raw_text = ""
    # 1. 优先用 Jina Reader 提取干净正文（无需 Key 也有免费额度）
    try:
        headers = {
            "Accept": "text/plain",
            "X-Return-Format": "markdown",
            "X-Remove-Selector": "header, nav, footer, aside, [role='navigation'], [role='banner']",
            "X-Target-Selector": "article, main, .article-body, .uni-blog-article",
        }
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
                html = re.sub(
                    r"<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?</\1>",
                    "",
                    r.text,
                    flags=re.I,
                )
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
                            "4. 请务必完整保留原文中的所有 Markdown 图片语法 ![图片说明](图片URL)，绝对不要删除或修改图片链接，只需将括号前的图片说明翻译为中文即可。\n"
                            "清洗要求（严格执行）：\n"
                            "1. 彻底删除所有与文章正文无关的内容，包括但不限于：网站导航栏、登录/注册提示、订阅邮件弹窗、Cookie 声明、广告推广、赞助商信息、社交媒体分享按钮、作者简介、评论区以及文末的“延伸阅读/相关推荐”链接列表。\n"
                            "2. 删除文章中无意义的跳转链接（如“点击查看更多”、“返回顶部”、“登录阅读全文”等）。\n"
                            "3. 仅保留文章的核心正文、小标题、必要的数据表格以及与正文直接相关的配图，输出纯净的中文 Markdown。"
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
    """从 D1 读取所有已扫码订阅 WxPusher 的用户"""
    secret = os.getenv("INGEST_SECRET")
    if not secret:
        print("[警告] 未配置 INGEST_SECRET，无法拉取用户列表")
        return []

    try:
        resp = httpx.get(
            f"{SITE_URL}/api/users",
            headers={"Authorization": f"Bearer {secret}"},
            timeout=15.0,
        )
        if resp.status_code == 200:
            return resp.json().get("users", [])
        print(f"[警告] 拉取用户列表失败 ({resp.status_code}): {resp.text[:100]}")
    except Exception as e:
        print(f"[警告] 读取 D1 用户列表异常: {e}")

    return []


def push_to_wxpusher(report: dict) -> None:
    """通过 WxPusher 逐人发送每日简报，每人点击直达专属 ?uid= 页面"""
    app_token = os.getenv("WXPUSHER_APP_TOKEN", "").strip()
    if not app_token:
        raise RuntimeError("未配置 WXPUSHER_APP_TOKEN")

    users = fetch_target_users()
    if not users:
        print("[WxPusher 推送跳过] D1 中暂无已扫码订阅的用户")
        return

    report_date = report.get("reportDate", "")
    overview = report.get("overview", "今日前沿 AI 深度资讯已更新，点击阅读全文。")
    articles = report.get("articles", [])
    top_lines = "\n".join([f"- **{a.get('title', '')}**" for a in articles[:5]])

    base_md = (
        f"### 📅 AI 每日简报（{report_date}）\n\n"
        f"> {overview}\n\n"
        f"**今日精选（共 {len(articles)} 篇）：**\n"
        f"{top_lines}\n"
    )

    success_count = 0
    for user in users:
        uid = user.get("uid", "default")
        wx_uid = user.get("wechat_openid", "")
        if not wx_uid:
            continue

        personal_url = f"{SITE_URL}/?uid={uid}"
        payload = {
            "appToken": app_token,
            "content": f"{base_md}\n👉 [点击查看你的专属完整简报]({personal_url})",
            "summary": f"AI 每日简报 ({report_date})：{overview[:36]}...",
            "contentType": 3,  # 3 = Markdown
            "uids": [wx_uid],
            "url": personal_url,
        }
        try:
            res = httpx.post(
                "https://wxpusher.zjiecode.com/api/send/message",
                json=payload,
                timeout=15.0,
            ).json()
            if res.get("success"):
                success_count += 1
                print(f"[WxPusher 推送成功] uid={uid}")
            else:
                print(f"[WxPusher 推送失败] uid={uid}: {res.get('msg')}")
        except Exception as e:
            print(f"[WxPusher 推送异常] uid={uid}: {e}")

    print(f"[WxPusher 推送完成] 共成功推送 {success_count}/{len(users)} 位用户")


if __name__ == "__main__":
    print("[1/5] 正在抓取并调用 DeepSeek 生成今日简报...")
    report = generate_daily_briefing()

    print("[2/5] 正在后台预抓取并翻译纯享中文正文...")
    pretranslate_articles(report)

    print("[3/5] 正在导出静态 JSON 备份...")
    export_static_json(report)

    print("[4/5] 正在写入 Cloudflare D1 公共文Ks章池...")
    ingest_to_d1(report)

    print("[5/5] 正在通过 WxPusher 推送个性化简报...")
    try:
        push_to_wxpusher(report)
    except Exception as e:
        print(f"[WxPusher 推送失败] {e}")