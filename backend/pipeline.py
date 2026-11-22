import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import feedparser
import httpx
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
PREF_FILE = Path(__file__).parent / "preferences.json"


def build_preference_prompt() -> str:
    """读取用户历史点赞/点踩，生成动态偏好指令"""
    if not PREF_FILE.exists():
        return ""

    try:
        prefs = json.loads(PREF_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return ""

    liked = prefs.get("liked", [])
    disliked = prefs.get("disliked", [])
    if not liked and not disliked:
        return ""

    lines = ["\n\n【用户历史个性化偏好（请在筛选和排序时重点参考）】"]
    if liked:
        liked_str = "；".join(
            f"{x['title']}({','.join(x.get('tags', []))})" for x in liked
        )
        lines.append(f"- 用户感兴趣的内容：{liked_str}")
    if disliked:
        disliked_str = "；".join(
            f"{x['title']}({','.join(x.get('tags', []))})" for x in disliked
        )
        lines.append(f"- 用户不感兴趣的内容（尽量避开类似主题）：{disliked_str}")

    return "\n".join(lines)

def fetch_raw_articles() -> list[dict]:
    """从 Hacker News、arXiv、GitHub 抓取最新 AI 资讯"""
    items: list[dict] = []

    # 1. Hacker News AI 热门讨论 (RSS)
    try:
        hn_feed = feedparser.parse("https://hnrss.org/frontpage?q=AI+OR+LLM+OR+Agent")
        for entry in hn_feed.entries[:10]:
            items.append(
                {
                    "title": entry.get("title", ""),
                    "summary": entry.get("summary", "")[:300],
                    "url": entry.get("link", ""),
                    "sourceName": "Hacker News",
                }
            )
    except Exception as e:  # noqa: BLE001
        print(f"[HN 抓取跳过] {e}")

    # 2. arXiv cs.AI 最新论文 (RSS)
    try:
        arxiv_feed = feedparser.parse("https://rss.arxiv.org/rss/cs.AI")
        for entry in arxiv_feed.entries[:10]:
            items.append(
                {
                    "title": entry.get("title", ""),
                    "summary": entry.get("summary", "")[:300],
                    "url": entry.get("link", ""),
                    "sourceName": "arXiv cs.AI",
                }
            )
    except Exception as e:  # noqa: BLE001
        print(f"[arXiv 抓取跳过] {e}")

    # 3. GitHub 近 7 天高星 AI 开源项目 (公开 API)
    try:
        since_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        gh_url = (
            f"https://api.github.com/search/repositories"
            f"?q=topic:ai+pushed:>{since_date}&sort=stars&order=desc&per_page=8"
        )
        resp = httpx.get(
            gh_url,
            headers={"Accept": "application/vnd.github+json"},
            timeout=15.0,
        )
        if resp.status_code == 200:
            for repo in resp.json().get("items", []):
                items.append(
                    {
                        "title": f"{repo['full_name']} (⭐{repo['stargazers_count']})",
                        "summary": (repo.get("description") or "暂无简介")[:300],
                        "url": repo["html_url"],
                        "sourceName": "GitHub Trending",
                    }
                )
    except Exception as e:  # noqa: BLE001
        print(f"[GitHub 抓取跳过] {e}")

    return items


def generate_daily_briefing() -> dict:
    """执行抓取 -> DeepSeek 筛选总结 -> 输出标准 DailyReport 结构"""
    start_time = time.time()
    raw_items = fetch_raw_articles()

    if not raw_items:
        raise RuntimeError("所有数据源均抓取失败，请检查网络连接。")

    api_key = os.getenv("LLM_API_KEY")
    if not api_key or api_key.startswith("你的"):
        raise RuntimeError("请先在 backend/.env 中填入有效的 DeepSeek LLM_API_KEY。")

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"),
    )

    system_prompt = """你是一位资深 AI 行业情报分析师。
请从用户提供的原始资讯列表中，筛选出最有价值的 6 条内容，并严格按照以下 JSON 格式输出（不要包含 Markdown 代码块之外的多余文字）：
{
  "overview": "用 2-3 句中文总结今日 AI 领域的核心趋势",
  "articles": [
    {
      "id": "art_001",
      "category": "开源项目 | 论文速递 | 行业动态（三选一）",
      "title": "精炼的中文标题",
      "tldr": "60字以内的中文核心要点总结",
      "tags": ["标签1", "标签2", "标签3"],
      "url": "必须原样保留原始链接，严禁编造",
      "sourceName": "原样保留来源名称",
      "score": 4.8
    }
  ]
}"""

    pref_prompt = build_preference_prompt()
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