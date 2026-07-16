// background service worker：保存抓取的记录，处理 popup 请求，并管理注入
const state = {
  records: [],
  latestRecord: null,
  matching: {
    csvHeaders: [],
    csvRows: [],
    currentIndex: 0,
    isRunning: false,
    shouldStop: false,
    step: 'idle', // idle, capture, process, done, success, fail
    currentTitle: '',
    message: '就绪',
    results: [], // 'success' | 'fail' | null
  },
  tagging: {
    rows: [],
    currentIndex: 0,
    isRunning: false,
    shouldStop: false,
    step: 'idle',
    message: '就绪',
    results: [], // 'success' | 'fail' | null
    tabId: null,
  },
};

let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // 保持 service worker 活跃
  }, 5000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function saveMatchingState() {
  chrome.storage.local.set({
    matchingCsvHeaders: state.matching.csvHeaders,
    matchingCsvRows: state.matching.csvRows,
    matchingCurrentIndex: state.matching.currentIndex,
    matchingStep: state.matching.step,
    matchingCurrentTitle: state.matching.currentTitle,
    matchingMessage: state.matching.message,
    matchingResults: state.matching.results,
  });
  console.log('[saveMatchingState] headers=', state.matching.csvHeaders, 'rowsSample=', state.matching.csvRows.slice(0, 2));
}

function saveTaggingState() {
  chrome.storage.local.set({
    taggingRows: state.tagging.rows,
    taggingCurrentIndex: state.tagging.currentIndex,
    taggingStep: state.tagging.step,
    taggingMessage: state.tagging.message,
    taggingResults: state.tagging.results,
    taggingTabId: state.tagging.tabId,
  });
}

function getMatchingStatus() {
  return {
    isRunning: state.matching.isRunning,
    step: state.matching.step,
    currentTitle: state.matching.currentTitle,
    message: state.matching.message,
    currentIndex: state.matching.currentIndex,
    total: state.matching.csvRows.length,
    results: state.matching.results,
  };
}

