from datetime import datetime
from daily_push import (
    export_static_json,
    ingest_to_d1,
    push_to_wechat,
    push_to_wecom,
)

custom_article = {
    "id": f"manual_{datetime.now().strftime('%m%d_%H%M')}",
    "category": "重磅突发",
    "title": "AI 联手攻克 167 年数学难题：Claude 辅助完成黎曼猜想证明并获 Lean 社区核验",
    "tldr": "Anthropic 数学家 Levent Alpöge 借助 Claude 耗时六周完成黎曼猜想的 Lean 形式化证明（约 1700 万行代码），Lean 与 Mathlib 社区已联合确认其逻辑与命题表述通过验证，但人类可读版本仍待整理。",
    "tags": ["Claude", "黎曼猜想", "形式化证明"],
    "url": "https://www.theguardian.com/technology/2026/nov/21/anthropic-riemann-hypothesis-solved-claude-ai",
    "sourceName": "The Guardian",
    "score": 5.0,
    "userFeedback": None,
}

report = {
    "reportDate": datetime.now().strftime("%Y-%m-%d"),
    "overview": "【重磅加推】Anthropic 数学家借助 Claude 完成 167 年未解难题「黎曼猜想」的 Lean 形式化证明，已获 Lean 与 Mathlib 两大形式化数学社区联合核验。",
    "stats": {
        "scannedCount": 1,
        "selectedCount": 1,
        "durationSeconds": 1,
    },
    "articles": [custom_article],
}

if __name__ == "__main__":
    export_static_json(report)
    ingest_to_d1(report)

    try:
        push_to_wecom(report)
    except Exception as e:
        print(f"[企业微信推送失败] {e}")