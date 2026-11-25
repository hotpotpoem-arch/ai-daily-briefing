'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { Calendar, Cpu, RefreshCw, TrendingUp, Search, Sparkles, Clock, FileText, X, User } from 'lucide-react';
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
  const [uid, setUid] = useState<string>('default');
  const [userPrefText, setUserPrefText] = useState('');
  const [prefInput, setPrefInput] = useState('');
  const [showPrefModal, setShowPrefModal] = useState(false);
  const [isSavingPref, setIsSavingPref] = useState(false);
  const [staticArchive, setStaticArchive] = useState<Record<string, DailyReport>>({});
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

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'success') => {
      setToast({ message, type });
      setTimeout(() => {
        setToast((prev) => (prev?.message === message ? null : prev));
      }, 3000);
    },
    []
  );

  // 优先从 D1 API 拉取个性化重排后的简报，失败或空库时自动降级到静态 JSON / Mock
  const fetchBriefing = useCallback(
    async (targetUid: string, targetDate?: string, isManualRefresh = false) => {
      if (isManualRefresh) setIsRefreshing(true);
      try {
        const params = new URLSearchParams({
          uid: targetUid,
          t: String(Date.now()),
        });
        if (targetDate) params.set('date', targetDate);

        const apiRes = await fetch(`/api/briefing?${params.toString()}`);
        if (apiRes.ok) {
          const data = await apiRes.json();
          if (data.report && Array.isArray(data.dates) && data.dates.length > 0) {
            setAvailableDates(data.dates);
            setReport(data.report);
            setIsUsingMock(false);
            setAvailableDates(data.dates);
            setReport(data.report);
            setIsUsingMock(false);

            // 读取云端保存的自定义偏好；若未填过且未点击过「暂不设置」，自动弹出一次
            const serverPref = (data.userPrefText || '').trim();
            setUserPrefText(serverPref);
            setPrefInput(serverPref);
            if (!serverPref && !localStorage.getItem('briefing_pref_skipped')) {
              setShowPrefModal(true);
            }
            if (isManualRefresh) {
              showToast('已同步最新云端个性化简报', 'success');
            }
            return;
          }
        }
        throw new Error('D1 暂无数据，尝试读取静态归档');
      } catch {
        // 降级：读取静态 briefings.json（兼容本地开发或 D1 首次入库前）
        try {
          const res = await fetch(`/data/briefings.json?t=${Date.now()}`);
          if (!res.ok) throw new Error('尚未生成静态简报数据');
          const data: Record<string, DailyReport> = await res.json();
          const dates = Object.keys(data).sort().reverse();
          if (dates.length === 0) throw new Error('简报归档为空');

          const pickDate = targetDate && data[targetDate] ? targetDate : dates[0];
          setStaticArchive(data);
          setAvailableDates(dates);
          setReport(data[pickDate]);
          setIsUsingMock(false);
          if (isManualRefresh) {
            showToast('已同步最新静态简报', 'success');
          }
        } catch {
          setReport(MOCK_REPORT);
          setIsUsingMock(true);
          if (isManualRefresh) {
            showToast('云端尚未生成首份简报，当前为演示数据', 'info');
          }
        }
      } finally {
        setLoading(false);
        setIsRefreshing(false);
      }
    },
    [showToast]
  );

  // 初始化：解析 URL 中的 ?uid=xxx 或读取 localStorage
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlUid = params.get('uid')?.trim();
    let activeUid = 'default';

    if (urlUid) {
      activeUid = urlUid;
      localStorage.setItem('briefing_uid', urlUid);
    } else {
      const savedUid = localStorage.getItem('briefing_uid')?.trim();
      if (savedUid) activeUid = savedUid;
    }

    const init = async () => {
      await fetchBriefing(activeUid);
      setUid(activeUid);
    };
    init();
  }, [fetchBriefing]);

  const handleDateChange = async (date: string) => {
    setSelectedCategory('全部');
    setSearchQuery('');
    if (staticArchive[date]) {
      setReport(staticArchive[date]);
      showToast(`已切换至 ${date} 简报`, 'info');
      return;
    }
    await fetchBriefing(uid, date);
    showToast(`已切换至 ${date} 简报`, 'info');
  };

  const handleFeedbackSubmit = async (articleId: string, action: FeedbackAction) => {
    if (!report) return;
    const targetArticle = report.articles.find((a) => a.id === articleId);
    if (!targetArticle) return;

    showToast('正在同步偏好到云端...', 'info');

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid,
          articleId,
          action,
          title: targetArticle.title,
          category: targetArticle.category || 'AI',
          tags: Array.isArray(targetArticle.tags) ? targetArticle.tags : [],
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || '同步失败');
      }

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
        showToast('已记录偏好：感兴趣，后续将优先为你推荐同类主题', 'success');
      } else if (action === 'dislike') {
        showToast('已记录偏好：后续将降低此类内容权重', 'info');
      } else {
        showToast('已取消该条反馈', 'info');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '网络异常，请稍后重试';
      showToast(`偏好记录失败：${message}`, 'error');
      throw err;
    }
  };

  const handleSavePref = async () => {
    setIsSavingPref(true);
    try {
      const res = await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, prefText: prefInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');

      setUserPrefText(prefInput.trim());
      setShowPrefModal(false);
      localStorage.setItem('briefing_pref_skipped', '1');
      showToast('偏好已保存，正在为你重新排序...', 'success');
      await fetchBriefing(uid, report?.reportDate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '网络异常';
      showToast(`偏好保存失败：${msg}`, 'error');
    } finally {
      setIsSavingPref(false);
    }
  };

  const handleSkipPref = () => {
    localStorage.setItem('briefing_pref_skipped', '1');
    setShowPrefModal(false);
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
      
      {/* 个性化偏好设置弹窗 */}
      {showPrefModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#FAF9F6] border border-stone-200 shadow-xl p-6">
            <h3 className="text-lg font-semibold text-stone-900">定制你的 AI 简报偏好</h3>
            <p className="mt-1.5 text-sm text-stone-500">
              用一句话描述你关注的方向、公司或不想看的内容，AI 会自动为你置顶相关资讯（仍会保留行业重磅新闻）。
            </p>
            <textarea
              value={prefInput}
              onChange={(e) => setPrefInput(e.target.value)}
              rows={4}
              placeholder="例如：关注英伟达芯片、具身智能和开源工具，少看纯融资和 AI 伦理争议"
              className="mt-4 w-full rounded-xl border border-stone-300 bg-white p-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none"
            />
            <div className="mt-4 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={handleSkipPref}
                disabled={isSavingPref}
                className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-200/60 transition-colors"
              >
                暂不设置
              </button>
              <button
                type="button"
                onClick={handleSavePref}
                disabled={isSavingPref}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 transition-colors"
              >
                {isSavingPref ? 'AI 正在解析偏好...' : '保存并重排'}
              </button>
            </div>
          </div>
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
                {uid !== 'default' && (
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">
                    <User className="h-3 w-3" />
                    {uid}
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
              onClick={() => fetchBriefing(uid, report?.reportDate, true)}
              disabled={isRefreshing}
              title="刷新简报"
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg bg-stone-900 p-2 sm:px-3.5 sm:py-1.5 text-xs sm:text-sm font-medium text-white shadow-xs hover:bg-stone-800 active:scale-[0.98] disabled:opacity-60 transition-all cursor-pointer"
            >
              <RefreshCw
                className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              />
              <span className="hidden sm:inline">
                {isRefreshing ? '同步中...' : '刷新简报'}
              </span>
            </button>
            <button
        type="button"
        onClick={() => {
          setPrefInput(userPrefText);
          setShowPrefModal(true);
        }}
        className="px-3 py-1.5 rounded-xl border border-stone-200 bg-white text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors"
      >
        ⚙️ 偏好
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