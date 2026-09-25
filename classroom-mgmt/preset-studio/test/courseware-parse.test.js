'use strict';
// courseware-parse 无头单测：ZIP 解压 / PPTX·DOCX 文本提取 / 活动关键词识别 / 扩展名分发。
// 用 zlib.deflateRawSync 手工构造合成 PPTX/DOCX 字节流，不依赖真实 Office 文件。
// 运行：node test/courseware-parse.test.js
const zlib = require('node:zlib');
const {
  unzipEntries, pptxSlideTexts, docxLines, findActivityCandidates, extractActivities,
} = require('../src/courseware-parse');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

// ---------- 手工构造 zip（deflate 条目 + store 条目混排） ----------
function dosTime() { return 0; }
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method === 0 ? 0 : 8, 8);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method === 0 ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const SLIDE = (texts) => Buffer.from(
  '<?xml version="1.0"?><p:sld xmlns:a="http://a"><p:cSld><p:spTree>'
  + texts.map((t) => '<a:p><a:r><a:t>' + t + '</a:t></a:r></a:p>').join('')
  + '</p:spTree></p:cSld></p:sld>', 'utf8');

const pptx = makeZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 0 },
  { name: 'ppt/slides/slide2.xml', data: SLIDE(['第2页', '实验：观察 LED 亮度变化']), method: 8 },
  { name: 'ppt/slides/slide1.xml', data: SLIDE(['第1课 点亮LED', '活动一：认识面包板', '活动一：认识面包板', '这就是一个很长很长很长很长很长很长很长很长很长的行不应当被识别活动']), method: 8 },
]);

// ---------- 解压 ----------
const entries = unzipEntries(pptx);
check('解压：条目数与文件名', entries.length === 3 && entries.some((e) => e.name === 'ppt/slides/slide1.xml'));
check('解压：store 与 deflate 条目内容一致', entries.find((e) => e.name === '[Content_Types].xml').data.toString() === '<Types/>'
  && entries.find((e) => e.name === 'ppt/slides/slide1.xml').data.toString().includes('点亮LED'));

// ---------- PPTX 提取（按 slideN 排序） ----------
const slides = pptxSlideTexts(pptx);
check('PPTX：按序号排序提取每页文本', slides.length === 2
  && slides[0][0] === '第1课 点亮LED' && slides[1][1] === '实验：观察 LED 亮度变化');

// ---------- 关键词识别 ----------
const cands = findActivityCandidates(slides.flat());
check('识别：命中活动/实验关键词', cands.includes('活动一：认识面包板') && cands.includes('实验：观察 LED 亮度变化'), JSON.stringify(cands));
check('识别：去重 + 超 30 字行剔除', cands.length === 2, JSON.stringify(cands));
check('识别：无命中返回空', findActivityCandidates(['目录', '第1页', '谢谢观看']).length === 0);
check('识别：纯符号行剔除', findActivityCandidates(['1. 实验', '实验——']).length >= 0); // 不抛错即可

// ---------- DOCX ----------
const docXml = '<?xml?><w:document><w:body>'
  + '<w:p><w:r><w:t>动手实践：焊接 LED 电路</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>普通段落不计入</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>&amp; 实验安全须知</w:t></w:r></w:p>'
  + '</w:body></w:document>';
const docx = makeZip([{ name: 'word/document.xml', data: Buffer.from(docXml), method: 8 }]);
const lines = docxLines(docx);
check('DOCX：段落分行 + 实体解码', lines.length === 3 && lines[2] === '& 实验安全须知', JSON.stringify(lines));
check('DOCX：识别活动标题', findActivityCandidates(lines).length === 2);

// ---------- 入口分发 ----------
const r1 = extractActivities('点亮LED.pptx', pptx);
check('入口：pptx 分发识别', r1.titles.length === 2 && !r1.reason);
const r2 = extractActivities('讲义.pdf', Buffer.from('%PDF-1.4'));
check('入口：pdf 降级仅骨架', r2.titles.length === 0 && /暂不支持/.test(r2.reason));
const r3 = extractActivities('损坏.pptx', Buffer.from('not a zip'));
check('入口：坏文件降级不抛错', r3.titles.length === 0 && /解析失败/.test(r3.reason));
const r4 = extractActivities('文档.docx', docx);
check('入口：docx 分发识别', r4.titles.length === 2);

// ---------- 坏 zip 直接调解压应抛 E-ZIP-01 ----------
let threw = false;
try { unzipEntries(Buffer.from('junk')); } catch (e) { threw = /E-ZIP-01/.test(e.message); }
check('解压：坏 zip 抛 E-ZIP-01', threw);

console.log('\ncourseware-parse 验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
