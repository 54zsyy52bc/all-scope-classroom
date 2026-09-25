'use strict';
// =============================================================================
// Preset Studio · 课件内容解析（批量导入课时：识别课件里的活动）
// 支持：PPTX（解压 ppt/slides/slideN.xml 取 <a:t> 文本）、DOCX（word/document.xml
// 取 <w:t> 按段落分行）；PDF 不解内容（降级：仅按文件名生成课时骨架）。
// 关键词识别活动标题：活动/实验/任务/动手/实践/练习/挑战。
// 纯函数无副作用，可无头单测（zip 为内置 zlib 手工构造，无外部依赖）。
// =============================================================================
const zlib = require('node:zlib');

// ---------- 极简 ZIP 读取（仅支持 store/deflate，够解 OOXML） ----------
function unzipEntries(buf) {
  const u32 = (o) => buf.readUInt32LE(o);
  const u16 = (o) => buf.readUInt16LE(o);
  // 定位 EOCD（从尾部向前找签名 0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('E-ZIP-01 不是有效的 zip/ooxml 文件');
  const count = u16(eocd + 10);
  let off = u32(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (u32(off) !== 0x02014b50) throw new Error('E-ZIP-02 中央目录损坏');
    const method = u16(off + 10);
    const csize = u32(off + 20);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // 本地头：文件名/扩展字段长度可能与中央目录不同，须按本地头自身取值
    const lNameLen = u16(localOff + 26);
    const lExtraLen = u16(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- XML 文本与实体 ----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// ---------- PPTX：按幻灯片序号提取每页文本（<a:t> 文本段） ----------
function pptxSlideTexts(buf) {
  const slides = unzipEntries(buf)
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name) && e.data)
    .sort((a, b) => Number(a.name.match(/(\d+)/)[1]) - Number(b.name.match(/(\d+)/)[1]));
  return slides.map((e) => (e.data.toString('utf8').match(/<a:t>([^<]*)<\/a:t>/g) || [])
    .map((t) => decodeEntities(t.replace(/<\/?a:t>/g, '')).trim()).filter(Boolean));
}

// ---------- DOCX：按段落提取文本行（<w:t>，</w:p> 分行） ----------
function docxLines(buf) {
  const doc = unzipEntries(buf).find((e) => e.name === 'word/document.xml');
  if (!doc || !doc.data) return [];
  return doc.data.toString('utf8').split(/<\/w:p>/).map((p) =>
    (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
      .map((t) => decodeEntities(t.replace(/<\/?w:t[^>]*>/g, ''))).join('').trim()
  ).filter(Boolean);
}

// ---------- 关键词识别活动标题 ----------
const ACTIVITY_RE = /活动|实验|任务|动手|实践|练习|挑战/;
function findActivityCandidates(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.length > 30) continue;           // 标题不长于 30 字
    if (!ACTIVITY_RE.test(line)) continue;              // 必须含活动关键词
    if (/^[\s\d.,、；;：:*#-]+$/.test(line)) continue;   // 纯符号/页码
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, 30));
    if (out.length >= 15) break;                        // 单课件上限 15 个
  }
  return out;
}

// ---------- 入口：按扩展名分发 ----------
function extractActivities(fileName, buf) {
  const lower = String(fileName || '').toLowerCase();
  try {
    if (lower.endsWith('.pptx')) return { titles: findActivityCandidates(pptxSlideTexts(buf).flat()) };
    if (lower.endsWith('.docx')) return { titles: findActivityCandidates(docxLines(buf)) };
    return { titles: [], reason: '该格式暂不支持内容识别（PPTX/DOCX 可识别），已按文件名生成课时' };
  } catch (e) {
    return { titles: [], reason: '内容解析失败（' + (e.message || e) + '），已按文件名生成课时' };
  }
}

module.exports = { unzipEntries, pptxSlideTexts, docxLines, findActivityCandidates, extractActivities };
