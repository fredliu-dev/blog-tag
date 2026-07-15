// background service worker：保存抓取的记录，处理 popup 请求，并管理注入
const state = {
  records: [],
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_RECORD') {
    state.records.push(message.record);
    sendResponse({ success: true });
  }

  if (message.type === 'GET_STATE') {
    sendResponse({ ...state });
  }

  if (message.type === 'CLEAR_RECORDS') {
    state.records = [];
    sendResponse({ success: true });
  }

  return true;
});

async function injectPageScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('devtools://')) {
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-inject.js'],
      world: 'MAIN',
      injectImmediately: true,
    });
  } catch (err) {
    console.warn('注入 page-inject.js 失败:', err.message);
  }
}

// 当页面开始加载时，尽早注入脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    injectPageScript(tabId).catch(() => { });
  }
});
