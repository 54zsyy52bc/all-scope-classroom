'use strict';
// Preset Studio · src/ai-chat.js 纯函数单测：URL 规范化 / 请求构造 / 模型回复 JSON 提取 / 条目规范化。
const {
  normalizeBaseUrl, buildChatRequest, extractModelJson, normalizeAiItem,
} = require('../src/ai-chat');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

// ---------- normalizeBaseUrl ----------
check('补 https 协议', normalizeBaseUrl('api-inference.modelscope.cn/v1') === 'https://api-inference.modelscope.cn/v1');
check('去尾斜杠', normalizeBaseUrl('https://x.cn/v1/') === 'https://x.cn/v1');
check('去掉误填的 /chat/completions 后缀', normalizeBaseUrl('https://x.cn/v1/chat/completions') === 'https://x.cn/v1');
check('空白返回空串', normalizeBaseUrl('   ') === '');
check('保留 http（本地 vLLM/Ollama）', normalizeBaseUrl('http://127.0.0.1:8000/v1') === 'http://127.0.0.1:8000/v1');

// ---------- buildChatRequest ----------
const req = buildChatRequest({
  baseUrl: 'https://api.example.cn/v1/', apiKey: ' sk-abc ', model: ' Qwen/Qwen2.5-7B-Instruct ', prompt: '生成课时包',
});
check('URL 拼接 chat/completions', req.url === 'https://api.example.cn/v1/chat/completions');
check('Bearer 头携带去空格 Key', req.headers.Authorization === 'Bearer sk-abc');
const reqBody = JSON.parse(req.body);
check('body 模型名去空格', reqBody.model === 'Qwen/Qwen2.5-7B-Instruct');
check('body 单条 user 消息', reqBody.messages.length === 1 && reqBody.messages[0].role === 'user'
  && reqBody.messages[0].content === '生成课时包');
check('body 非流式', reqBody.stream === false);
check('无 Key 不带 Authorization 头', buildChatRequest({ baseUrl: 'https://x/v1', model: 'm', prompt: 'p' })
  .headers.Authorization === undefined);
let threw = '';
try { buildChatRequest({ baseUrl: 'https://x/v1', prompt: 'p' }); } catch (e) { threw = e.message; }
check('缺模型名报错', threw.indexOf('模型名') >= 0, threw);

// ---------- extractModelJson ----------
check('纯 JSON 数组', JSON.stringify(extractModelJson('[{"a":1}]')) === '[{"a":1}]');
check('剥 ```json 围栏', extractModelJson('```json\n[{"a":1}]\n```').length === 1);
check('前后杂文容忍', Array.isArray(extractModelJson('好的，结果如下：\n[{"courseware":"x.pptx"}]\n以上。')));
check('单对象返回对象', extractModelJson('{"lessonName":"第1课"}').lessonName === '第1课');
check('内容含引号转义不截断', extractModelJson('[{"a":"他说：\\"结束\\""}]')[0].a === '他说："结束"');
check('字符串内花括号不干扰配对', extractModelJson('[{"a":"{不配对"}]')[0].a === '{不配对');
let e1 = '';
try { extractModelJson('今天天气不错'); } catch (e) { e1 = e.message; }
check('无 JSON 报错', e1.indexOf('JSON') >= 0, e1);
let e2 = '';
try { extractModelJson('[{"a":1'); } catch (e) { e2 = e.message; }
check('括号未闭合报错', e2.indexOf('未闭合') >= 0, e2);

// ---------- normalizeAiItem ----------
const it = normalizeAiItem({
  courseware: '第1课.pptx', lessonName: 'x'.repeat(50),
  activities: [{ name: '点亮 LED' }, { name: '' }, null, { name: 'y'.repeat(60) }],
  equipment: [{ eqId: 'LED', preset: 0 }, { eqName: '面包板' }, { eqId: 'z'.repeat(40) }],
  extra: '应被丢弃',
});
check('课时名截断 40', it.lessonName.length === 40);
check('活动过滤空名并截断 40', it.activities.length === 2 && it.activities[1].length === 40);
check('器材 preset 非法回落 1', it.equipment[0].preset === 1);
check('器材仅名称也保留', it.equipment[1].eqName === '面包板');
check('器材 eqId 截断 30', it.equipment[2].eqId.length === 30);
check('非对象返回 null', normalizeAiItem('x') === null && normalizeAiItem(null) === null);

console.log('\n== ai-chat: ' + pass + ' 通过 / ' + fail + ' 失败 ==');
process.exit(fail ? 1 : 0);
