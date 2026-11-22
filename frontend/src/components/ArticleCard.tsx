'use client';

import { useState } from 'react';
import { ExternalLink, ThumbsUp, ThumbsDown, Sparkles, BookOpen } from 'lucide-react';
import { ArticleItem, FeedbackAction } from '@/types/briefing';

interface ArticleCardProps {
  article: ArticleItem;
  onFeedbackSubmit: (articleId: string, action: FeedbackAction) => Promise<void>;
}

export function ArticleCard({ article, onFeedbackSubmit }: ArticleCardProps) {
  const [feedback, setFeedback] = useState<FeedbackAction>(article.userFeedback ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFeedback = async (targetAction: 'like' | 'dislike') => {
    if (isSubmitting) return;

    const prevFeedback = feedback;
    // 再次点击已选中的按钮则取消反馈
    const nextFeedback: FeedbackAction = prevFeedback === targetAction ? null : targetAction;

    setFeedback(nextFeedback);
    setIsSubmitting(true);

    try {
      await onFeedbackSubmit(article.id, nextFeedback);
    } catch (error) {
      console.error('提交反馈失败，回滚状态:', error);
      setFeedback(prevFeedback);
    } finally {
      setIsSubmitting(false);
    }
  };

  const cleanReadUrl = `https://r.jina.ai/${article.url}`;

  return (
    <article className="group flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:border-indigo-200 hover:shadow-md">
      <div>
        {/* 顶部：来源与 AI 评分 */}
        <div className="mb-2.5 flex items-center justify-between text-xs text-slate-500">
          <span className="font-medium text-slate-600">{article.sourceName}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
            <Sparkles className="h-3 w-3" />
            AI 评分 {article.score.toFixed(1)}
          </span>
        </div>

        {/* 标题 */}
        <a
          href={article.url}
          className="mb-2 block text-base font-semibold leading-snug text-slate-900 transition-colors group-hover:text-indigo-600"
        >
          {article.title}
        </a>

        {/* 核心亮点 TL;DR */}
        <p className="mb-4 text-sm leading-relaxed text-slate-600">
          {article.tldr}
        </p>
      </div>

      {/* 底部：标签 + 交互栏 */}
      <div className="space-y-3 border-t border-slate-100 pt-3">
        <div className="flex flex-wrap gap-1.5">
          {article.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
            >
              #{tag}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          {/* 点赞 / 点踩反馈按钮 */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleFeedback('like')}
              disabled={isSubmitting}
              aria-label="感兴趣"
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                feedback === 'like'
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
              <span>感兴趣</span>
            </button>

            <button
              type="button"
              onClick={() => handleFeedback('dislike')}
              disabled={isSubmitting}
              aria-label="不感兴趣"
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                feedback === 'dislike'
                  ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 纯享阅读 + 查看原文 */}
          <div className="flex shrink-0 items-center gap-3">
            <a
              href={cleanReadUrl}
              title="免登录提取纯文本正文"
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-indigo-600"
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span>纯享</span>
            </a>

            <a
              href={article.url}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-800"
            >
              <span>查看原文</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}