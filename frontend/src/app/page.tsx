'use client';

import { useEffect, useState, useMemo } from 'react';
import { Calendar, Cpu, RefreshCw, TrendingUp, Search, Sparkles, Clock, FileText, X } from 'lucide-react';
import { ArticleCard } from '@/components/ArticleCard';
import { DailyReport, FeedbackAction } from '@/types/briefing';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

// 本地开发兜底 Mock 数据，后端未启动时自动展示
const MOCK_REPORT: DailyReport = {
  reportDate: '2026-11-21',
  overview:
    '今日社区焦点集中在多智能体编排与低延迟推理优化。开源领域出现了多个基于 MCP 协议的轻量级工具网关；学术界则重点探讨了长上下文下的记忆压缩机制，整体趋势正从“单次对话”加速向“长周期自主执行”演进。',
  stats: {
    scannedCount: 64,
    selectedCount: 4,
    durationSeconds: 36,
  },
  articles: [
    {
      id: 'art_001',
      category: '开源项目',
      title: 'MCP-Gateway：零代码将内部 REST API 转化为 Agent 标准工具',
      tldr: '通过 YAML 配置即可将传统微服务接口自动封装为 MCP Server，内置鉴权与限流，大幅降低多 Agent 接入企业内部系统的胶水代码量。',
      tags: ['MCP', 'Agent基建', '开源'],
      url: 'https://github.com/example/mcp-gateway',
      sourceName: 'GitHub Trending',
      score: 4.9,
      userFeedback: null,
    },
    {
      id: 'art_002',
      category: '论文速递',
      title: '分层情景记忆网络：将长周期 Agent 的 Token 消耗降低 60%',
      tldr: '提出一种仿人类海马体的双层记忆压缩架构，在跨周任务基准测试中保持 94% 召回率的同时，显著缓解了上下文腐烂问题。',
      tags: ['Memory', 'arXiv', '长上下文'],
      url: 'https://arxiv.org/abs/2611.00001',
      sourceName: 'arXiv cs.AI',
      score: 4.7,
      userFeedback: 'like',
    },
    {
      id: 'art_003',
      category: '开源项目',
      title: 'TinySandbox：基于 Firecracker 的毫秒级 Python 代码执行沙箱',
      tldr: '专为数据分析与代码 Agent 设计的轻量级隔离环境，冷启动时间低于 120ms，支持挂载只读数据卷与自动内存回收。',
      tags: ['Sandbox', '安全隔离', 'Python'],
      url: 'https://github.com/example/tiny-sandbox',
      sourceName: 'GitHub Trending',
      score: 4.6,
      userFeedback: null,
    },
    {
      id: 'art_004',
      category: '行业动态',
      title: '主流大厂联合发布企业级 Agent 评测基准 v2.0',
      tldr: '新增工具调用容错率、多步规划一致性与安全护栏拦截率三项核心指标，为生产级 AI 应用提供统一验收标准。',
      tags: ['Eval', '行业标准', '生产落地'],
      url: 'https://news.ycombinator.com',
      sourceName: 'Hacker News',
      score: 4.5,
      userFeedback: null,
    },
  ],
};

