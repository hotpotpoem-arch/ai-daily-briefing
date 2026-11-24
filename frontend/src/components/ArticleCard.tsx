'use client';

import { useState, useEffect, useMemo } from 'react';
import { ExternalLink, ThumbsUp, ThumbsDown, Sparkles, BookOpen, ArrowLeft } from 'lucide-react';
import { ArticleItem, FeedbackAction } from '@/types/briefing';

interface ArticleCardProps {
  article: ArticleItem;
  onFeedbackSubmit: (articleId: string, action: FeedbackAction) => Promise<void>;
}

/** 轻量级 Markdown 转 HTML（带排版样式，零依赖） */
function renderMarkdown(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, src) =>
        `<img src="/api/img?url=${encodeURIComponent(src)}" alt="${alt}" loading="lazy" onerror="this.style.display='none'" class="my-4 max-w-full rounded-lg mx-auto block shadow-sm" />`
      )
      .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-slate-900">$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="rounded bg-slate-100 px-1.5 py-0.5 text-[13px] font-mono text-slate-800">$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-indigo-600 underline decoration-indigo-200 underline-offset-2">$1</a>');

  const lines = md.split(/\r?\n/);
  let html = '';
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeLists();
      continue;
    }

    if (/^###\s+/.test(line)) {
      closeLists();
      html += `<h3 class="mt-5 mb-2 text-[15px] font-semibold text-slate-800">${inline(line.replace(/^###\s+/, ''))}</h3>`;
    } else if (/^##\s+/.test(line)) {
      closeLists();
      html += `<h2 class="mt-7 mb-3 border-b border-slate-100 pb-1.5 text-[17px] font-semibold text-slate-900">${inline(line.replace(/^##\s+/, ''))}</h2>`;
    } else if (/^#\s+/.test(line)) {
      closeLists();
      html += `<h1 class="mt-4 mb-4 text-xl font-bold text-slate-900">${inline(line.replace(/^#\s+/, ''))}</h1>`;
    } else if (/^>\s*/.test(line)) {
      closeLists();
      html += `<blockquote class="my-4 rounded-r-lg border-l-3 border-indigo-500 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">${inline(line.replace(/^>\s*/, ''))}</blockquote>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (inOl) { html += '</ol>'; inOl = false; }
      if (!inUl) { html += '<ul class="mb-4 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-700">'; inUl = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else if (/^\d+\.\s+/.test(line)) {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (!inOl) { html += '<ol class="mb-4 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-700">'; inOl = true; }
      html += `<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`;
    } else {
      closeLists();
      html += `<p class="mb-4 text-justify text-[15px] leading-[1.85] text-slate-700">${inline(line)}</p>`;
    }
  }

  closeLists();
  return html;
}

export function ArticleCard({ article, onFeedbackSubmit }: ArticleCardProps) {
  const [feedback, setFeedback] = useState<FeedbackAction>(article.userFeedback ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReaderOpen, setIsReaderOpen] = useState(false);

  // 打开纯享弹窗时锁定底层页面滚动
  useEffect(() => {
    if (!isReaderOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isReaderOpen]);

  const renderedHtml = useMemo(() => {
    if (!article.contentZh) return '';
    return renderMarkdown(article.contentZh);
  }, [article.contentZh]);

  const handleFeedback = async (targetAction: 'like' | 'dislike') => {
    if (isSubmitting) return;

    const prevFeedback = feedback;
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

  const cleanReadUrl = `/api/read?url=${encodeURIComponent(article.url)}`;
  const hasInstantContent = Boolean(article.contentZh && article.contentZh.trim());

  return (
    <>
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
              {hasInstantContent ? (
                <button
                  type="button"
                  onClick={() => setIsReaderOpen(true)}
                  title="秒开纯享中文阅读"
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-indigo-600"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  <span>纯享</span>
                </button>
              ) : (
                <a
                  href={cleanReadUrl}
                  title="免登录提取纯文本正文"
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-indigo-600"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  <span>纯享</span>
                </a>
              )}

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

      {/* 本地 0 延迟全屏纯享阅读层 */}
      {isReaderOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-100">
          <div className="mx-auto min-h-screen max-w-[680px] bg-white px-5 pb-16 pt-4 shadow-sm">
            {/* 顶部返回栏（吸顶） */}
            <div className="sticky top-0 z-10 -mx-5 mb-5 flex items-center justify-between border-b border-slate-100 bg-white/95 px-5 py-3 backdrop-blur">
              <button
                type="button"
                onClick={() => setIsReaderOpen(false)}
                className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 active:opacity-70"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>返回简报</span>
              </button>
              <span className="text-xs text-slate-400">{article.sourceName}</span>
            </div>

            {/* 正文标题与渲染后的中文内容 */}
            <h1 className="mb-5 text-xl font-bold leading-snug text-slate-900">
              {article.title}
            </h1>
            <div
              className="break-words"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>
        </div>
      )}
    </>
  );
}