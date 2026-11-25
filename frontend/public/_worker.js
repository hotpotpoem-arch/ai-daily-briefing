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


/**
 * 根据用户偏好关键词，实时抓取 Google News RSS 并由 DeepSeek 质检打分与翻译
 */
/**
 * 根据用户偏好关键词，实时抓取 Bing News RSS（自动提取真实原文链接）并由 DeepSeek 质检打分
 */
async function fetchPersonalizedNews(likeKws, prefText, env) {
  const debug = { step: 'init', sources: [], rawCount: 0, llmStatus: null, err: null };
  if (!likeKws || likeKws.length === 0 || !env.LLM_API_KEY) {
    debug.step = 'missing_params';
    return { articles: [], debug };
  }

  // 优先挑出英文关键词（适合科技/全球新闻接口），没有则用第一个词
  const enKw = likeKws.find((k) => /^[a-zA-Z0-9\s\-+.]+$/.test(k)) || likeKws[0];
  const rawItems = [];
  const seenUrls = new Set();

  // 1. 数据源 A：Hacker News Algolia API（近 14 天高相关科技/AI 资讯，极稳）
  try {
    const sinceTs = Math.floor(Date.now() / 1000) - 14 * 86400;
    const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(enKw)}&tags=story&numericFilters=created_at_i>${sinceTs}&hitsPerPage=8`;
    const hnRes = await fetch(hnUrl);
    if (hnRes.ok) {
      const hnData = await hnRes.json();
      const hits = hnData.hits || [];
      debug.sources.push({ name: 'hn', status: hnRes.status, count: hits.length });
      for (const h of hits) {
        const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
        if (h.title && !seenUrls.has(url)) {
          seenUrls.add(url);
          rawItems.push({
            title: h.title,
            snippet: h.story_text ? h.story_text.slice(0, 200) : `Hacker News 热度 ${h.points || 0}`,
            url,
            sourceName: 'Hacker News',
          });
        }
      }
    } else {
      debug.sources.push({ name: 'hn', status: hnRes.status });
    }
  } catch (e) {
    debug.sources.push({ name: 'hn', err: e.message });
  }

  // 2. 数据源 B：GDELT 2.0 全球新闻开放 API（补充主流媒体报道）
  try {
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(enKw)}&mode=artlist&maxrecords=8&format=json&sort=datedesc`;
    const gdRes = await fetch(gdeltUrl);
    if (gdRes.ok) {
      const gdData = await gdRes.json();
      const arts = gdData.articles || [];
      debug.sources.push({ name: 'gdelt', status: gdRes.status, count: arts.length });
      for (const a of arts) {
        if (a.title && a.url && !seenUrls.has(a.url)) {
          seenUrls.add(a.url);
          rawItems.push({
            title: a.title,
            snippet: a.domain || '',
            url: a.url,
            sourceName: a.domain || '全球新闻',
          });
        }
      }
    } else {
      debug.sources.push({ name: 'gdelt', status: gdRes.status });
    }
  } catch (e) {
    debug.sources.push({ name: 'gdelt', err: e.message });
  }

  debug.rawCount = rawItems.length;
  if (rawItems.length === 0) {
    debug.step = 'sources_empty';
    return { articles: [], debug };
  }

  // 3. 交给 DeepSeek 质检、去重并翻译为中文简报
  const baseUrl = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  try {
    const llmRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'deepseek-chat',
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `你是专业的 AI 与科技情报主编。用户偏好为：「${prefText}」。
请从候选新闻（可能为英文）中筛选出与用户偏好高度相关且有信息增量的文章（1~4 篇），并翻译总结为流畅的简体中文。
标准：综合评分 >= 3.8（5分制），过滤纯水文与无关内容。
严格返回 JSON：
{
  "articles": [
    {
      "category": "前沿发布 | 深度解读 | 行业动态",
      "title": "精炼准确的中文标题",
      "tldr": "50-70字中文核心要点",
      "tags": ["标签1", "标签2"],
      "url": "必须原样保留原始链接",
      "sourceName": "原样保留来源",
      "score": 4.2
    }
  ]
}`,
          },
          { role: 'user', content: JSON.stringify(rawItems.slice(0, 12)) },
        ],
      }),
    });

    debug.llmStatus = llmRes.status;
    if (!llmRes.ok) {
      debug.step = 'llm_http_error';
      debug.err = (await llmRes.text()).slice(0, 200);
      return { articles: [], debug };
    }
    const llmData = await llmRes.json();
    const parsed = JSON.parse(llmData.choices?.[0]?.message?.content || '{}');
    const filtered = Array.isArray(parsed.articles)
      ? parsed.articles.filter((a) => Number(a.score) >= 3.8)
      : [];
    debug.step = 'done';
    debug.llmReturned = parsed.articles?.length || 0;
    return { articles: filtered, debug };
  } catch (e) {
    debug.step = 'llm_exception';
    debug.err = e.message;
    return { articles: [], debug };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 导出双偏好汇总（供每日定时任务 pipeline.py 拉取）
    if (url.pathname === '/api/export-prefs' && request.method === 'GET') {
      if (!isAuthorized(request, env)) {
        return jsonResp({ error: 'Unauthorized' }, 401);
      }

      try {
        // 1. 读取手动填写的文本偏好与关键词
        const { results: prefRows } = await env.DB.prepare(
          'SELECT pref_text, like_keywords, dislike_keywords FROM user_prefs'
        ).all();

        const prefTexts = [];
        const likeKws = new Set();
        const dislikeKws = new Set();

        for (const r of prefRows || []) {
          if (r.pref_text) prefTexts.push(r.pref_text.trim());
          try {
            JSON.parse(r.like_keywords || '[]').forEach((k) => likeKws.add(k));
            JSON.parse(r.dislike_keywords || '[]').forEach((k) => dislikeKws.add(k));
          } catch {}
        }

        // 2. 统计点击「感兴趣 / 不感兴趣」累积的标签权重
        const { results: fbRows } = await env.DB.prepare(
          'SELECT category, tags, action FROM user_feedback'
        ).all();

        const tagScores = {};
        for (const r of fbRows || []) {
          const delta = r.action === 'like' || r.action === 'up' ? 1 : -1;
          let tags = [];
          try { tags = JSON.parse(r.tags || '[]'); } catch {}
          for (const t of tags) {
            tagScores[t] = (tagScores[t] || 0) + delta;
          }
        }

        const topLikedTags = Object.entries(tagScores)
          .filter(([, score]) => score > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tag]) => tag);

        const topDislikedTags = Object.entries(tagScores)
          .filter(([, score]) => score < 0)
          .sort((a, b) => a[1] - b[1])
          .slice(0, 10)
          .map(([tag]) => tag);

        return jsonResp({
          prefTexts,
          likeKeywords: Array.from(likeKws),
          dislikeKeywords: Array.from(dislikeKws),
          topLikedTags,
          topDislikedTags,
        });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 0. 读取/保存用户自定义文本偏好（保存时自动用 DeepSeek 提取中英文关键词）
    if (url.pathname === '/api/prefs') {
      const uid = (url.searchParams.get('uid') || 'default').trim();

      if (request.method === 'GET') {
        try {
          const row = await env.DB.prepare(
            'SELECT pref_text, like_keywords, dislike_keywords FROM user_prefs WHERE uid = ?'
          ).bind(uid).first();
          return jsonResp({
            uid,
            prefText: row?.pref_text || '',
            likeKeywords: JSON.parse(row?.like_keywords || '[]'),
            dislikeKeywords: JSON.parse(row?.dislike_keywords || '[]'),
          });
        } catch (err) {
          return jsonResp({ error: err.message }, 500);
        }
      }
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const targetUid = (body.uid || uid || 'default').trim();
          const prefText = (body.prefText || '').trim();

          let likeKeywords = [];
          let dislikeKeywords = [];

          // 调用 DeepSeek 将自然语言偏好解析为中英文匹配词
          if (prefText && env.LLM_API_KEY) {
            const baseUrl = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
            const model = env.LLM_MODEL || 'deepseek-chat';
            try {
              const llmRes = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${env.LLM_API_KEY}`,
                },
                body: JSON.stringify({
                  model,
                  temperature: 0.1,
                  response_format: { type: 'json_object' },
                  messages: [
                    {
                      role: 'system',
                      content: '将用户的阅读偏好描述拆解为中英文关键词数组，方便做文章标题和摘要的文本匹配。严格输出 JSON：{"like": ["词1", "word1"], "dislike": ["词2", "word2"]}。每个词尽量简短精准，同时包含常见中英文写法（如 "英伟达" 和 "Nvidia"）。',
                    },
                    { role: 'user', content: prefText },
                  ],
                }),
              });
              if (llmRes.ok) {
                const data = await llmRes.json();
                const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
                if (Array.isArray(parsed.like)) likeKeywords = parsed.like;
                if (Array.isArray(parsed.dislike)) dislikeKeywords = parsed.dislike;
              }
            } catch {}
          }

          await env.DB.prepare('INSERT OR IGNORE INTO users (uid) VALUES (?)').bind(targetUid).run();
          await env.DB.prepare(
            `INSERT INTO user_prefs (uid, pref_text, like_keywords, dislike_keywords, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(uid) DO UPDATE SET
               pref_text = excluded.pref_text,
               like_keywords = excluded.like_keywords,
               dislike_keywords = excluded.dislike_keywords,
               updated_at = CURRENT_TIMESTAMP`
          ).bind(
            targetUid,
            prefText,
            JSON.stringify(likeKeywords),
            JSON.stringify(dislikeKeywords)
          ).run();

          // 实时全网搜索并质检专属高质量资讯，写入当天简报
          let addedCount = 0;
          let fetchDebug = null;
          if (likeKeywords.length > 0) {
            const latestRow = await env.DB.prepare(
              `SELECT report_date FROM articles ORDER BY report_date DESC LIMIT 1`
            ).first();

            if (latestRow?.report_date) {
              const targetDate = latestRow.report_date;
              const result = await fetchPersonalizedNews(likeKeywords, prefText, env);
              const newArticles = result.articles;
              fetchDebug = result.debug;

              // 先清理该用户当天旧的专属搜索文章，再写入新的
              await env.DB.prepare(
                `DELETE FROM articles WHERE report_date = ? AND target_uid = ?`
              ).bind(targetDate, targetUid).run();

              for (let i = 0; i < newArticles.length; i++) {
                const art = newArticles[i];
                const artId = `pref_${targetUid.slice(0, 6)}_${Date.now()}_${i}`;
                await env.DB.prepare(
                  `INSERT OR REPLACE INTO articles
                   (id, report_date, category, title, tldr, tags, url, source_name, score, target_uid)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  artId,
                  targetDate,
                  art.category || '行业动态',
                  art.title,
                  art.tldr || '',
                  JSON.stringify(art.tags || []),
                  art.url,
                  art.sourceName || '全网实时',
                  Number(art.score) || 4.0,
                  targetUid
                ).run();
                addedCount++;
              }
            }
          }

          return jsonResp({ ok: true, uid: targetUid, prefText, likeKeywords, dislikeKeywords, addedCount, fetchDebug });
        } catch (err) {
          return jsonResp({ error: err.message }, 500);
        }
      }
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

    // 图片中转代理（解决国内直连外网图床裂图/加载慢）
    if (url.pathname === '/api/img' && request.method === 'GET') {
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl || !/^https?:\/\//i.test(imgUrl)) {
        return new Response('Invalid URL', { status: 400 });
      }
      try {
        const res = await fetch(imgUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': '' // 清除 Referer，绕过部分外网防盗链
          },
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(res.body, { status: res.status, headers });
      } catch {
        return new Response('Image load failed', { status: 502 });
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

       // 查询当天公共文章池 + 当前用户的专属搜索文章
          const { results: articleRows } = await env.DB.prepare(
            `SELECT * FROM articles WHERE report_date = ? AND (target_uid IS NULL OR target_uid = 'all' OR target_uid = ?) ORDER BY score DESC`
          ).bind(targetDate, uid).all();

        // 查询该用户的全部历史偏好，计算标签与分类权重
        // 查询该用户的自定义文本偏好
        const prefRow = await env.DB.prepare(
          'SELECT pref_text, like_keywords, dislike_keywords FROM user_prefs WHERE uid = ?'
        ).bind(uid).first();
        const userPrefText = prefRow?.pref_text || '';
        const likeKws = JSON.parse(prefRow?.like_keywords || '[]').map((k) => k.toLowerCase());
        const dislikeKws = JSON.parse(prefRow?.dislike_keywords || '[]').map((k) => k.toLowerCase());
        
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
          // ↓ 插入在第 271 行这里：计算自定义文本偏好的加分/减分
          const searchText = `${row.title || ''} ${row.tldr || ''} ${tags.join(' ')}`.toLowerCase();
          let matchedPref = row.target_uid === uid;
          let matchedDislike = false;
          if (row.target_uid === uid) {
            boost += 2.0;
          }
          for (const kw of likeKws) {
            if (kw && searchText.includes(kw)) {
              boost += 1.2;
              matchedPref = true;
            }
          }
          for (const kw of dislikeKws) {
            if (kw && searchText.includes(kw)) {
              boost -= 1.0;
              matchedDislike = true;
            }
          }

          return {
            id: row.id,
            matchedPref,
            matchedDislike,
            category: row.category,
            title: row.title,
            tldr: row.tldr,
            tags,
            url: row.url,
            sourceName: row.source_name,
            score: Number(row.score || 4.5),
            userFeedback: feedbackMap[row.id] || null,
            contentZh: row.content_zh || '',
            _rankScore: Number(row.score || 4.5) + boost,
          };
        });

        // 只要不是被用户明确屏蔽的普通文章，全部保留展示；专属文章置顶
          const finalArticles = articles
            .filter((a) => !(a.matchedDislike && a.score < 4.7))
            .sort((a, b) => b._rankScore - a._rankScore);

          const cleanArticles = finalArticles.map(({ _rankScore, matchedDislike, ...rest }) => rest);

        return jsonResp({
          dates,
          userPrefText,
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
            `INSERT INTO articles (id, report_date, category, title, tldr, tags, url, source_name, score, overview, content_zh)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            overview || '',
            art.contentZh || ''
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
    // 5. 生成 WxPusher 专属带参订阅二维码（前端弹窗调用）
    if (url.pathname === '/api/wxpusher/qrcode' && request.method === 'GET') {
      const uid = (url.searchParams.get('uid') || 'default').trim();
      if (!env.WXPUSHER_APP_TOKEN) {
        return jsonResp({ error: '未配置 WXPUSHER_APP_TOKEN' }, 500);
      }
      try {
        const res = await fetch('https://wxpusher.zjiecode.com/api/fun/create/qrcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appToken: env.WXPUSHER_APP_TOKEN,
            extra: uid,
            validTime: 1800,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.msg || '生成二维码失败');
        return jsonResp({ ok: true, qrUrl: data.data.url });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 6. 接收 WxPusher 扫码关注回调，自动把用户写入 D1 的 users 表
    if (url.pathname === '/api/wxpusher/callback' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.action === 'app_subscribe' && body.data) {
          const wxUid = body.data.uid;
          const userUid = (body.data.extra || wxUid).trim();

          if (wxUid) {
            await env.DB.prepare(
              `INSERT INTO users (uid, wechat_openid)
               VALUES (?, ?)
               ON CONFLICT(uid) DO UPDATE SET wechat_openid = excluded.wechat_openid`
            ).bind(userUid, wxUid).run();
          }
        }
        return jsonResp({ ok: true });
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

// 1. AI 精准翻译接口（供纯享页异步调用）
    if (url.pathname === '/api/translate' && request.method === 'POST') {
      try {
        if (!env.LLM_API_KEY) {
          return new Response(JSON.stringify({ error: '未配置 LLM_API_KEY 环境变量' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        }

        const { text } = await request.json();
        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: '待翻译内容为空' }), { status: 400 });
        }

        const baseUrl = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
        const model = env.LLM_MODEL || 'deepseek-chat';

        const llmRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.LLM_API_KEY}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: '你是一位精通人工智能、计算机科学与科技新闻的专业中英译者。请将用户提供的文章正文准确、流畅地翻译为简体中文。\n要求：\n1. 严格忠实原文，不遗漏关键数据、实验结论与技术细节，不擅自发挥。\n2. 保留常见专业英文术语（如 LLM、Agent、Transformer、Benchmark、API、Fine-tuning 等）或采用业内通用译法。\n3. 保持原有的段落与小标题结构，使用简洁的 Markdown（如 ## 标题、加粗、列表）输出，不要输出任何开场白或解释。'
              },
              {
                role: 'user',
                content: text.slice(0, 12000)
              }
            ]
          })
        });

        if (!llmRes.ok) {
          const errText = await llmRes.text();
          throw new Error(`模型接口报错 (${llmRes.status}): ${errText.slice(0, 120)}`);
        }

        const data = await llmRes.json();
        const translated = data?.choices?.[0]?.message?.content?.trim();
        if (!translated) throw new Error('模型未返回有效译文');

        return new Response(JSON.stringify({ translated }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // 2. 纯享阅读中转（支持自动 AI 中文翻译 + 中原文切换）
    if (url.pathname === '/api/read' && request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return new Response('无效的文章链接', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let title = '纯享阅读';
      let articleHtml = '';
      // 优先从 D1 读取预翻译好的中文正文（秒开，无需等待）
      try {
        const cached = await env.DB.prepare(
          'SELECT title, content_zh FROM articles WHERE url = ? AND content_zh IS NOT NULL AND content_zh != "" ORDER BY report_date DESC LIMIT 1'
        ).bind(targetUrl).first();

        if (cached && cached.content_zh) {
          const cachedTitle = cached.title || '纯享阅读';
          const renderMdServer = (md) => {
            const inline = (s) => escapeHtml(s)
              .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
              .replace(/`([^`]+)`/g, '<code>$1</code>')
              .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
            const lines = md.split(/\r?\n/);
            let html = '', inUl = false, inOl = false;
            const closeLists = () => {
              if (inUl) { html += '</ul>'; inUl = false; }
              if (inOl) { html += '</ol>'; inOl = false; }
            };
            for (const raw of lines) {
              const line = raw.trim();
              if (!line) { closeLists(); continue; }
              if (/^###\s+/.test(line)) { closeLists(); html += '<h3>' + inline(line.replace(/^###\s+/, '')) + '</h3>'; }
              else if (/^##\s+/.test(line)) { closeLists(); html += '<h2>' + inline(line.replace(/^##\s+/, '')) + '</h2>'; }
              else if (/^#\s+/.test(line)) { closeLists(); html += '<h1>' + inline(line.replace(/^#\s+/, '')) + '</h1>'; }
              else if (/^>\s*/.test(line)) { closeLists(); html += '<blockquote>' + inline(line.replace(/^>\s*/, '')) + '</blockquote>'; }
              else if (/^[-*]\s+/.test(line)) {
                if (inOl) { html += '</ol>'; inOl = false; }
                if (!inUl) { html += '<ul>'; inUl = true; }
                html += '<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>';
              } else if (/^\d+\.\s+/.test(line)) {
                if (inUl) { html += '</ul>'; inUl = false; }
                if (!inOl) { html += '<ol>'; inOl = true; }
                html += '<li>' + inline(line.replace(/^\d+\.\s+/, '')) + '</li>';
              } else { closeLists(); html += '<p>' + inline(line) + '</p>'; }
            }
            closeLists();
            return html;
          };

          const instantHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${escapeHtml(cachedTitle)} - 纯享阅读</title>
  <style>
    html, body { -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important; margin: 0; padding: 0; background: #f5f5f4; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
    .container { max-width: 680px; margin: 0 auto; min-height: 100vh; background: #ffffff; padding: 16px 20px 64px; box-sizing: border-box; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; padding-bottom: 14px; margin-bottom: 16px; border-bottom: 1px solid #f0f0ef; font-size: 14px; }
    .top-bar a { color: #2563eb; text-decoration: none; font-weight: 500; }
    article { font-size: 15px; line-height: 1.85; letter-spacing: 0.02em; word-break: break-word; }
    article h1 { font-size: 20px; line-height: 1.4; font-weight: 700; margin: 8px 0 20px; color: #111827; }
    article h2 { font-size: 16px; line-height: 1.45; font-weight: 600; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #f3f4f6; color: #111827; }
    article h3 { font-size: 15px; font-weight: 600; margin: 22px 0 8px; color: #374151; }
    article p { margin: 0 0 14px; text-align: justify; }
    article ul, article ol { margin: 0 0 16px; padding-left: 22px; }
    article li { margin-bottom: 8px; }
    article blockquote { margin: 16px 0; padding: 10px 14px; background: #f9fafb; border-left: 3px solid #2563eb; color: #4b5563; border-radius: 0 6px 6px 0; }
    article pre, article code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    article a { color: #2563eb; text-decoration: none; border-bottom: 1px solid #bfdbfe; }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-bar">
      <a href="javascript:history.back()">← 返回简报</a>
      
    </div>
    <article>
      <h1>${escapeHtml(cachedTitle)}</h1>
      ${renderMdServer(cached.content_zh)}
    </article>
  </div>
  <script>
    (function() {
      function lockFontSize() {
        WeixinJSBridge.invoke('setFontSizeCallback', { 'fontSize': 0 });
        WeixinJSBridge.on('menu:setfont', function() { WeixinJSBridge.invoke('setFontSizeCallback', { 'fontSize': 0 }); });
      }
      if (typeof WeixinJSBridge === 'object' && typeof WeixinJSBridge.invoke === 'function') lockFontSize();
      else document.addEventListener('WeixinJSBridgeReady', lockFontSize, false);
    })();
  </script>
</body>
</html>`;

          return new Response(instantHtml, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
      } catch (e) {
        console.error('读取 D1 预翻译缓存失败，降级为实时抓取:', e);
      }

      try {
        if (env.JINA_API_KEY) {
          const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: {
          'Accept': 'text/plain',
          'X-Return-Format': 'markdown',
          'Authorization': `Bearer ${env.JINA_API_KEY}`,
          'X-Remove-Selector': "header, nav, footer, aside, [role='navigation'], [role='banner'], [class*='ad-'], [class*='ads'], [class*='login'], [class*='signin'], [class*='signup'], [class*='subscribe'], [class*='newsletter'], [class*='cookie'], [class*='share'], [class*='social'], [class*='related'], [class*='recommend'], [class*='comment'], [class*='paywall'], [id*='ad'], [id*='cookie']",
          'X-Target-Selector': 'article, main, .article-body, .uni-blog-article'
        }
      });
      if (jinaRes.ok) {
        const rawMd = await jinaRes.text();
        const md = rawMd
          .split('\n')
          .filter(line => {
            const trimmed = line.trim();
            if (/^[-*•]\s*\[.*?\]\(https?:\/\/.*?\)$/.test(trimmed)) return false;
            if (/^(Sign in|Log in|Sign up|Subscribe|Accept all cookies|Share this|Related articles)/i.test(trimmed)) return false;
            return true;
          })
          .join('\n');
        articleHtml = '<p>' + escapeHTML(md)
              .replace(/^### (.*$)/gim, '<h3>$1</h3>')
              .replace(/^## (.*$)/gim, '<h2>$1</h2>')
              .replace(/^# (.*$)/gim, '<h1>$1</h1>')
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, src) => `<img src="/api/img?url=${encodeURIComponent(src)}" alt="${alt}" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:12px 0;" />`)
              .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
              .replace(/\n{2,}/g, '</p><p>')
              .replace(/\n/g, '<br/>') + '</p>';
          }
        }

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

          const mainMatch = rawHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
            || rawHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
            || rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

          let body = mainMatch ? mainMatch[1] : rawHtml;

          body = body
            .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(p|div|h[1-6]|li|blockquote|br)[^>]*>/gi, '\n<$1>')
            .replace(/<(?!\/?(p|h[1-6]|strong|b|em|i|ul|ol|li|blockquote|pre|code|br|a|img)\b)[^>]+>/gi, '')
            .replace(/\s+on\w+="[^"]*"/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          articleHtml = `<h1>${escapeHtml(title)}</h1>` + body;
        }

        const pageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${escapeHtml(title)} - 纯享阅读</title>
  <style>
    article img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 16px auto;
    border-radius: 8px;
    }
    html, body {
      -webkit-text-size-adjust: 100% !important;
      text-size-adjust: 100% !important;
      margin: 0;
      padding: 0;
      background: #f5f5f4;
      color: #1c1917;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
      min-height: 100vh;
      background: #ffffff;
      padding: 16px 20px 64px;
      box-sizing: border-box;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 14px;
      margin-bottom: 16px;
      border-bottom: 1px solid #f0f0ef;
      font-size: 14px;
    }
    .top-bar a { color: #2563eb; text-decoration: none; font-weight: 500; }
    .trans-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #f0f7ff;
      color: #1d4ed8;
      padding: 10px 14px;
      border-radius: 10px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .trans-btn {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    article {
      font-size: 12px;
      line-height: 1.8;
      letter-spacing: 0.02em;
      word-break: break-word;
    }
    article h1 {
      font-size: 20px;
      line-height: 1.4;
      font-weight: 700;
      margin: 8px 0 20px;
      color: #111827;
    }
    article h2 {
      font-size: 16px;
      line-height: 1.45;
      font-weight: 600;
      margin: 28px 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid #f3f4f6;
      color: #111827;
    }
    article h3 {
      font-size: 12px;
      font-weight: 600;
      margin: 22px 0 8px;
      color: #374151;
    }
    article p {
      margin: 0 0 14px;
      text-align: justify;
    }
    article ul, article ol {
      margin: 0 0 16px;
      padding-left: 22px;
    }
    article li {
      margin-bottom: 8px;
    }
    article blockquote {
      margin: 16px 0;
      padding: 10px 14px;
      background: #f9fafb;
      border-left: 3px solid #2563eb;
      color: #4b5563;
      border-radius: 0 6px 6px 0;
    }
    article pre, article code {
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    article a { color: #2563eb; text-decoration: none; border-bottom: 1px solid #bfdbfe; }
    article p:empty, article div:empty { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-bar">
      <a href="javascript:history.back()">← 返回简报</a>
      
    </div>
    <div id="trans-bar" class="trans-bar" style="display:none;">
      <span id="trans-status">正在 AI 精准翻译为中文...</span>
      <button id="toggle-btn" class="trans-btn" style="display:none;">切换原文</button>
    </div>
    <article id="orig-content">${articleHtml}</article>
    <article id="zh-content" style="display:none;"></article>
  </div>

  <script>
    // 1. 强制锁定微信内置浏览器字号
    (function() {
      function lockFontSize() {
        WeixinJSBridge.invoke('setFontSizeCallback', { 'fontSize': 0 });
        WeixinJSBridge.on('menu:setfont', function() {
          WeixinJSBridge.invoke('setFontSizeCallback', { 'fontSize': 0 });
        });
      }
      if (typeof WeixinJSBridge === 'object' && typeof WeixinJSBridge.invoke === 'function') {
        lockFontSize();
      } else {
        document.addEventListener('WeixinJSBridgeReady', lockFontSize, false);
      }
    })();

    // 2. 完整 Markdown 渲染 + 自动/手动 AI 翻译
    (function() {
      const origEl = document.getElementById('orig-content');
      const zhEl = document.getElementById('zh-content');
      const bar = document.getElementById('trans-bar');
      const statusEl = document.getElementById('trans-status');
      const toggleBtn = document.getElementById('toggle-btn');

      const plainText = (origEl.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      if (!plainText) return;

      // 始终显示翻译栏，确保随时可手动触发
      bar.style.display = 'flex';

      function renderMarkdown(md) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const inline = (s) => esc(s)
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');

        const lines = md.split(/\\r?\\n/);
        let html = '';
        let inUl = false;
        let inOl = false;

        const closeLists = () => {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
        };

        for (let raw of lines) {
          const line = raw.trim();
          if (!line) { closeLists(); continue; }

          if (/^###\\s+/.test(line)) {
            closeLists();
            html += '<h3>' + inline(line.replace(/^###\\s+/, '')) + '</h3>';
          } else if (/^##\\s+/.test(line)) {
            closeLists();
            html += '<h2>' + inline(line.replace(/^##\\s+/, '')) + '</h2>';
          } else if (/^#\\s+/.test(line)) {
            closeLists();
            html += '<h1>' + inline(line.replace(/^#\\s+/, '')) + '</h1>';
          } else if (/^>\\s*/.test(line)) {
            closeLists();
            html += '<blockquote>' + inline(line.replace(/^>\\s*/, '')) + '</blockquote>';
          } else if (/^[-*]\\s+/.test(line)) {
            if (inOl) { html += '</ol>'; inOl = false; }
            if (!inUl) { html += '<ul>'; inUl = true; }
            html += '<li>' + inline(line.replace(/^[-*]\\s+/, '')) + '</li>';
          } else if (/^\\d+\\.\\s+/.test(line)) {
            if (inUl) { html += '</ul>'; inUl = false; }
            if (!inOl) { html += '<ol>'; inOl = true; }
            html += '<li>' + inline(line.replace(/^\\d+\\.\\s+/, '')) + '</li>';
          } else {
            closeLists();
            html += '<p>' + inline(line) + '</p>';
          }
        }
        closeLists();
        return html;
      }

      let isTranslated = false;
      let showingZh = false;

      async function runTranslate() {
        statusEl.textContent = '正在 AI 精准翻译为中文...';
        toggleBtn.style.display = 'none';
        try {
          const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: plainText })
          });
          const data = await res.json();
          if (!res.ok || !data.translated) throw new Error(data.error || '翻译失败');

          zhEl.innerHTML = renderMarkdown(data.translated);
          origEl.style.display = 'none';
          zhEl.style.display = 'block';
          isTranslated = true;
          showingZh = true;
          statusEl.textContent = '已由 AI 精准翻译为中文';
          toggleBtn.textContent = '切换原文';
          toggleBtn.style.display = 'inline-block';
        } catch (e) {
          statusEl.textContent = '翻译失败：' + e.message;
          toggleBtn.textContent = '重试翻译';
          toggleBtn.style.display = 'inline-block';
        }
      }

      toggleBtn.onclick = () => {
        if (!isTranslated) {
          runTranslate();
          return;
        }
        showingZh = !showingZh;
        zhEl.style.display = showingZh ? 'block' : 'none';
        origEl.style.display = showingZh ? 'none' : 'block';
        toggleBtn.textContent = showingZh ? '切换原文' : '查看译文';
      };

      // 更准确的英文判定：统计英文字母数 vs 中文字符数
      const cnChars = (plainText.match(/[\\u4e00-\\u9fa5]/g) || []).length;
      const enChars = (plainText.match(/[a-zA-Z]/g) || []).length;

      // 只要英文字母明显多于中文（英文内容为主），就自动翻译
      if (enChars > cnChars * 2) {
        runTranslate();
      } else {
        statusEl.textContent = '当前为原文视图';
        toggleBtn.textContent = 'AI 翻译中文';
        toggleBtn.style.display = 'inline-block';
      }
    })();
  </script>
</body>
</html>`;

        return new Response(pageHtml, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return new Response(
          `<html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px;line-height:1.6;"><h3>纯享解析失败</h3><p>${escapeHtml(err.message)}</p><p></p></body></html>`,
          { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    }

    // 其他请求照常返回前端静态页面
    return env.ASSETS.fetch(request);
  },
};