// 页面主世界注入：拦截 fetch 和 XMLHttpRequest
(function () {
  // 避免重复注入
  if (window.__api_capture_injected__) return;
  window.__api_capture_injected__ = true;

  const MATCH_KEYWORDS = [];
  let isListening = true;

  // 接收 content script 发过来的配置
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.type !== 'API_CAPTURE_CONFIG') return;

    const config = msg.config || {};
    if (Array.isArray(config.keywords) && config.keywords.length > 0) {
      MATCH_KEYWORDS.length = 0;
      MATCH_KEYWORDS.push(...config.keywords);
    }
    console.log('[API Capture] 配置更新:', { keywords: MATCH_KEYWORDS, listening: isListening });
  });

  // 临时屏蔽 beforeunload 弹窗
  let suppressBeforeUnload = false;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.type === 'SUPPRESS_BEFORE_UNLOAD') {
      suppressBeforeUnload = true;
      console.log('[API Capture] 临时屏蔽 beforeunload');
      setTimeout(() => {
        suppressBeforeUnload = false;
        console.log('[API Capture] 恢复 beforeunload');
      }, msg.duration || 3000);
    }
  });

  const originalAddEventListener = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') {
      const wrappedListener = function (event) {
        if (suppressBeforeUnload) {
          event.preventDefault = () => { };
          event.returnValue = '';
          return undefined;
        }
        return listener.apply(this, arguments);
      };
      return originalAddEventListener.call(this, type, wrappedListener, options);
    }
    return originalAddEventListener.apply(this, arguments);
  };

  function sendToContentScript(record) {
    window.postMessage({ type: 'API_CAPTURE_RECORD', record }, '*');
  }

  function shouldCapture(url) {
    if (MATCH_KEYWORDS.length === 0) return false;
    return MATCH_KEYWORDS.some((keyword) => url.includes(keyword));
  }

  // 解析响应体
  async function parseBody(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        return await response.clone().json();
      } catch {
        return await response.clone().text();
      }
    }
    return await response.clone().text();
  }

  function startCapture() {
    // 拦截 fetch
    if (!window.fetch || !window.fetch.__api_capture_wrapped__) {
      const originalFetch = window.fetch;
      const wrappedFetch = async function (...args) {
        const input = args[0];
        const url = typeof input === 'string' ? input : input.url || input.toString();

        const response = await originalFetch.apply(this, args);
        if (shouldCapture(url)) {
          console.log(url, response);
          try {
            const data = await parseBody(response);
            sendToContentScript({
              url,
              method: typeof input === 'string' ? (args[1]?.method || 'GET') : input.method,
              status: response.status,
              timestamp: new Date().toISOString(),
              data,
            });
          } catch (err) {
            // 忽略解析失败
          }
        }

        return response;
      };
      wrappedFetch.__api_capture_wrapped__ = true;
      window.fetch = wrappedFetch;
    }

    // 拦截 XMLHttpRequest
    if (!XMLHttpRequest.prototype.send.__api_capture_wrapped__) {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._captureMethod = method;
        this._captureUrl = url;
        return originalOpen.apply(this, [method, url, ...rest]);
      };

      const wrappedSend = function (body) {
        const xhr = this;
        const url = this._captureUrl || '';

        if (shouldCapture(url)) {
          const originalOnReady = this.onreadystatechange;
          this.onreadystatechange = function () {
            if (xhr.readyState === 4) {
              try {
                let data = xhr.responseText;
                try {
                  data = JSON.parse(data);
                } catch {
                  // 保持文本
                }
                sendToContentScript({
                  url,
                  method: xhr._captureMethod || 'GET',
                  status: xhr.status,
                  timestamp: new Date().toISOString(),
                  data,
                });
              } catch (err) {
                // 忽略解析失败
              }
            }
            if (originalOnReady) {
              originalOnReady.apply(this, arguments);
            }
          };
        }

        return originalSend.apply(this, [body]);
      };
      wrappedSend.__api_capture_wrapped__ = true;
      XMLHttpRequest.prototype.send = wrappedSend;
    }
  }

  startCapture();

  const retryTimer = setInterval(() => {
    startCapture();
  }, 1000);

  setTimeout(() => clearInterval(retryTimer), 10000);
})();
