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

    // 其他请求照常返回前端静态页面
    return env.ASSETS.fetch(request);
  },
};