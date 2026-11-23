/* eslint-disable */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function isAuthorized(request, env) {
  const secret = env.INGEST_SECRET;
  if (!secret) return false;
  return request.headers.get('Authorization') === `Bearer ${secret}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. 记录/取消用户偏好反馈（按 uid 隔离）
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      try {
        const body = await request.json();
        const uid = (body.uid || 'default').trim();
        const articleId = body.articleId;
        const action = body.action; // 'like' | 'dislike' | null

        if (!articleId) return jsonResp({ error: '缺少 articleId' }, 400);

        // 自动确保用户存在于 users 表
        await env.DB.prepare('INSERT OR IGNORE INTO users (uid) VALUES (?)').bind(uid).run();

        if (!action) {
          await env.DB.prepare(
            'DELETE FROM user_feedback WHERE uid = ? AND article_id = ?'
          ).bind(uid, articleId).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO user_feedback (uid, article_id, title, category, tags, action, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(uid, article_id) DO UPDATE SET
               action = excluded.action,
               updated_at = CURRENT_TIMESTAMP`
          ).bind(
            uid,
            articleId,
            body.title || '',
            body.category || '',
            JSON.stringify(body.tags || []),
            action
          ).run();
        }

        return jsonResp({ ok: true, uid, articleId, action });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 2. 获取个性化重排后的简报
    if (url.pathname === '/api/briefing' && request.method === 'GET') {
      try {
        const uid = (url.searchParams.get('uid') || 'default').trim();
        const reqDate = url.searchParams.get('date');

        // 查询所有可用日期
        const { results: dateRows } = await env.DB.prepare(
          'SELECT DISTINCT report_date FROM articles ORDER BY report_date DESC LIMIT 30'
        ).all();
        const dates = dateRows.map((r) => r.report_date);

        if (dates.length === 0) {
          return jsonResp({ dates: [], report: null });
        }

        const targetDate = reqDate && dates.includes(reqDate) ? reqDate : dates[0];

        // 查询当天公共文章池
        const { results: articleRows } = await env.DB.prepare(
          'SELECT * FROM articles WHERE report_date = ?'
        ).bind(targetDate).all();

        // 查询该用户的全部历史偏好，计算标签与分类权重
        const { results: fbRows } = await env.DB.prepare(
          'SELECT article_id, category, tags, action FROM user_feedback WHERE uid = ?'
        ).bind(uid).all();

        const feedbackMap = {};
        const tagWeights = {};
        const catWeights = {};

        for (const fb of fbRows) {
          feedbackMap[fb.article_id] = fb.action;
          const deltaTag = fb.action === 'like' ? 0.3 : -0.5;
          const deltaCat = fb.action === 'like' ? 0.2 : -0.3;

          if (fb.category) {
            catWeights[fb.category] = (catWeights[fb.category] || 0) + deltaCat;
          }
          try {
            const tags = JSON.parse(fb.tags || '[]');
            for (const t of tags) {
              tagWeights[t] = (tagWeights[t] || 0) + deltaTag;
            }
          } catch {}
        }

        // 结合基础 AI 评分 + 个人偏好权重进行重排
        const articles = articleRows.map((row) => {
          let tags = [];
          try { tags = JSON.parse(row.tags || '[]'); } catch {}

          let boost = catWeights[row.category] || 0;
          for (const t of tags) {
            boost += tagWeights[t] || 0;
          }

          return {
            id: row.id,
            category: row.category,
            title: row.title,
            tldr: row.tldr,
            tags,
            url: row.url,
            sourceName: row.source_name,
            score: Number(row.score || 4.5),
            userFeedback: feedbackMap[row.id] || null,
            _rankScore: Number(row.score || 4.5) + boost,
          };
        });

        articles.sort((a, b) => b._rankScore - a._rankScore);
        const cleanArticles = articles.map(({ _rankScore, ...rest }) => rest);

        return jsonResp({
          dates,
          report: {
            reportDate: targetDate,
            overview: articleRows[0]?.overview || '今日 AI 简报已生成。',
            stats: {
              scannedCount: cleanArticles.length,
              selectedCount: cleanArticles.length,
              durationSeconds: 0,
            },
            articles: cleanArticles,
          },
        });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 3. 定时任务入库接口（写入当日公共文章池）
    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      try {
        const body = await request.json();
        const { reportDate, overview, articles } = body;
        if (!reportDate || !Array.isArray(articles)) {
          return jsonResp({ error: '参数不完整' }, 400);
        }

        // 覆盖当天旧数据
        await env.DB.prepare('DELETE FROM articles WHERE report_date = ?').bind(reportDate).run();

        const stmts = articles.map((art) =>
          env.DB.prepare(
            `INSERT INTO articles (id, report_date, category, title, tldr, tags, url, source_name, score, overview)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            art.id,
            reportDate,
            art.category || '行业动态',
            art.title || '',
            art.tldr || '',
            JSON.stringify(art.tags || []),
            art.url || '',
            art.sourceName || '',
            Number(art.score || 4.5),
            overview || ''
          )
        );
        if (stmts.length > 0) await env.DB.batch(stmts);

        return jsonResp({ ok: true, count: articles.length });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 4. 获取已绑定微信 OpenID 的用户列表（供推送脚本使用）
    if (url.pathname === '/api/users' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      try {
        const { results } = await env.DB.prepare(
          'SELECT uid, nickname, wechat_openid FROM users WHERE wechat_openid IS NOT NULL AND wechat_openid != ""'
        ).all();
        return jsonResp({ users: results });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }
// 纯享阅读中转：支持 Jina API Key，无 Key 或遇 429 时自动直连原文并清洗排版
    if (url.pathname === '/api/read' && request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return new Response('无效的文章链接', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let title = '纯享阅读';
      let articleHtml = '';

      try {
        // 1. 如果在 Cloudflare 环境变量里配置了 JINA_API_KEY，优先走 Jina
        if (env.JINA_API_KEY) {
          const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: {
              'Accept': 'text/plain',
              'X-Return-Format': 'markdown',
              'Authorization': `Bearer ${env.JINA_API_KEY}`
            }
          });
          if (jinaRes.ok) {
            const md = await jinaRes.text();
            articleHtml = '<p>' + escapeHtml(md)
              .replace(/^### (.*$)/gim, '<h3>$1</h3>')
              .replace(/^## (.*$)/gim, '<h2>$1</h2>')
              .replace(/^# (.*$)/gim, '<h1>$1</h1>')
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
              .replace(/\n{2,}/g, '</p><p>')
              .replace(/\n/g, '<br/>') + '</p>';
          }
        }

        // 2. 无 Key 或 Jina 失败时，直接由 Cloudflare 节点抓取原文并清洗 HTML
        if (!articleHtml) {
          const res = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            redirect: 'follow'
          });

          if (!res.ok) throw new Error(`原文抓取失败 (${res.status})`);
          const rawHtml = await res.text();

          const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          if (titleMatch) title = titleMatch[1].replace(/\s+/g, ' ').trim();

          // 优先提取 <article> 或 <main> 区域，没有则取 <body>
          const mainMatch = rawHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
            || rawHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
            || rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

          let body = mainMatch ? mainMatch[1] : rawHtml;

          // 清除脚本、样式、导航、页眉页脚、表单、SVG 等干扰元素
          body = body
            .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(p|div|h[1-6]|li|blockquote|br)[^>]*>/gi, '\n<$1>')
            .replace(/<(?!\/?(p|h[1-6]|strong|b|em|i|ul|ol|li|blockquote|pre|code|br|a)\b)[^>]+>/gi, '')
            .replace(/\s+on\w+="[^"]*"/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          articleHtml = `<h1>${escapeHtml(title)}</h1>` + body;
        }

        const pageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} - 纯享阅读</title>
  <style>
    body { margin: 0; padding: 16px 18px 48px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; line-height: 1.75; color: #1f2937; background: #fafaf9; font-size: 16px; word-break: break-word; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; margin-bottom: 16px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .top-bar a { color: #2563eb; text-decoration: none; font-weight: 500; }
    h1 { font-size: 20px; line-height: 1.4; margin: 12px 0 16px; color: #111827; }
    h2 { font-size: 18px; margin: 20px 0 10px; color: #111827; }
    h3 { font-size: 16px; margin: 16px 0 8px; color: #374151; }
    p { margin: 12px 0; }
    pre, code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 14px; overflow-x: auto; }
    blockquote { margin: 12px 0; padding-left: 12px; border-left: 3px solid #d1d5db; color: #4b5563; }
    a { color: #2563eb; word-break: break-all; }
  </style>
</head>
<body>
  <div class="top-bar">
    <a href="javascript:history.back()">← 返回简报</a>
    <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">查看原文 ↗</a>
  </div>
  <article>${articleHtml}</article>
</body>
</html>`;

        return new Response(pageHtml, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(
          `<html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px;line-height:1.6;"><h3>纯享解析失败</h3><p>${escapeHtml(err.message)}</p><p><a href="${escapeHtml(targetUrl)}">点击直接查看原文 ↗</a></p></body></html>`,
          { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    }

    // 其他请求照常返回前端静态页面
    return env.ASSETS.fetch(request);
  },
};