function getTaggingStatus() {
  return {
    isRunning: state.tagging.isRunning,
    step: state.tagging.step,
    message: state.tagging.message,
    currentIndex: state.tagging.currentIndex,
    total: state.tagging.rows.length,
    results: state.tagging.results,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_RECORD') {
    state.records.push(message.record);
    state.latestRecord = message.record;
    console.log('CAPTURE_RECORD', message.record);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_STATE') {
    sendResponse({ records: state.records });
    return true;
  }

  if (message.type === 'CLEAR_RECORDS') {
    state.records = [];
    state.latestRecord = null;
    state.matching.csvHeaders = [];
    state.matching.csvRows = [];
    state.matching.currentIndex = 0;
    state.matching.isRunning = false;
    state.matching.shouldStop = false;
    state.matching.step = 'idle';
    state.matching.currentTitle = '';
    state.matching.message = '就绪';
    state.matching.results = [];
    state.tagging.rows = [];
    state.tagging.currentIndex = 0;
    state.tagging.isRunning = false;
    state.tagging.shouldStop = false;
    state.tagging.step = 'idle';
    state.tagging.message = '就绪';
    state.tagging.results = [];
    state.tagging.tabId = null;
    chrome.storage.local.clear(() => {
      sendResponse({ success: true });
    });
    stopKeepAlive();
    return true;
  }

  if (message.type === 'GET_LATEST_RECORD') {
    const record = state.latestRecord;
    state.latestRecord = null;
    sendResponse({ record });
    return true;
  }

  if (message.type === 'CLEAR_LATEST_RECORD') {
    state.latestRecord = null;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'WAIT_FOR_ARTICLE_DETAILS_UPDATE') {
    waitForArticleSaveRecords(message.timeout || 30000).then((records) => {
      const updateRecord = records.update;
      const detailsRecord = records.details;

      if (!updateRecord || !detailsRecord) {
        const missing = [];
        if (!updateRecord) missing.push('ArticleDetailsUpdate');
        if (!detailsRecord) missing.push('ArticleDetails');
        sendResponse({ success: false, error: `未捕获到接口：${missing.join('、')}` });
        return;
      }

      const updateStatus = updateRecord.status || 0;
      const detailsStatus = detailsRecord.status || 0;
      const updateHasError = hasGraphQLError(updateRecord.data);
      const detailsHasError = hasGraphQLError(detailsRecord.data);
      console.log(`[WAIT_FOR_ARTICLE_DETAILS_UPDATE] ArticleDetailsUpdate status=${updateStatus} hasError=${updateHasError}, ArticleDetails status=${detailsStatus} hasError=${detailsHasError}`);

      if (updateStatus >= 200 && updateStatus < 300 && !updateHasError &&
        detailsStatus >= 200 && detailsStatus < 300 && !detailsHasError) {
        sendResponse({ success: true, records });
      } else {
        const errors = [];
        if (updateStatus < 200 || updateStatus >= 300 || updateHasError) errors.push('ArticleDetailsUpdate 失败');
        if (detailsStatus < 200 || detailsStatus >= 300 || detailsHasError) errors.push('ArticleDetails 失败');
        sendResponse({ success: false, error: errors.join('，') });
      }
    });
    return true;
  }

  if (message.type === 'START_MATCHING') {
    state.matching.csvHeaders = message.csvHeaders || [];
    state.matching.csvRows = message.csvRows || [];
    state.matching.currentIndex = 0;
    state.matching.isRunning = true;
    state.matching.shouldStop = false;
    state.matching.step = 'capture';
    state.matching.currentTitle = '';
    state.matching.message = '开始匹配';
    saveMatchingState();
    startMatchingProcess();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_MATCHING') {
    state.matching.shouldStop = true;
    state.matching.step = 'idle';
    state.matching.message = '已停止';
    saveMatchingState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_MATCHING_STATUS') {
    sendResponse(getMatchingStatus());
    return true;
  }

  if (message.type === 'GET_MATCHING_RESULT') {
    console.log('[GET_MATCHING_RESULT] headers=', state.matching.csvHeaders, 'rows=', state.matching.csvRows);
    sendResponse({
      csvHeaders: state.matching.csvHeaders,
      csvRows: state.matching.csvRows,
    });
    return true;
  }

  if (message.type === 'SET_MATCHING_RESULT') {
    state.matching.csvHeaders = message.csvHeaders || [];
    state.matching.csvRows = message.csvRows || [];
    saveMatchingState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'START_TAGGING') {
    state.tagging.rows = message.rows || [];
    state.tagging.currentIndex = 0;
    state.tagging.isRunning = true;
    state.tagging.shouldStop = false;
    state.tagging.step = 'idle';
    state.tagging.message = '开始打标签';
    state.tagging.results = [];
    state.tagging.tabId = null;
    saveTaggingState();
    startTaggingProcess();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_TAGGING') {
    state.tagging.shouldStop = true;
    state.tagging.step = 'idle';
    state.tagging.message = '已停止';
    saveTaggingState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_TAGGING_STATUS') {
    sendResponse(getTaggingStatus());
    return true;
  }

  if (message.type === 'GET_TAGGING_RESULT') {
    sendResponse({
      rows: state.tagging.rows,
      results: state.tagging.results,
    });
    return true;
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    injectPageScript(tabId).catch(() => { });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getColumnIndex(headers, name) {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
}

function extractIdFromGid(gid) {
  if (!gid) return '';
  const parts = gid.split('/');
  return parts[parts.length - 1] || '';
}

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

async function startMatchingProcess() {
  startKeepAlive();
  const matching = state.matching;
  let idIndex = getColumnIndex(matching.csvHeaders, 'id');
  if (idIndex === -1) {
    matching.csvHeaders.push('id');
    idIndex = matching.csvHeaders.length - 1;
  }
  const urlIndex = getColumnIndex(matching.csvHeaders, 'URL');
  const blogTitleIndex = getColumnIndex(matching.csvHeaders, 'blog_title');
  const titleIndex = getColumnIndex(matching.csvHeaders, 'Title');
  const total = matching.csvRows.length;

  let shopifyTab;
  try {
    shopifyTab = await getOrCreateShopifyTab();
  } catch (err) {
    matching.step = 'idle';
    matching.message = '无法创建 Shopify 标签页';
    matching.isRunning = false;
    saveMatchingState();
    stopKeepAlive();
    return;
  }

  for (let i = 0; i < total; i++) {
    matching.currentIndex = i;
    if (matching.shouldStop) break;

    const row = matching.csvRows[i];
    if (row[idIndex]) {
      matching.results[i] = 'success';
      saveMatchingState();
      continue;
    }

    const url = row[urlIndex] || '';
    const blogTitle = row[blogTitleIndex] || '';
    const title = row[titleIndex] || '';

    matching.step = 'capture';
    matching.currentTitle = title || url;
    matching.message = `正在匹配：${title || url}`;
    saveMatchingState();

    const matched = await matchRow(shopifyTab.id, blogTitle, url, idIndex, row);

    console.log('[matchRow] matched result', matched, 'for url=', url, 'row=', row);
    if (matched) {
      matching.step = 'process';
      matching.message = `已匹配：${title || url}`;
      matching.results[i] = 'success';
    } else {
      matching.step = 'idle';
      matching.message = `未匹配：${title || url}`;
      matching.results[i] = 'fail';
    }
    saveMatchingState();
  }

  matching.step = 'done';
  matching.message = '匹配完成';
  matching.isRunning = false;
  matching.currentTitle = '';
  saveMatchingState();
  stopKeepAlive();

  chrome.notifications.create('matching-done', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '匹配完成',
    message: 'Shopify ID 匹配已完成，可以导出 CSV 了',
  }, (notificationId) => {
    console.log('[background] 匹配完成通知已创建', notificationId, chrome.runtime.lastError);
  });
}

async function matchRow(tabId, blogTitle, url, idIndex, row) {
  const searchUrl = `https://admin.shopify.com/store/aftershokz-com/content/articles?blog_title=${encodeURIComponent(blogTitle)}`;
  await chrome.tabs.update(tabId, { url: searchUrl });
  await waitForTabLoad(tabId);
  await clearLatestRecord();

  while (true) {
    if (state.matching.shouldStop) return false;

    state.matching.step = 'capture';
    state.matching.message = `正在捕获接口：${blogTitle}`;
    saveMatchingState();

    const record = await waitForRecord(30000);
    if (!record) return false;

    state.matching.step = 'success';
    state.matching.message = `捕获成功：${blogTitle}`;
    saveMatchingState();

    state.matching.step = 'process';
    state.matching.message = `正在解析数据：${blogTitle}`;
    saveMatchingState();

    const found = await tryFillIdFromRecord(record, url, idIndex, row);
    if (found) return true;

    if (state.matching.shouldStop) return false;

    state.matching.step = 'capture';
    state.matching.message = '未找到，准备翻页';
    saveMatchingState();

    let clickResult;
    try {
      clickResult = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_CLICK_NEXT_BUTTON' });
    } catch (err) {
      return false;
    }

    if (!clickResult || clickResult.isDisabled || !clickResult.success) {
      return false;
    }
    await clearLatestRecord();
  }
}

async function clearLatestRecord() {
  state.latestRecord = null;
}

async function waitForRecord(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.matching.shouldStop) return null;
    if (state.latestRecord) {
      const record = state.latestRecord;
      state.latestRecord = null;
      return record;
    }
    await sleep(500);
  }
  return null;
}

