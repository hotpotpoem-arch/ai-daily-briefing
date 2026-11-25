import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import feedparser
import httpx
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
PREF_FILE = Path(__file__).parent / "preferences.json"

# 过滤掉需要注册登录、付费墙或极难打开的站点
BLOCKED_DOMAINS = {
    "nytimes.com",
    "wsj.com",
    "bloomberg.com",
    "ft.com",
    "economist.com",
    "washingtonpost.com",
    "businessinsider.com",
    "theinformation.com",
    "medium.com",
    "substack.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "wired.com",
    "theatlantic.com",
    "newyorker.com",
    "noemamag.com",
}

# 前沿 AI 图文深度资讯源（官方博客 + 头部科技深度媒体）
RSS_SOURCES = [
    ("OpenAI News", "https://openai.com/news/rss.xml", 4),
    ("Google DeepMind", "https://deepmind.google/blog/rss.xml", 4),
    ("Hugging Face Blog", "https://huggingface.co/blog/feed.xml", 4),
    ("MIT Tech Review AI", "https://www.technologyreview.com/topic/artificial-intelligence/feed", 5),
    ("The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", 10),
    ("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", 10),
    ("VentureBeat AI", "https://venturebeat.com/category/ai/feed/", 10),
]


def is_blocked_url(url: str) -> bool:
    """判断链接是否属于黑名单域名（含子域名）"""
    if not url:
        return True
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return True
    return any(host == d or host.endswith(f".{d}") for d in BLOCKED_DOMAINS)


def clean_html(text: str) -> str:
    """去除 RSS 摘要中的 HTML 标签，保留纯文本供大模型判断深度"""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_preference_prompt() -> str:
    """从 Cloudflare D1 拉取双偏好（手动设置 + 历史点赞反馈），生成 DeepSeek 提示词"""
    site_url = os.getenv("SITE_URL", "").rstrip("/")
    secret = os.getenv("INGEST_SECRET", "")
    if not site_url or not secret:
        return ""

    try:
        resp = httpx.get(
            f"{site_url}/api/export-prefs",
            headers={"Authorization": f"Bearer {secret}"},
            timeout=10.0,
        )
        if resp.status_code != 200:
            return ""
        data = resp.json()
    except Exception as e:
        print(f"[个性化] 拉取 D1 偏好失败，跳过注入: {e}")
        return ""

    lines = []
    if data.get("prefTexts"):
        lines.append(f"- 用户明确关注方向：{'；'.join(data['prefTexts'])}")
    if data.get("likeKeywords"):
        lines.append(f"- 核心关注关键词：{', '.join(data['likeKeywords'][:15])}")
    if data.get("topLikedTags"):
        lines.append(f"- 历史高频点赞主题：{', '.join(data['topLikedTags'])}")
    if data.get("dislikeKeywords") or data.get("topDislikedTags"):
        dislikes = list(set(data.get("dislikeKeywords", []) + data.get("topDislikedTags", [])))
        lines.append(f"- 用户不感兴趣/屏蔽主题：{', '.join(dislikes[:10])}")

    if not lines:
        return ""

    return (
        "\n\n【读者长期个性化偏好（在保证高质量的前提下优先倾斜）】\n"
        + "\n".join(lines)
        + "\n注意：命中关注方向或点赞主题的优质文章可适当提高入选优先级和评分；"
          "命中屏蔽主题的普通资讯请直接过滤（除非是 4.7 分以上的全行业特大新闻）。"
    )

def load_recent_history(url_days: int = 7, title_days: int = 3) -> tuple[set[str], list[str]]:
    """从 briefings.json 读取近期已推送的 URL 和标题，用于跨天去重"""
    archive_path = Path(__file__).resolve().parent.parent / "frontend" / "public" / "data" / "briefings.json"
    if not archive_path.exists():
        return set(), []

    try:
        archive = json.loads(archive_path.read_text(encoding="utf-8"))
    except Exception:
        return set(), []

    today_str = datetime.now().strftime("%Y-%m-%d")
    # 排除今天，按日期从新到旧排序
    past_dates = sorted([d for d in archive.keys() if d != today_str], reverse=True)

    history_urls: set[str] = set()
    recent_titles: list[str] = []

    for idx, date_str in enumerate(past_dates[:url_days]):
        articles = archive.get(date_str, {}).get("articles", [])
        for art in articles:
            if art.get("url"):
                history_urls.add(art["url"].strip())
            if idx < title_days and art.get("title"):
                recent_titles.append(f"[{date_str}] {art['title']}")

    return history_urls, recent_titles

