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

function escapeHtmlBasic(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 常见硬付费墙与强反爬域名（纯享模式无法提取正文，抓取时直接过滤）
const BLOCKED_DOMAINS = [
  'ft.com', 'wsj.com', 'bloomberg.com', 'nytimes.com', 'economist.com',
  'theinformation.com', 'barrons.com', 'seekingalpha.com', 'techpowerup.com',
  'reuters.com', 'washingtonpost.com', 'newyorker.com', 'wired.com', 'medium.com'
];

function isBlockedUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return true;
  }
}

function isBlockedContent(text) {
  if (!text || text.trim().length < 180) return true;
  const sample = text.slice(0, 1500).toLowerCase();
  const patterns = [
    /automated bot check|verify you are human|are you a robot|drag the handle|captcha|access denied/i,
    /subscribe to unlock|try unlimited access|subscribe to read|paywall|already a subscriber/i,
    /please enable javascript|enable cookies|checking your browser|just a moment\.\.\./i,
    /自动机器人检查|人机验证|订阅以解锁|订阅后阅读|请开启\s*javascript/i,
  ];
  return patterns.some((re) => re.test(sample));
}

// 按段落换行符安全截断长文，避免切在半句话中间
function safeSlice(text, maxLen = 24000) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.lastIndexOf('\n', maxLen);
  return text.slice(0, cut > maxLen * 0.5 ? cut : maxLen);
}