async function waitForArticleSaveRecords(timeoutMs = 30000) {
  const result = { update: null, details: null };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.latestRecord) {
      const url = state.latestRecord.url || '';
      if (url.includes('admin.shopify.com/api/operations')) {
        if (url.includes('ArticleDetailsUpdate') && !result.update) {
          result.update = state.latestRecord;
          console.log('[waitForArticleSaveRecords] 捕获 ArticleDetailsUpdate');
        }
        if (url.includes('ArticleDetails') && !url.includes('ArticleDetailsUpdate') && !result.details) {
          result.details = state.latestRecord;
          console.log('[waitForArticleSaveRecords] 捕获 ArticleDetails');
        }
      }
      state.latestRecord = null;

      if (result.update && result.details) {
        console.log('[waitForArticleSaveRecords] 两个接口均已捕获');
        return result;
      }
    }
    await sleep(500);
  }
  console.log('[waitForArticleSaveRecords] 超时，update=', !!result.update, 'details=', !!result.details);
  return result;
}

function hasGraphQLError(data) {
  if (!data) return false;
  if (Array.isArray(data.errors) && data.errors.length > 0) return true;
  if (data.data && Array.isArray(data.data.errors) && data.data.errors.length > 0) return true;
  return false;
}

async function tryFillIdFromRecord(record, url, idIndex, row) {
  try {
    const data = record.data || record;
    const edges = data?.data?.onlineStore?.articles?.edges || [];
    console.log('[tryFillIdFromRecord] url=', url, 'edgesCount=', edges.length, 'recordKeys=', Object.keys(data || {}));
    for (const edge of edges) {
      const node = edge?.node || {};
      const relativePath = node.relativeStorefrontPath || '';
      console.log('[tryFillIdFromRecord] node.relativeStorefrontPath=', relativePath, 'node.id=', node.id);
      if (relativePath && url.includes(relativePath)) {
        row[idIndex] = extractIdFromGid(node.id);
        console.log('[tryFillIdFromRecord] matched! id=', row[idIndex]);
        return true;
      }
    }
    console.log('[tryFillIdFromRecord] no match');
  } catch (e) {
    console.error('[tryFillIdFromRecord] error', e);
  }
  return false;
}