def fetch_raw_articles(history_urls: set[str] | None = None) -> list[dict]:
    """从前沿 AI 官方博客与头部科技媒体抓取深度图文资讯"""
    items: list[dict] = []
    seen_urls: set[str] = set(history_urls or set())
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }

    with httpx.Client(headers=headers, timeout=15.0, follow_redirects=True) as http:
        for source_name, rss_url, limit in RSS_SOURCES:
            try:
                resp = http.get(rss_url)
                resp.raise_for_status()
                feed = feedparser.parse(resp.text)

                count = 0
                for entry in feed.entries:
                    url = entry.get("link", "").strip()
                    if not url or url in seen_urls or is_blocked_url(url):
                        continue

                    summary_raw = entry.get("summary") or entry.get("description") or ""
                    items.append(
                        {
                            "title": entry.get("title", "").strip(),
                            "summary": clean_html(summary_raw)[:400],
                            "url": url,
                            "sourceName": source_name,
                        }
                    )
                    seen_urls.add(url)
                    count += 1
                    if count >= limit:
                        break
                print(f"[抓取成功] {source_name}: {count} 篇")
            except Exception as e:  # noqa: BLE001
                print(f"[抓取跳过] {source_name}: {e}")

    return items


def generate_daily_briefing() -> dict:
    """执行抓取 -> DeepSeek 筛选总结 -> 输出标准 DailyReport 结构"""
    start_time = time.time()
    history_urls, recent_titles = load_recent_history(url_days=7, title_days=3)
    print(f"[去重] 已加载近 7 天历史链接 {len(history_urls)} 条，近 3 天标题 {len(recent_titles)} 条")
    raw_items = fetch_raw_articles(history_urls)

    if not raw_items:
        raise RuntimeError("所有数据源均抓取失败，请检查网络连接。")

    api_key = os.getenv("LLM_API_KEY")
    if not api_key or api_key.startswith("你的"):
        raise RuntimeError("请先在 backend/.env 中填入有效的 DeepSeek LLM_API_KEY。")

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"),
    )

    system_prompt = """你是一位资深 AI 行业情报主编，专门为读者策划高质量的「前沿 AI 深度图文日报」。
请从用户提供的原始资讯列表中，根据当天实际发生的资讯质量**动态筛选**出值得阅读的文章，构建今日「高质量候选池」（不设固定篇数，资讯多就多选，少就少选，通常在 10~30 篇之间，宁缺毋滥），并严格按 5 分制打分：
1. 核心重磅（4.0 ~ 5.0 分）：前沿大模型发布、AI Agent / 多模态 / 具身智能重大突破、头部科技公司战略重磅变动、行业级深度长文。其中 4.7 分及以上为全行业必看的特大新闻。
2. 细分精选（3.5 ~ 3.9 分）：芯片算力、开源工具、垂直应用、投融资、政策安全、论文解读等细分领域的高质量报道（用于匹配不同读者的个性化偏好）。
3. 坚决过滤（不入选）：低于 3.5 分的简短快讯、纯公关软文、无实质技术或商业洞察的水文、以及同质化重复报道（同一事件只保留最深度的一篇）。
4. 导读一致性（严格执行）：`overview` 字段只总结 4.0 分及以上最核心的前沿动态，严禁提及未入选 `articles` 列表的新闻。
5. 严格按照以下 JSON 格式输出（不要包含 Markdown 代码块之外的多余文字）：
{
  "overview": "用 2-3 句中文精炼总结今日最核心的前沿动态与趋势",
  "articles": [
    {
      "id": "art_001",
      "category": "前沿发布 | 深度解读 | 行业动态（三选一）",
      "title": "吸引人且准确的中文标题",
      "tldr": "60-80字中文核心要点，提炼文章最关键的技术细节或行业影响",
      "tags": ["标签1", "标签2", "标签3"],
      "url": "必须原样保留原始链接，严禁编造",
      "sourceName": "原样保留来源名称",
      "score": 4.8
    }
  ]
}"""

    pref_prompt = build_preference_prompt()
    if recent_titles:
        titles_str = "\n".join(f"- {t}" for t in recent_titles)
        system_prompt += (
            "\n\n【近 3 天已推送过的资讯（跨天去重，严格执行）】\n"
            f"{titles_str}\n"
            "注意：以上事件近几天已经推送过，除非今天有重大新进展或全新深度评测，否则即使换了媒体报道也请直接过滤，不要重复推送。"
        )
    if pref_prompt:
        system_prompt += pref_prompt
        print("[个性化] 已注入用户历史偏好到 DeepSeek 提示词")
    user_content = json.dumps(raw_items, ensure_ascii=False)

    response = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"),
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"以下是今日抓取的原始资讯：\n{user_content}"},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    result = json.loads(response.choices[0].message.content)
    duration = max(1, int(time.time() - start_time))

    # 补全前端需要的完整字段
    articles = result.get("articles", [])
    articles.sort(key=lambda x: float(x.get("score", 0)), reverse=True)
    articles = articles[:35]
    for idx, art in enumerate(articles, start=1):
        art["id"] = f"ds_{datetime.now().strftime('%m%d')}_{idx:03d}"
        art["userFeedback"] = None

    return {
        "reportDate": datetime.now().strftime("%Y-%m-%d"),
        "overview": result.get("overview", "今日 AI 简报已生成。"),
        "stats": {
            "scannedCount": len(raw_items),
            "selectedCount": len(articles),
            "durationSeconds": duration,
        },
        "articles": articles,
    }