// 将直连 HTML 中的音视频标签提取为可保留的媒体标记行
function extractMediaMarkersFromHtml(html) {
  if (!html) return '';
  const markers = [];
  const seen = new Set();

  const pushMarker = (line) => {
    if (!line || seen.has(line)) return;
    seen.add(line);
    markers.push(line);
  };

  // 提取 <video> / <source src="...mp4...">
  const videoMatches = html.match(/<video[\s\S]*?<\/video>/gi) || [];
  for (const vBlock of videoMatches) {
    const srcMatch = vBlock.match(/(?:src|data-src)=["'](https?:\/\/[^"']+)["']/i)
      || vBlock.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (srcMatch?.[1]) {
      pushMarker(`[视频](${srcMatch[1]})`);
    }
  }

  // 提取 <audio> / <source src="...mp3...">
  const audioMatches = html.match(/<audio[\s\S]*?<\/audio>/gi) || [];
  for (const aBlock of audioMatches) {
    const srcMatch = aBlock.match(/(?:src|data-src)=["'](https?:\/\/[^"']+)["']/i)
      || aBlock.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (srcMatch?.[1]) {
      pushMarker(`[音频](${srcMatch[1]})`);
    }
  }

  // 提取页面中明确的音视频/YouTube 链接
  const urlMatches = html.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  for (const u of urlMatches) {
    if (/\.(?:mp4|webm|mov|m3u8)(?:\?[^\s"'<>)]*)?$/i.test(u)) {
      pushMarker(`[视频](${u})`);
    } else if (/\.(?:mp3|wav|ogg|m4a|aac)(?:\?[^\s"'<>)]*)?$/i.test(u)) {
      pushMarker(`[音频](${u})`);
    } else if (/(?:youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{6,}/i.test(u)) {
      pushMarker(u);
    }
  }

  return markers.length > 0 ? '\n\n' + markers.join('\n\n') : '';
}

// 渲染支持标题、段落、列表、引用、图片、音频、视频的富文本 HTML
function renderRichMarkdown(md, escapeHtmlFn) {
  const esc = escapeHtmlFn || escapeHtmlBasic;

  const inline = (s) => {
    let out = esc(s);

    // 1. 图片 -> 走 /api/img 代理
    out = out.replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, alt, src) =>
        `<figure class="media-block"><img src="/api/img?url=${encodeURIComponent(src)}" alt="${esc(alt)}" loading="lazy" /><figcaption>${esc(alt || '配图')}</figcaption></figure>`
    );

    // 2. 行内视频直链 -> HTML5 video 播放器
    out = out.replace(
      /\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:mp4|webm|mov|m3u8)(?:\?[^\s)]*)?)\)/gi,
      (_, label, vUrl) =>
        `<figure class="media-block"><video controls preload="metadata" playsinline src="${esc(vUrl)}"></video><figcaption>${esc(label || '视频播放')}</figcaption></figure>`
    );

    // 3. 行内音频直链 -> HTML5 audio 播放器
    out = out.replace(
      /\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:mp3|wav|ogg|m4a|aac)(?:\?[^\s)]*)?)\)/gi,
      (_, label, aUrl) =>
        `<figure class="media-block"><audio controls preload="metadata" src="${esc(aUrl)}"></audio><figcaption>${esc(label || '音频播放')}</figcaption></figure>`
    );

    // 4. 普通超链接
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );

    // 5. 加粗与行内代码
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    return out;
  };

  const lines = String(md || '').split(/\r?\n/);
  let html = '';
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeLists(); continue; }

    // 独立成行的 YouTube 链接 -> 嵌入式播放器卡片
    const ytMatch = line.match(/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (ytMatch) {
      closeLists();
      const vid = ytMatch[1];
      html += `<figure class="media-block"><div class="video-frame"><iframe src="https://www.youtube.com/embed/${esc(vid)}" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div><figcaption><a href="https://www.youtube.com/watch?v=${esc(vid)}" target="_blank" rel="noopener">在 YouTube 中打开视频 ↗</a></figcaption></figure>`;
      continue;
    }

    // 独立成行的视频直链 -> HTML5 video
    if (/^https?:\/\/\S+\.(?:mp4|webm|mov|m3u8)(?:\?\S*)?$/i.test(line)) {
      closeLists();
      html += `<figure class="media-block"><video controls preload="metadata" playsinline src="${esc(line)}"></video><figcaption>视频播放</figcaption></figure>`;
      continue;
    }

    // 独立成行的音频直链 -> HTML5 audio
    if (/^https?:\/\/\S+\.(?:mp3|wav|ogg|m4a|aac)(?:\?\S*)?$/i.test(line)) {
      closeLists();
      html += `<figure class="media-block"><audio controls preload="metadata" src="${esc(line)}"></audio><figcaption>音频播放</figcaption></figure>`;
      continue;
    }

    if (/^###\s+/.test(line)) {
      closeLists();
      html += '<h3>' + inline(line.replace(/^###\s+/, '')) + '</h3>';
    } else if (/^##\s+/.test(line)) {
      closeLists();
      html += '<h2>' + inline(line.replace(/^##\s+/, '')) + '</h2>';
    } else if (/^#\s+/.test(line)) {
      closeLists();
      html += '<h1>' + inline(line.replace(/^#\s+/, '')) + '</h1>';
    } else if (/^>\s*/.test(line)) {
      closeLists();
      html += '<blockquote>' + inline(line.replace(/^>\s*/, '')) + '</blockquote>';
    } else if (/^[-*]\s+/.test(line)) {
      if (inOl) { html += '</ol>'; inOl = false; }
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += '<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>';
    } else if (/^\d+\.\s+/.test(line)) {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += '<li>' + inline(line.replace(/^\d+\.\s+/, '')) + '</li>';
    } else {
      closeLists();
      html += '<p>' + inline(line) + '</p>';
    }
  }

  closeLists();
  return html;
}

// 分段调用 DeepSeek 翻译长文，防止单次输出被截断
async function translateLongMarkdown(fullText, systemPrompt, env) {
  const baseUrl = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = env.LLM_MODEL || 'deepseek-chat';
  const apiKey = env.LLM_API_KEY;
  if (!apiKey || !fullText.trim()) return '';

  const capped = fullText.slice(0, 45000);
  const chunks = [];
  let start = 0;
  while (start < capped.length) {
    let end = Math.min(start + 6500, capped.length);
    if (end < capped.length) {
      const pBreak = capped.lastIndexOf('\n\n', end);
      const lBreak = capped.lastIndexOf('\n', end);
      const splitAt = pBreak > start + 2000 ? pBreak : (lBreak > start + 2000 ? lBreak : end);
      end = splitAt;
    }
    const piece = capped.slice(start, end).trim();
    if (piece) chunks.push(piece);
    start = end;
  }

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const purityRule =
  '\n5. 除 LLM、Agent、Transformer、Benchmark、API、Fine-tuning 等常见专业术语及专有名词外，普通英文单词（如 pursuing、researchers、workflows 等）必须全部译为中文，禁止中英混杂在半句话里；结尾如遇省略号或未完结句，按原文完整保留并自然收尾，不要自行添加多余的省略号。';

const llmRes = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    temperature: 0.2,
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt + purityRule + partHint },
      { role: 'user', content: chunks[i] },
    ],
  }),
  signal: AbortSignal.timeout(45000),
});
    if (!llmRes.ok) {
      const errText = await llmRes.text();
      throw new Error(`模型接口报错 (${llmRes.status}): ${errText.slice(0, 120)}`);
    }
    const data = await llmRes.json();
    const pieceOut = data?.choices?.[0]?.message?.content?.trim();
    if (pieceOut) results.push(pieceOut);
  }

  return results
  .join('\n\n')
  .trim()
  .replace(/\bpursuing\b/gi, '追求');
}

