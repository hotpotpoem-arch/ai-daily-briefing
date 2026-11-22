/* eslint-disable */
function decodeBase64UTF8(base64) {
  const binString = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64UTF8(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  return btoa(binString);
}

function renderHtml(icon, title, desc) {
  return new Response(
    `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>AI 简报偏好反馈</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #FAF9F6; color: #1c1917; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 16px; padding: 32px 24px; max-width: 380px; width: 100%; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
        .icon { font-size: 42px; margin-bottom: 12px; }
        h1 { font-size: 18px; margin: 0 0 8px; }
        p { font-size: 14px; color: #57534e; line-height: 1.6; margin: 0 0 20px; }
        a { display: inline-block; background: #1c1917; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 10px; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">${icon}</div>
        <h1>${title}</h1>
        <p>${desc}</p>
        <a href="https://ai-daily-briefing-543.pages.dev">返回网页版简报</a>
      </div>
    </body>
    </html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 不是 /api/feedback 的请求，直接放行去加载正常的网页静态文件
    if (!url.pathname.startsWith('/api/feedback')) {
      return env.ASSETS.fetch(request);
    }

    const isJson = url.searchParams.get('format') === 'json';
    const respond = (ok, icon, title, desc, status = 200) => {
      if (isJson) {
        return new Response(JSON.stringify({ ok, title, desc }), {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return renderHtml(icon, title, desc);
    };

    const action = url.searchParams.get('action');
    const title = url.searchParams.get('title');
    const category = url.searchParams.get('category') || 'AI';
    const tagsStr = url.searchParams.get('tags') || '';
    const tags = tagsStr ? tagsStr.split(',').filter(Boolean) : [];

    if (!action || !title || !['like', 'dislike'].includes(action)) {
      return respond(false, '⚠️', '参数不完整', '无法识别你的反馈内容，请从简报中重新点击。', 400);
    }

    const token = env.GITHUB_TOKEN;
    const repo = env.GITHUB_REPO || 'hotpotpoem-arch/ai-daily-briefing';
    const filePath = 'backend/preferences.json';

    if (!token) {
      return respond(false, '⚙️', '尚未配置权限', '请在 Cloudflare Pages 后台添加 GITHUB_TOKEN 环境变量。', 500);
    }

    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AI-Daily-Briefing-Feedback',
    };

    try {
      const getRes = await fetch(apiUrl, { headers });
      if (!getRes.ok) throw new Error(`读取偏好文件失败 (${getRes.status})`);
      const fileData = await getRes.json();
      const prefs = JSON.parse(decodeBase64UTF8(fileData.content));

      prefs.liked = Array.isArray(prefs.liked) ? prefs.liked : [];
      prefs.disliked = Array.isArray(prefs.disliked) ? prefs.disliked : [];

      const newItem = { title, category, tags };
      prefs.liked = prefs.liked.filter((i) => i.title !== title);
      prefs.disliked = prefs.disliked.filter((i) => i.title !== title);

      if (action === 'like') {
        prefs.liked.unshift(newItem);
        prefs.liked = prefs.liked.slice(0, 20);
      } else {
        prefs.disliked.unshift(newItem);
        prefs.disliked = prefs.disliked.slice(0, 20);
      }

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `chore: update user preference (${action})`,
          content: encodeBase64UTF8(JSON.stringify(prefs, null, 2)),
          sha: fileData.sha,
        }),
      });

      if (!putRes.ok) throw new Error(`写入偏好文件失败 (${putRes.status})`);

      return action === 'like'
        ? respond(true, '👍', '已记录：感兴趣', `已收藏《${title}》的偏好特征，明天 AI 将优先推荐类似主题。`)
        : respond(true, '👎', '已记录：不感兴趣', `已记录反馈，后续 AI 将降低此类内容的推荐权重。`);
    } catch (err) {
      return respond(false, '❌', '记录失败', `出错了：${err.message}`, 500);
    }
  },
};