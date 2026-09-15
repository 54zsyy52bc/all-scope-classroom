'use strict';
// 加载失败页：把 Chromium 的错误码翻译成中小学生看得懂的话
(function () {
  const { api, param } = window.GN;

  const DICT = {
    '-105': '找不到这个网站，检查一下网址有没有写错。',
    '-106': '电脑好像没有连上网络，看看网线插好没有。',
    '-109': '找不到这台服务器，可能地址填错了。',
    '-118': '连接超时了，网络有点慢，等一会儿再试。',
    '-102': '服务器没有响应，可能它没在运行。',
    '-101': '网络连接被中断了，再试一次看看。',
    '-201': '这个网站的安全证书有问题，为了安全就不打开了。',
    '-7': '等待服务器响应超时了。',
    '-6': '这个文件找不到。',
    '-2': '网页加载失败了，再试一次看看。',
    '-137': '网址不太对，检查一下有没有多余的空格或字符。',
  };

  const url = param('url');
  const code = param('code');
  document.getElementById('url-box').textContent = url || '(未知网址)';
  document.getElementById('reason').textContent = DICT[code] || '网页加载失败了，再试一次看看。';
  if (code) document.getElementById('code-line').textContent = '错误码 ' + code + (param('desc') ? '　' + param('desc') : '');

  document.getElementById('btn-retry').onclick = () => {
    if (url && api.go) api.go(url);
    else if (api.reload) api.reload();
  };
  document.getElementById('btn-home').onclick = () => api.openInternal('home');
})();