/**
 * 根据用户偏好关键词，实时抓取 Hacker News & GDELT 资讯并由 DeepSeek 质检打分与翻译
 */
async function fetchPersonalizedNews(likeKws, prefText, env) {
  const debug = { step: 'init', sources: [], rawCount: 0, llmStatus: null, err: null };
  if (!likeKws || likeKws.length === 0 || !env.LLM_API_KEY) {
    debug.step = 'missing_params';
    return { articles: [], debug };
  }

  const enKw = likeKws.find((k) => /^[a-zA-Z0-9\s\-+.]+$/.test(k)) || likeKws[0];
  const rawItems = [];
  const seenUrls = new Set();

  // 1. 数据源 A：Hacker News Algolia API
  try {
    const sinceTs = Math.floor(Date.now() / 1000) - 14 * 86400;
    const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(enKw)}&tags=story&numericFilters=created_at_i>${sinceTs}&hitsPerPage=8`;
    const hnRes = await fetch(hnUrl, { signal: AbortSignal.timeout(8000) });
    if (hnRes.ok) {
      const hnData = await hnRes.json();
      const hits = hnData.hits || [];
      debug.sources.push({ name: 'hn', status: hnRes.status, count: hits.length });
      for (const h of hits) {
        const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
        if (h.title && !seenUrls.has(url) && !isBlockedUrl(url)) {
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

  // 2. 数据源 B：GDELT 2.0 全球新闻开放 API
  try {
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(enKw)}&mode=artlist&maxrecords=8&format=json&sort=datedesc`;
    const gdRes = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (gdRes.ok) {
      const gdData = await gdRes.json();
      const arts = gdData.articles || [];
      debug.sources.push({ name: 'gdelt', status: gdRes.status, count: arts.length });
      for (const a of arts) {
        if (a.title && a.url && !seenUrls.has(a.url) && !isBlockedUrl(a.url)) {
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
      ? parsed.articles.filter((a) => Number(a.score) >= 3.8 && !isBlockedUrl(a.url))
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

/**
 * 后台抓取单篇专属文章正文，调用 DeepSeek 预翻译并写入 D1 的 content_zh 缓存
 */
async function pretranslateSingleArticle(artId, targetUrl, env) {
  if (!artId || !targetUrl || isBlockedUrl(targetUrl)) return;
  let rawText = '';
  let rawHtmlForMedia = '';

  // 1. 优先通过 Jina Reader 提取纯净 Markdown 正文（10 秒超时）
  try {
    const headers = {
      'Accept': 'text/plain',
      'X-Return-Format': 'markdown',
      'X-Remove-Selector': "header, nav, footer, aside, [role='navigation'], [role='banner']",
      'X-Target-Selector': 'article, main, .article-body',
    };
    if (env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
    }
    const r = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const txt = (await r.text()).trim();
      if (!isBlockedContent(txt)) rawText = txt;
    }
  } catch {}

  // 2. 兜底：直接抓取原文并保留音视频标记
  if (!rawText) {
    try {
      const r = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        rawHtmlForMedia = (await r.text()).slice(0, 250000);
        const mediaExtra = extractMediaMarkersFromHtml(rawHtmlForMedia);
        const htmlCleaned = rawHtmlForMedia
          .replace(/<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
        rawText = (htmlCleaned.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + mediaExtra).trim();
      }
    } catch {}
  }

  if (isBlockedContent(rawText)) return;

  const cnChars = (rawText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const enChars = (rawText.match(/[a-zA-Z]/g) || []).length;
  let contentZh = '';

  if (enChars <= cnChars * 2) {
    contentZh = safeSlice(rawText, 24000);
  } else if (env.LLM_API_KEY) {
    contentZh = await translateLongMarkdown(
      rawText,
      '你是一位精通人工智能与科技新闻的专业中英译者。请将文章正文准确、流畅地翻译为简体中文 Markdown，严格保留原文数据、结论、小标题结构、正文配图 ![说明](URL) 以及视频、音频链接；彻底删除导航栏、登录注册、广告、Cookie 声明、评论区及延伸阅读链接，不要输出开场白或重复主标题。',
      env
    );
  }

  if (contentZh && !isBlockedContent(contentZh)) {
    try {
      await env.DB.prepare('UPDATE articles SET content_zh = ? WHERE id = ?')
        .bind(contentZh, artId)
        .run();
    } catch {}
  }
}

export default {
  async fetch(request, env, ctx) {
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

    // 0. 读取/保存用户自定义文本偏好
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
                      content: '将用户的阅读偏好拆解为精准的中英文匹配关键词数组，严格输出 JSON：{"like": ["词1", "word1"], "dislike": ["词2", "word2"]}。要求：1. 只保留用户明确提到的实体、品牌、细分技术及直接同义词（如 "英伟达" 只提取 ["英伟达", "Nvidia", "黄仁勋", "CUDA"]）；2. 严禁发散出 "AI"、"人工智能"、"科技"、"大模型"、"深度学习" 这类过于宽泛的行业通用词，除非用户明确指定。',
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

              await env.DB.prepare(
                `DELETE FROM articles WHERE report_date = ? AND target_uid = ?`
              ).bind(targetDate, targetUid).run();

              const insertedTasks = [];
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
                insertedTasks.push({ id: artId, url: art.url });
                addedCount++;
              }

              if (insertedTasks.length > 0 && ctx?.waitUntil) {
                ctx.waitUntil(
                  (async () => {
                    for (const t of insertedTasks) {
                      try {
                        await pretranslateSingleArticle(t.id, t.url, env);
                      } catch {}
                    }
                  })()
                );
              }
            }
          }

          return jsonResp({ ok: true, uid: targetUid, prefText, likeKeywords, dislikeKeywords, addedCount, fetchDebug });
        } catch (err) {
          return jsonResp({ error: err.message }, 500);
        }
      }
    }

    // 1. 记录/取消用户偏好反馈
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      try {
        const body = await request.json();
        const uid = (body.uid || 'default').trim();
        const articleId = body.articleId;
        const action = body.action;

        if (!articleId) return jsonResp({ error: '缺少 articleId' }, 400);

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

    // 图片中转代理
    if (url.pathname === '/api/img' && request.method === 'GET') {
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl || !/^https?:\/\//i.test(imgUrl)) {
        return new Response('Invalid URL', { status: 400 });
      }
      try {
        const res = await fetch(imgUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': '',
          },
          cf: { cacheTtl: 86400, cacheEverything: true },
          signal: AbortSignal.timeout(8000),
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

        const { results: dateRows } = await env.DB.prepare(
          'SELECT DISTINCT report_date FROM articles ORDER BY report_date DESC LIMIT 30'
        ).all();
        const dates = dateRows.map((r) => r.report_date);

        if (dates.length === 0) {
          return jsonResp({ dates: [], report: null });
        }

        const targetDate = reqDate && dates.includes(reqDate) ? reqDate : dates[0];

        const { results: articleRows } = await env.DB.prepare(
          `SELECT * FROM articles WHERE report_date = ? AND (target_uid IS NULL OR target_uid = 'all' OR target_uid = ?) ORDER BY score DESC`
        ).bind(targetDate, uid).all();

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

        const articles = articleRows.map((row) => {
          let tags = [];
          try { tags = JSON.parse(row.tags || '[]'); } catch {}

          let boost = catWeights[row.category] || 0;
          for (const t of tags) {
            boost += tagWeights[t] || 0;
          }

          const searchText = `${row.title || ''} ${row.tldr || ''} ${tags.join(' ')}`.toLowerCase();
          let matchedPref = row.target_uid === uid;
          let matchedDislike = false;
          if (row.target_uid === uid) {
            boost += 2.0;
          }

          const matchKw = (text, kw) => {
            if (!kw) return false;
            if (/^[a-z0-9]+$/i.test(kw) && kw.length <= 4) {
              return new RegExp(`\\b${kw}\\b`, 'i').test(text);
            }
            return text.includes(kw);
          };

          for (const kw of likeKws) {
            if (matchKw(searchText, kw)) {
              boost += 1.2;
              matchedPref = true;
            }
          }
          for (const kw of dislikeKws) {
            if (matchKw(searchText, kw)) {
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

    // 3. 定时任务入库接口
    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      try {
        const body = await request.json();
        const { reportDate, overview, articles } = body;
        if (!reportDate || !Array.isArray(articles)) {
          return jsonResp({ error: '参数不完整' }, 400);
        }

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

    // 4. 获取已绑定微信 OpenID 的用户列表
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

    // 5. 生成 WxPusher 专属带参订阅二维码
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

    // 6. 接收 WxPusher 扫码关注回调
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

    // 7. AI 精准翻译接口（分段翻译 + 保留音视频/图片链接 + 回写更优 D1 缓存）
    if (url.pathname === '/api/translate' && request.method === 'POST') {
      try {
        if (!env.LLM_API_KEY) {
          return new Response(JSON.stringify({ error: '未配置 LLM_API_KEY 环境变量' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        const { text, url: articleUrl } = await request.json();
        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: '待翻译内容为空' }), { status: 400 });
        }

        const translated = await translateLongMarkdown(
          text,
          '你是一位精通人工智能、计算机科学与科技新闻的专业中英译者。请将用户提供的文章正文准确、流畅地翻译为简体中文。\n要求：\n1. 严格忠实原文，不遗漏关键数据、实验结论与技术细节，不擅自发挥。\n2. 保留常见专业英文术语（如 LLM、Agent、Transformer、Benchmark、API、Fine-tuning 等）或采用业内通用译法。\n3. 保持原有的段落与小标题结构，使用简洁的 Markdown（如 ## 标题、加粗、列表）输出，不要输出任何开场白或解释。\n4. 完整保留原文中的图片 ![说明](URL) 以及视频、音频链接，不要删除或改写媒体链接。',
          env
        );
        if (!translated) throw new Error('模型未返回有效译文');

        if (articleUrl && !isBlockedContent(translated)) {
          const savePromise = env.DB.prepare(
            'UPDATE articles SET content_zh = ? WHERE url = ? AND (content_zh IS NULL OR content_zh = "" OR LENGTH(content_zh) < LENGTH(?))'
          ).bind(translated, articleUrl, translated).run().catch(() => {});
          if (ctx?.waitUntil) ctx.waitUntil(savePromise);
        }

        return new Response(JSON.stringify({ translated }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    }

    // 8. 纯享阅读中转（支持图片、音频、视频渲染 + D1 预翻译缓存秒开 + 实时抓取兜底）
    if (url.pathname === '/api/read' && request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return new Response('无效的文章链接', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      const escapeHtml = escapeHtmlBasic;
      let title = '纯享阅读';
      let articleHtml = '';

      // 优先从 D1 读取有效的预翻译中文正文
      try {
        const cached = await env.DB.prepare(
          'SELECT title, content_zh FROM articles WHERE url = ? AND content_zh IS NOT NULL AND content_zh != "" ORDER BY report_date DESC LIMIT 1'
        ).bind(targetUrl).first();

        if (cached && cached.content_zh && !isBlockedContent(cached.content_zh)) {
          const cachedTitle = cached.title || '纯享阅读';
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
    .media-block { margin: 18px 0; text-align: center; }
    .media-block img, .media-block video { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 0 auto; }
    .media-block audio { width: 100%; max-width: 520px; }
    .video-frame { position: relative; width: 100%; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; background: #000; }
    .video-frame iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
    .media-block figcaption { margin-top: 6px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-bar">
      <a href="javascript:history.back()">← 返回简报</a>
      <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">查看原文 ↗</a>
    </div>
    <article>
      <h1>${escapeHtml(cachedTitle)}</h1>
      ${renderRichMarkdown(cached.content_zh, escapeHtml)}
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
              'Cache-Control': 'public, max-age=3600',
            },
          });
        }
      } catch (e) {
        console.error('读取 D1 预翻译缓存失败，降级为实时抓取:', e);
      }

      try {
        // 1. 优先尝试通过 Jina Reader 提取正文（保留音视频链接）
        try {
          const jinaHeaders = {
            'Accept': 'text/plain',
            'X-Return-Format': 'markdown',
            'X-Remove-Selector': "header, nav, footer, aside, [role='navigation'], [role='banner'], [class*='ad-'], [class*='ads'], [class*='login'], [class*='signin'], [class*='signup'], [class*='subscribe'], [class*='newsletter'], [class*='cookie'], [class*='share'], [class*='social'], [class*='related'], [class*='recommend'], [class*='comment'], [class*='paywall'], [id*='ad'], [id*='cookie']",
            'X-Target-Selector': 'article, main, .article-body, .uni-blog-article',
          };
          if (env.JINA_API_KEY) {
            jinaHeaders['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
          }
          const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: jinaHeaders,
            signal: AbortSignal.timeout(10000),
          });
          if (jinaRes.ok) {
            const rawMd = await jinaRes.text();
            if (!isBlockedContent(rawMd)) {
              const md = rawMd
                .split('\n')
                .filter((line) => {
                  const trimmed = line.trim();
                  if (/\.(?:mp4|webm|mov|m3u8|mp3|wav|ogg|m4a|aac)(?:\?|$)/i.test(trimmed) || /(?:youtube\.com\/watch|youtu\.be\/)/i.test(trimmed)) {
                    return true;
                  }
                  if (/^[-*•]\s*\[.*?\]\(https?:\/\/.*?\)$/.test(trimmed)) return false;
                  if (/^(Sign in|Log in|Sign up|Subscribe|Accept all cookies|Share this|Related articles)/i.test(trimmed)) return false;
                  return true;
                })
                .join('\n');
              articleHtml = renderRichMarkdown(md, escapeHtml);
            }
          }
        } catch {}

        // 2. 兜底：直连抓取原文并保留音视频与图片
        if (!articleHtml) {
          const res = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) throw new Error(`原文抓取失败 (${res.status})`);
          const rawHtml = (await res.text()).slice(0, 250000);

          const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          if (titleMatch) title = titleMatch[1].replace(/\s+/g, ' ').trim();

          const mediaExtra = extractMediaMarkersFromHtml(rawHtml);
          const mainMatch = rawHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
            || rawHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
            || rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

          let body = mainMatch ? mainMatch[1] : rawHtml;

          body = body
            .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(p|div|h[1-6]|li|blockquote|br)[^>]*>/gi, '\n<$1>')
            .replace(/<(?!\/?(p|h[1-6]|strong|b|em|i|ul|ol|li|blockquote|pre|code|br|a|img|video|audio|source)\b)[^>]+>/gi, '')
            .replace(/\s+on\w+="[^"]*"/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          articleHtml = `<h1>${escapeHtml(title)}</h1>` + body + (mediaExtra ? renderRichMarkdown(mediaExtra, escapeHtml) : '');
        }

        // 3. 若命中反爬/付费墙，直接提示前往原网页阅读
        const plainCheck = articleHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (isBlockedContent(plainCheck)) {
          return new Response(
            `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需访问原文 - 纯享阅读</title></head><body style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:20px;line-height:1.7;color:#1f2937;"><a href="javascript:history.back()" style="color:#2563eb;text-decoration:none;">← 返回简报</a><div style="margin-top:24px;padding:20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;"><h3 style="margin:0 0 8px;">该网站开启了付费墙或人机验证</h3><p style="margin:0 0 16px;font-size:14px;color:#6b7280;">纯享模式无法自动提取正文内容，建议直接前往原网页阅读。</p><a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">前往原网页阅读 ↗</a></div></body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }

        const pageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${escapeHtml(title)} - 纯享阅读</title>
  <style>
    article img, article video {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 16px auto;
      border-radius: 8px;
    }
    article audio {
      width: 100%;
      max-width: 520px;
      margin: 12px 0;
    }
    .media-block { margin: 18px 0; text-align: center; }
    .media-block img, .media-block video { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 0 auto; }
    .media-block audio { width: 100%; max-width: 520px; }
    .video-frame { position: relative; width: 100%; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; background: #000; }
    .video-frame iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
    .media-block figcaption { margin-top: 6px; font-size: 12px; color: #6b7280; }
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
      font-size: 15px;
      line-height: 1.85;
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
      font-size: 15px;
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
      <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">查看原文 ↗</a>
    </div>
    <div id="trans-bar" class="trans-bar" style="display:none;">
      <span id="trans-status">正在 AI 精准翻译为中文...</span>
      <button id="toggle-btn" class="trans-btn" style="display:none;">切换原文</button>
    </div>
    <article id="orig-content">${articleHtml}</article>
    <article id="zh-content" style="display:none;"></article>
  </div>

  <script>
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

    (function() {
      const origEl = document.getElementById('orig-content');
      const zhEl = document.getElementById('zh-content');
      const bar = document.getElementById('trans-bar');
      const statusEl = document.getElementById('trans-status');
      const toggleBtn = document.getElementById('toggle-btn');

      const plainText = (origEl.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      if (!plainText) return;

      bar.style.display = 'flex';

      function renderMarkdown(md) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const inline = (s) => {
          let out = esc(s);
          out = out.replace(
            /!\\[([^\\]]*)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,
            (_, alt, src) => '<figure class="media-block"><img src="/api/img?url=' + encodeURIComponent(src) + '" alt="' + esc(alt) + '" loading="lazy" /><figcaption>' + esc(alt || '配图') + '</figcaption></figure>'
          );
          out = out.replace(
            /\\[([^\\]]*)\\]\\((https?:\\/\\/[^\\s)]+\\.(?:mp4|webm|mov|m3u8)(?:\\?[^\\s)]*)?)\\)/gi,
            (_, label, vUrl) => '<figure class="media-block"><video controls preload="metadata" playsinline src="' + esc(vUrl) + '"></video><figcaption>' + esc(label || '视频播放') + '</figcaption></figure>'
          );
          out = out.replace(
            /\\[([^\\]]*)\\]\\((https?:\\/\\/[^\\s)]+\\.(?:mp3|wav|ogg|m4a|aac)(?:\\?[^\\s)]*)?)\\)/gi,
            (_, label, aUrl) => '<figure class="media-block"><audio controls preload="metadata" src="' + esc(aUrl) + '"></audio><figcaption>' + esc(label || '音频播放') + '</figcaption></figure>'
          );
          out = out.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
          out = out.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
          out = out.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
          return out;
        };

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

          const ytMatch = line.match(/^(?:https?:\\/\\/)?(?:www\\.)?(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/)([A-Za-z0-9_-]{6,})/);
          if (ytMatch) {
            closeLists();
            const vid = ytMatch[1];
            html += '<figure class="media-block"><div class="video-frame"><iframe src="https://www.youtube.com/embed/' + esc(vid) + '" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div><figcaption><a href="https://www.youtube.com/watch?v=' + esc(vid) + '" target="_blank" rel="noopener">在 YouTube 中打开视频 ↗</a></figcaption></figure>';
            continue;
          }

          if (/^https?:\\/\\/\\S+\\.(?:mp4|webm|mov|m3u8)(?:\\?\\S*)?$/i.test(line)) {
            closeLists();
            html += '<figure class="media-block"><video controls preload="metadata" playsinline src="' + esc(line) + '"></video><figcaption>视频播放</figcaption></figure>';
            continue;
          }

          if (/^https?:\\/\\/\\S+\\.(?:mp3|wav|ogg|m4a|aac)(?:\\?\\S*)?$/i.test(line)) {
            closeLists();
            html += '<figure class="media-block"><audio controls preload="metadata" src="' + esc(line) + '"></audio><figcaption>音频播放</figcaption></figure>';
            continue;
          }

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
            body: JSON.stringify({ text: plainText, url: ${JSON.stringify(targetUrl)} })
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

      const cnChars = (plainText.match(/[\\u4e00-\\u9fa5]/g) || []).length;
      const enChars = (plainText.match(/[a-zA-Z]/g) || []).length;

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
            'Cache-Control': 'no-cache',
          },
        });
      } catch (err) {
        return new Response(
          `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>纯享模式暂不支持该网页</title></head><body style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:20px;line-height:1.7;color:#1f2937;"><a href="javascript:history.back()" style="color:#2563eb;text-decoration:none;">← 返回简报</a><div style="margin-top:24px;padding:20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;"><h3 style="margin:0 0 8px;">纯享模式暂不支持该网页</h3><p style="margin:0 0 16px;font-size:14px;color:#6b7280;">原因：${escapeHtml(err.message)}。建议直接前往原网页阅读。</p><a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">前往原网页阅读 ↗</a></div></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    }

    // 其他请求照常返回前端静态页面
    return env.ASSETS.fetch(request);
  },
};