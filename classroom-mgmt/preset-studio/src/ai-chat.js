'use strict';
// =============================================================================
// Preset Studio · AI 模型接入（OpenAI 兼容 /chat/completions）
// 双端共用一份逻辑：渲染层经 <script> 拿 window.AiChat，主进程/测试 require。
// 职责：URL 规范化、请求构造、模型回复 JSON 提取、课时包条目规范化、HTTP 发送。
// =============================================================================
(function (root) {
  // 规范化接口地址：补协议、去尾斜杠、去掉误填的 /chat/completions 后缀
  function normalizeBaseUrl(baseUrl) {
    let u = String(baseUrl == null ? '' : baseUrl).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/chat\/completions$/i, '');
    return u;
  }

  // 构造 chat/completions 请求（纯函数，便于单测）
  function buildChatRequest(p) {
    const base = normalizeBaseUrl(p && p.baseUrl);
    if (!base) throw new Error('接口地址为空');
    const model = String((p && p.model) || '').trim();
    if (!model) throw new Error('模型名未填写');
    const prompt = String((p && p.prompt) || '');
    const apiKey = String((p && p.apiKey) || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0.3,
    });
    return { url: base + '/chat/completions', headers, body, model };
  }

  // 从模型回复提取 JSON：容忍 ```json 围栏与前后杂文；返回解析后的数组或对象。
  // 括号配对扫描感知字符串与转义，避免内容里的引号/括号截断。
  function extractModelJson(text) {
    let s = String(text == null ? '' : text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1] && /[\[{]/.test(fence[1])) s = fence[1].trim();
    const start = s.search(/[\[{]/);
    if (start < 0) throw new Error('回复中没有找到 JSON');
    const open = s[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let escNext = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (c === '\\') escNext = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) throw new Error('JSON 不完整（括号未闭合，模型可能被截断，可重试或减小课件批量）');
    return JSON.parse(s.slice(start, end + 1));
  }

  // 课时包条目规范化：仅保留白名单字段 + 截断，坏条目剔除
  function normalizeAiItem(it) {
    if (!it || typeof it !== 'object') return null;
    const cut = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const acts = (Array.isArray(it.activities) ? it.activities : [])
      .map((a) => cut(a && a.name, 40)).filter(Boolean).slice(0, 15);
    const eqs = (Array.isArray(it.equipment) ? it.equipment : []).map((e) => ({
      eqId: cut(e && e.eqId, 30), eqName: cut(e && e.eqName, 30),
      preset: Number.isInteger(Number(e && e.preset)) && Number(e.preset) > 0 ? Number(e.preset) : 1,
    })).filter((e) => e.eqId || e.eqName).slice(0, 20);
    return {
      courseware: cut(it.courseware, 120), lessonName: cut(it.lessonName, 40),
      activities: acts, equipment: eqs,
    };
  }

  // 主进程发送器：http/https 自适应、超时、5MB 上限、错误友好化
  function httpPostJson(url, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = require(u.protocol === 'http:' ? 'http' : 'https');
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
        timeout: Math.max(5000, Number(timeoutMs) || 180000),
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 5 * 1024 * 1024) { req.destroy(); reject(new Error('响应超过 5MB，已中止')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let j = null;
          try { j = JSON.parse(text); } catch (_e) { return reject(new Error('响应不是 JSON：' + text.slice(0, 200))); }
          if (res.statusCode >= 400) {
            const em = j && j.error && (j.error.message || j.error.code);
            return reject(new Error('接口返回 ' + res.statusCode + (em ? '：' + em : '')));
          }
          const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (typeof content !== 'string') return reject(new Error('响应缺少 choices[0].message.content（确认接口为 OpenAI 兼容）'));
          resolve({ content, usage: j.usage || null });
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（小模型生成较慢属正常，可重试一次）')); });
      req.on('error', (e) => reject(new Error('无法连接模型接口：' + ((e && e.message) || e))));
      req.write(body);
      req.end();
    });
  }

  const api = { normalizeBaseUrl, buildChatRequest, extractModelJson, normalizeAiItem, httpPostJson };
  root.AiChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
