# 🤖 AI Daily Briefing Agent（AI 每日情报简报系统）

一个全栈自动化 AI 情报简报 Agent：支持多源科技/AI 资讯自动抓取、DeepSeek 结构化总结、用户偏好反馈闭环、SQLite 历史归档，以及基于 GitHub Actions 的每日定时个人微信推送。

> **项目亮点**：零服务器成本实现 7×24 小时云端定时调度；通过点赞/点踩实时更新偏好配置并动态注入 Prompt，实现越用越懂你的个性化早报。

---

## 🏗️ 系统架构

```mermaid
flowchart LR
    A[多源 RSS / 资讯抓取] --> B[DeepSeek LLM 总结与评分]
    F[用户点赞/点踩偏好<br/>preferences.json] -->|动态注入 Prompt| B
    B --> C[(SQLite 归档<br/>briefings.db)]
    C --> D[FastAPI 后端接口]
    D --> E[Next.js 前端看板<br/>历史日期切换 / 分类筛选]
    B --> G[GitHub Actions 定时任务<br/>每天 08:00 UTC+8]
    G --> H[PushPlus 个人微信推送]