export default function DailyBriefingPage() {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('全部');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [isUsingMock, setIsUsingMock] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const showToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'success'
  ) => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 3000);
  };

  const fetchAvailableDates = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/reports/dates`);
      if (res.ok) {
        const data = await res.json();
        setAvailableDates(data.dates || []);
      }
    } catch (err) {
      console.error('获取历史日期失败:', err);
    }
  };

  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    showToast('正在抓取最新资讯并调用 DeepSeek 总结...', 'info');
    try {
      const res = await fetch(`${API_BASE}/api/reports/generate`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('生成失败');
      const data = await res.json();
      setReport(data);
      setIsUsingMock(false);
      await fetchAvailableDates();
      showToast('今日 AI 简报已更新！', 'success');
    } catch (err) {
      console.error(err);
      showToast('生成失败，请检查后端服务是否已启动', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDateChange = async (date: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/reports/${date}`);
      if (!res.ok) throw new Error('获取历史简报失败');
      const data = await res.json();
      setReport(data);
      setSelectedCategory('全部');
      setSearchQuery('');
      setIsUsingMock(false);
      showToast(`已切换至 ${date} 简报`, 'info');
    } catch (err) {
      console.error(err);
      showToast('切换历史简报失败，请稍后重试', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const initLoad = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/reports/latest`);
        if (!res.ok) throw new Error('API 请求失败');
        const data: DailyReport = await res.json();
        if (active) {
          setReport(data);
          setIsUsingMock(false);
          fetchAvailableDates();
        }
      } catch {
        if (active) {
          setReport(MOCK_REPORT);
          setIsUsingMock(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    initLoad();
    return () => {
      active = false;
    };
  }, []);

  const handleFeedbackSubmit = async (articleId: string, action: FeedbackAction) => {
    if (isUsingMock) {
      console.log(`[Mock 反馈] articleId=${articleId}, action=${action}`);
      showToast('[演示模式] 已记录你的偏好反馈', 'info');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_id: articleId, action }),
      });
      if (!res.ok) throw new Error('反馈提交失败');

      if (action === 'like') {
        showToast('已记录偏好，下次生成将优先推荐此类内容', 'success');
      } else if (action === 'dislike') {
        showToast('已记录反馈，后续将减少此类资讯推送', 'info');
      }
    } catch {
      showToast('反馈提交失败，请检查后端服务', 'error');
    }
  };

  // 提取分类及对应数量
  const categoryStats = useMemo(() => {
    if (!report) return [];
    const counts: Record<string, number> = {};
    report.articles.forEach((a) => {
      counts[a.category] = (counts[a.category] || 0) + 1;
    });
    return [
      { name: '全部', count: report.articles.length },
      ...Object.entries(counts).map(([name, count]) => ({ name, count })),
    ];
  }, [report]);

  // 结合分类与关键词过滤文章
  const filteredArticles = useMemo(() => {
    if (!report) return [];
    return report.articles.filter((article) => {
      const matchCategory =
        selectedCategory === '全部' || article.category === selectedCategory;
      const q = searchQuery.trim().toLowerCase();
      const matchSearch =
        !q ||
        article.title.toLowerCase().includes(q) ||
        article.category.toLowerCase().includes(q);
      return matchCategory && matchSearch;
    });
  }, [report, selectedCategory, searchQuery]);

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900 selection:bg-amber-100 selection:text-stone-900">
      {/* 右上角 Toast 提示条 */}
      {toast && (
        <div
          className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg border backdrop-blur-md transition-all duration-300 ${
            toast.type === 'success'
              ? 'bg-emerald-50/95 border-emerald-200/80 text-emerald-900'
              : toast.type === 'error'
              ? 'bg-rose-50/95 border-rose-200/80 text-rose-900'
              : 'bg-stone-900/95 border-stone-700 text-stone-50'
          }`}
        >
          <span className="text-sm">
            {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : '✨'}
          </span>
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      )}

      {/* 顶部毛玻璃吸顶导航栏 */}
      <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-[#FAF9F6]/85 backdrop-blur-md">
        <div className="mx-auto max-w-5xl px-5 sm:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-stone-900 text-amber-50 flex items-center justify-center shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-stone-900">
                  AI Daily Briefing
                </h1>
                {isUsingMock && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    演示模式
                  </span>
                )}
              </div>
              <p className="hidden sm:block text-xs text-stone-500">
                每日精选 AI 与前沿科技情报
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* 历史日期选择器 */}
            {availableDates.length > 0 && (
              <div className="relative flex items-center">
                <Calendar className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-stone-400" />
                <select
                  value={report?.reportDate || ''}
                  onChange={(e) => handleDateChange(e.target.value)}
                  className="appearance-none rounded-lg border border-stone-200 bg-white pl-8 pr-7 py-1.5 text-xs sm:text-sm font-medium text-stone-700 shadow-xs hover:border-stone-300 focus:border-stone-500 focus:outline-none transition-colors cursor-pointer"
                >
                  {availableDates.map((date) => (
                    <option key={date} value={date}>
                      {date}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 手动刷新/生成按钮 */}
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs sm:text-sm font-medium text-white shadow-xs hover:bg-stone-800 active:scale-[0.98] disabled:opacity-60 transition-all cursor-pointer"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isGenerating ? 'animate-spin' : ''}`}
              />
              <span>{isGenerating ? '生成中...' : '更新简报'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* 主内容区域 */}
      <main className="mx-auto max-w-5xl px-5 sm:px-8 py-8 sm:py-10 space-y-8">
        {loading ? (
          /* 骨架屏加载状态 */
          <div className="space-y-6 animate-pulse">
            <div className="h-44 rounded-2xl bg-stone-200/70" />
            <div className="flex gap-2">
              <div className="h-9 w-20 rounded-full bg-stone-200/70" />
              <div className="h-9 w-24 rounded-full bg-stone-200/70" />
              <div className="h-9 w-24 rounded-full bg-stone-200/70" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="h-52 rounded-2xl bg-stone-200/70" />
              <div className="h-52 rounded-2xl bg-stone-200/70" />
              <div className="h-52 rounded-2xl bg-stone-200/70" />
              <div className="h-52 rounded-2xl bg-stone-200/70" />
            </div>
          </div>
        ) : !report ? (
          <div className="rounded-2xl border border-stone-200 bg-white p-12 text-center">
            <p className="text-stone-500">暂无简报数据，请点击右上角「更新简报」。</p>
          </div>
        ) : (
          <>
            {/* 杂志风今日概览卡片（Hero 区） */}
            <section className="relative overflow-hidden rounded-2xl border border-stone-200/90 bg-white p-6 sm:p-8 shadow-xs">
              <div className="absolute top-0 left-0 h-full w-1.5 bg-stone-900" />
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                  <TrendingUp className="h-4 w-4 text-amber-600" />
                  <span>今日核心导读 · Executive Summary</span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  <Calendar className="h-3.5 w-3.5" />
                  {report.reportDate}
                </span>
              </div>

              <p className="text-base sm:text-[17px] leading-relaxed text-stone-700 font-normal">
                {report.overview}
              </p>

              {/* 轻量指标胶囊 */}
              <div className="mt-6 pt-5 border-t border-stone-100 flex flex-wrap items-center gap-3 text-xs text-stone-500">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-50 border border-stone-200/70 px-3 py-1">
                  <FileText className="h-3.5 w-3.5 text-stone-400" />
                  扫描源文 <strong className="text-stone-800">{report.stats.scannedCount}</strong> 篇
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-50 border border-stone-200/70 px-3 py-1">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  深度精选 <strong className="text-stone-800">{report.stats.selectedCount}</strong> 篇
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-50 border border-stone-200/70 px-3 py-1">
                  <Clock className="h-3.5 w-3.5 text-stone-400" />
                  耗时 <strong className="text-stone-800">{report.stats.durationSeconds}s</strong>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-50 border border-stone-200/70 px-3 py-1">
                  <Cpu className="h-3.5 w-3.5 text-stone-400" />
                  DeepSeek 驱动
                </span>
              </div>
            </section>

            {/* 分类胶囊 + 实时搜索工具条 */}
            <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {categoryStats.map((cat) => {
                  const active = selectedCategory === cat.name;
                  return (
                    <button
                      key={cat.name}
                      onClick={() => setSelectedCategory(cat.name)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs sm:text-sm font-medium transition-all cursor-pointer ${
                        active
                          ? 'bg-stone-900 text-white shadow-xs'
                          : 'bg-white text-stone-600 border border-stone-200/80 hover:border-stone-300 hover:text-stone-900'
                      }`}
                    >
                      <span>{cat.name}</span>
                      <span
                        className={`text-[11px] px-1.5 py-0.2 rounded-full ${
                          active
                            ? 'bg-stone-700 text-stone-200'
                            : 'bg-stone-100 text-stone-500'
                        }`}
                      >
                        {cat.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 实时关键词搜索框 */}
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索标题或关键词..."
                  className="w-full rounded-full border border-stone-200/90 bg-white pl-9 pr-8 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </section>

            {/* 情报卡片网格 */}
            {filteredArticles.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 py-14 text-center">
                <p className="text-sm text-stone-500">
                  没有找到匹配「{searchQuery}」的情报，试试换个关键词吧。
                </p>
              </div>
            ) : (
              <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {filteredArticles.map((article) => (
                  <ArticleCard
                    key={article.id}
                    article={article}
                onFeedbackSubmit={handleFeedbackSubmit}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}