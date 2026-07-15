// content script：监听页面注入脚本发送的记录，并转发给 background
(function () {
  if (window.__api_capture_content_injected__) return;
  window.__api_capture_content_injected__ = true;

  // 注入页面主世界脚本
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  async function loadConfig() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const res = await fetch(url);
      return await res.json();
    } catch {
      return { keywords: [] };
    }
  }

  async function applyConfig() {
    const config = await loadConfig();
    window.postMessage(
      {
        type: 'API_CAPTURE_CONFIG',
        config: {
          keywords: config.keywords || [],
          listening: true,
        },
      },
      '*'
    );
  }

  // 监听页面注入脚本发送过来的记录
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.type !== 'API_CAPTURE_RECORD') return;

    const record = msg.record;
    chrome.runtime.sendMessage({ type: 'CAPTURE_RECORD', record });
  });

  // 注入后立即应用配置文件
  applyConfig();
})();
