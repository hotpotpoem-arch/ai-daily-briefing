export type FeedbackAction = 'like' | 'dislike' | null;

export interface ArticleItem {
  id: string;
  category: '开源项目' | '论文速递' | '行业动态' | string;
  title: string;
  tldr: string;
  tags: string[];
  url: string;
  sourceName: string;
  score: number; // AI 初筛评分 (1-5)
  userFeedback?: FeedbackAction;
}

export interface DailyReport {
  reportDate: string;
  overview: string; // 主编 Agent 生成的今日趋势总览
  stats: {
    scannedCount: number;
    selectedCount: number;
    durationSeconds: number;
  };
  articles: ArticleItem[];
}