async function getOrCreateShopifyTab() {
  const tabs = await chrome.tabs.query({ url: 'https://admin.shopify.com/store/aftershokz-com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0];
  }
  return new Promise((resolve) => {
    chrome.tabs.create({ url: 'https://admin.shopify.com/store/aftershokz-com/', active: true }, (tab) => resolve(tab));
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Shopify 是 SPA，status complete 后 React 组件仍在初始化，多等一会儿
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
}

async function startTaggingProcess() {
  startKeepAlive();
  const tagging = state.tagging;
  const total = tagging.rows.length;

  let shopifyTab;
  try {
    shopifyTab = await getOrCreateShopifyTab();
    tagging.tabId = shopifyTab.id;
  } catch (err) {
    tagging.step = 'idle';
    tagging.message = '无法创建 Shopify 标签页';
    tagging.isRunning = false;
    saveTaggingState();
    stopKeepAlive();
    return;
  }

  for (let i = 0; i < total; i++) {
    tagging.currentIndex = i;
    if (tagging.shouldStop) break;

    const row = tagging.rows[i];
    tagging.step = 'process';
    tagging.message = `正在打标签：文章 ${row.id}`;
    console.log('[startTaggingProcess] start row', i, 'id=', row.id, 'row=', row);
    saveTaggingState();

    const url = `https://admin.shopify.com/store/aftershokz-com/content/articles/${row.id}`;
    try {
      await chrome.tabs.update(tagging.tabId, { url });
      await waitForTabLoad(tagging.tabId);

      console.log('[startTaggingProcess] send TAG_ROW to tab', tagging.tabId, 'row=', row);
      const result = await chrome.tabs.sendMessage(tagging.tabId, { type: 'TAG_ROW', row });
      console.log('[startTaggingProcess] tag result', result, 'for row', row);

      // 等待 1 秒，避免 Shopify 的 beforeunload 弹窗
      await sleep(1000);

      if (result && result.success) {
        tagging.results[i] = 'success';
        tagging.message = `已处理：文章 ${row.id}`;
        row.beforeTags = result.beforeTags || [];
        row.afterTags = result.afterTags || [];
        row.status = '已打标';
        console.log('[startTaggingProcess] success beforeTags=', row.beforeTags, 'afterTags=', row.afterTags);
      } else {
        tagging.results[i] = 'fail';
        tagging.message = `处理失败：文章 ${row.id}，${result?.error || '未知错误'}`;
        row.status = '未打标';
        console.log('[startTaggingProcess] fail error=', result?.error);
      }
    } catch (err) {
      console.error('[startTaggingProcess] error', err);
      tagging.results[i] = 'fail';
      tagging.message = `处理失败：文章 ${row.id}，${err.message}`;
      row.status = '未打标';
    }
    saveTaggingState();
    console.log('[startTaggingProcess] saved row', i, 'row=', row);
  }

  tagging.step = 'done';
  tagging.message = '打标签完成';
  tagging.isRunning = false;
  tagging.currentIndex = 0;
  saveTaggingState();
  console.log('[startTaggingProcess] done rows=', tagging.rows);
  stopKeepAlive();

  chrome.notifications.create('tagging-done', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '打标签完成',
    message: 'Shopify 文章标签处理已完成',
  }, (notificationId) => {
    console.log('[background] 打标签完成通知已创建', notificationId, chrome.runtime.lastError);
  });
}

// 启动时恢复状态
chrome.storage.local.get(['matchingCsvHeaders', 'matchingCsvRows', 'matchingCurrentIndex', 'matchingStep', 'matchingCurrentTitle', 'matchingMessage', 'matchingResults', 'taggingRows', 'taggingCurrentIndex', 'taggingStep', 'taggingMessage', 'taggingResults', 'taggingTabId'], (result) => {
  if (result.matchingCsvRows && result.matchingCsvRows.length > 0) {
    state.matching.csvHeaders = result.matchingCsvHeaders || [];
    state.matching.csvRows = result.matchingCsvRows || [];
    state.matching.currentIndex = result.matchingCurrentIndex || 0;
    state.matching.step = result.matchingStep || 'idle';
    state.matching.currentTitle = result.matchingCurrentTitle || '';
    state.matching.message = result.matchingMessage || '就绪';
    state.matching.results = result.matchingResults || [];
    state.matching.isRunning = false;
    state.matching.shouldStop = false;
    saveMatchingState();
  }
  if (result.taggingRows && result.taggingRows.length > 0) {
    state.tagging.rows = result.taggingRows || [];
    state.tagging.currentIndex = result.taggingCurrentIndex || 0;
    state.tagging.step = result.taggingStep || 'idle';
    state.tagging.message = result.taggingMessage || '就绪';
    state.tagging.results = result.taggingResults || [];
    state.tagging.tabId = result.taggingTabId || null;
    state.tagging.isRunning = false;
    state.tagging.shouldStop = false;
    saveTaggingState();
  }
});
