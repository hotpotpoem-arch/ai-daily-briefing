'use client';

import { useEffect, useState, useMemo } from 'react';
import { Calendar, Cpu, RefreshCw, TrendingUp, Search, Sparkles, Clock, FileText, X } from 'lucide-react';
import { ArticleCard } from '@/components/ArticleCard';
import { DailyReport, FeedbackAction } from '@/types/briefing';

// 兜底 Mock 数据，首次运行自动化任务前自动展示
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
  const [archive, setArchive] = useState<Record<string, DailyReport>>({});
  const [report, setReport] = useState<DailyReport | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('全部');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [isUsingMock, setIsUsingMock] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
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

  const loadStaticBriefings = async (isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true);
    try {
      // 加时间戳参数避免浏览器缓存旧 JSON
      const res = await fetch(`/data/briefings.json?t=${Date.now()}`);
      if (!res.ok) throw new Error('尚未生成静态简报数据');
      const data: Record<string, DailyReport> = await res.json();
      const dates = Object.keys(data).sort().reverse();

      if (dates.length === 0) throw new Error('简报归档为空');

      setArchive(data);
      setAvailableDates(dates);
      setReport(data[dates[0]]);
      setIsUsingMock(false);

      if (isManualRefresh) {
        showToast('已同步最新云端简报（每日早 8:00 自动更新）', 'success');
      }
    } catch {
      setReport(MOCK_REPORT);
      setIsUsingMock(true);
      if (isManualRefresh) {
        showToast('云端尚未生成首份简报，当前为演示数据', 'info');
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    let active = true;
    const initLoad = async () => {
      try {
        const res = await fetch(`/data/briefings.json?t=${Date.now()}`);
        if (!res.ok) throw new Error('尚未生成静态简报数据');
        const data: Record<string, DailyReport> = await res.json();
        const dates = Object.keys(data).sort().reverse();
        if (dates.length === 0) throw new Error('简报归档为空');

        if (active) {
          setArchive(data);
          setAvailableDates(dates);
          setReport(data[dates[0]]);
          setIsUsingMock(false);
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

  const handleDateChange = (date: string) => {
    const target = archive[date];
    if (target) {
      setReport(target);
      setSelectedCategory('全部');
      setSearchQuery('');
      showToast(`已切换至 ${date} 简报`, 'info');
    }
  };

  const handleFeedbackSubmit = async (articleId: string, action: FeedbackAction) => {
    if (!report) return;
    const targetArticle = report.articles.find((a) => a.id === articleId);
    if (!targetArticle) return;

    // 如果取消点赞/踩，仅更新本地状态
    if (action !== 'like' && action !== 'dislike') {
      setReport((prev) =>
        prev
          ? {
              ...prev,
              articles: prev.articles.map((a) =>
                a.id === articleId ? { ...a, userFeedback: null } : a
              ),
            }
          : prev
      );
      return;
    }

    showToast('正在同步偏好到云端...', 'info');

    try {
      const params = new URLSearchParams({
        action,
        title: targetArticle.title,
        category: targetArticle.category || 'AI',
        tags: Array.isArray(targetArticle.tags) ? targetArticle.tags.join(',') : '',
        format: 'json',
      });

      const res = await fetch(`/api/feedback?${params.toString()}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.desc || '同步失败');
      }

      // 同步更新当前页面的卡片反馈状态
      setReport((prev) =>
        prev
          ? {
              ...prev,
              articles: prev.articles.map((a) =>
                a.id === articleId ? { ...a, userFeedback: action } : a
              ),
            }
          : prev
      );

      if (action === 'like') {
        showToast('已同步至云端：感兴趣，明天将优先推荐同类主题', 'success');
      } else {
        showToast('已同步至云端：后续将降低此类内容权重', 'info');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '网络异常，请稍后重试';
      showToast(`偏好记录失败：${message}`, 'error');
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

            {/* 同步最新简报按钮 */}
            <button
              onClick={() => loadStaticBriefings(true)}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs sm:text-sm font-medium text-white shadow-xs hover:bg-stone-800 active:scale-[0.98] disabled:opacity-60 transition-all cursor-pointer"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              />
              <span>{isRefreshing ? '同步中...' : '刷新简报'}</span>
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
            <p className="text-stone-500">暂无简报数据。</p>
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