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
  console.log('[saveTaggingState] rows=', state.tagging.rows.map((r) => ({ id: r.id, rowIndex: r.rowIndex, beforeTags: r.beforeTags, afterTags: r.afterTags, status: r.status })));
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
    waitForApiRecords('saveArticleTags', message.timeout || 30000).then((records) => {
      const updateRecord = records.ArticleDetailsUpdate;
      const detailsRecord = records.ArticleDetails;

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
    }).catch((err) => {
      console.error('[WAIT_FOR_ARTICLE_DETAILS_UPDATE] error', err);
      sendResponse({ success: false, error: err?.message || '未知错误' });
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

  matching.results = Array(total).fill(null);
  for (let i = 0; i < total; i++) {
    if (matching.csvRows[i][idIndex]) {
      matching.results[i] = 'success';
    }
  }

  // 按 blog_title 分组，只收集未匹配的记录索引
  const groups = new Map();
  for (let i = 0; i < total; i++) {
    if (matching.results[i]) continue;
    const row = matching.csvRows[i];
    const blogTitle = row[blogTitleIndex] || '';
    if (!groups.has(blogTitle)) {
      groups.set(blogTitle, []);
    }
    groups.get(blogTitle).push(i);
  }

  console.log('[startMatchingProcess] groups=', Array.from(groups.entries()).map(([k, v]) => `${k}(${v.length})`).join(', '));

  for (const [blogTitle, rowIndexes] of groups) {
    if (matching.shouldStop) break;

    const pendingRows = rowIndexes.filter((i) => !matching.csvRows[i][idIndex]);
    if (pendingRows.length === 0) continue;

    matching.step = 'capture';
    matching.currentTitle = blogTitle;
    matching.currentIndex = pendingRows[0];
    matching.message = `正在匹配 blog：${blogTitle}，剩余 ${pendingRows.length} 条`;
    saveMatchingState();

    const allMatched = await matchRowsByBlogTitle(shopifyTab.id, blogTitle, pendingRows, idIndex, urlIndex);
    console.log('[matchRowsByBlogTitle] allMatched=', allMatched, 'blogTitle=', blogTitle, 'remaining=', pendingRows.length);

    // 未匹配的记录标记为 fail
    for (const i of pendingRows) {
      if (!matching.csvRows[i][idIndex]) {
        matching.results[i] = 'fail';
      }
    }
    saveMatchingState();
  }

  // 补齐剩余状态
  for (let i = 0; i < total; i++) {
    if (!matching.results[i]) {
      matching.results[i] = matching.csvRows[i][idIndex] ? 'success' : 'fail';
    }
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

async function matchRowsByBlogTitle(tabId, blogTitle, rowIndexes, idIndex, urlIndex) {
  const searchUrl = `https://admin.shopify.com/store/aftershokz-com/content/articles?blog_title=${encodeURIComponent(blogTitle)}`;
  await chrome.tabs.update(tabId, { url: searchUrl });
  await waitForTabLoad(tabId);
  await clearLatestRecord();

  let hasMorePages = true;
  while (hasMorePages && rowIndexes.length > 0) {
    if (state.matching.shouldStop) return false;

    state.matching.step = 'capture';
    state.matching.message = `正在捕获接口：${blogTitle}，剩余 ${rowIndexes.length} 条`;
    state.matching.currentIndex = rowIndexes[0];
    saveMatchingState();

    const records = await waitForApiRecords('matchArticleId', 30000);
    const record = records.ArticleList;
    if (!record) return false;

    state.matching.step = 'success';
    state.matching.message = `捕获成功：${blogTitle}`;
    saveMatchingState();

    state.matching.step = 'process';
    state.matching.message = `正在解析数据：${blogTitle}`;
    saveMatchingState();

    tryFillIdsFromRecord(record, rowIndexes, idIndex, urlIndex);

    // 移除已匹配的记录
    const remaining = rowIndexes.filter((i) => !state.matching.csvRows[i][idIndex]);
    rowIndexes.length = 0;
    rowIndexes.push(...remaining);

    console.log('[matchRowsByBlogTitle] after match, remaining=', remaining.length);

    if (rowIndexes.length === 0) {
      return true;
    }

    if (state.matching.shouldStop) return false;

    state.matching.step = 'capture';
    state.matching.message = '未全部匹配，准备翻页';
    saveMatchingState();

    let clickResult;
    try {
      clickResult = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_CLICK_NEXT_BUTTON' });
    } catch (err) {
      console.warn('[matchRowsByBlogTitle] click next error', err);
      return false;
    }

    if (!clickResult || clickResult.isDisabled || !clickResult.success) {
      console.log('[matchRowsByBlogTitle] no more pages', clickResult);
      hasMorePages = false;
    } else {
      await clearLatestRecord();
    }
  }

  return rowIndexes.length === 0;
}

function tryFillIdsFromRecord(record, rowIndexes, idIndex, urlIndex) {
  try {
    const data = record.data || record;
    const edges = data?.data?.onlineStore?.articles?.edges || [];
    console.log('[tryFillIdsFromRecord] edgesCount=', edges.length, 'rowIndexes=', rowIndexes);
    for (const edge of edges) {
      const node = edge?.node || {};
      const relativePath = node.relativeStorefrontPath || '';
      const nodeId = extractIdFromGid(node.id);
      console.log('[tryFillIdsFromRecord] node.relativeStorefrontPath=', relativePath, 'node.id=', node.id, 'extractedId=', nodeId);
      if (!relativePath) continue;
      for (const i of rowIndexes) {
        const row = state.matching.csvRows[i];
        const url = row[urlIndex] || '';
        if (url.includes(relativePath)) {
          row[idIndex] = nodeId;
          state.matching.results[i] = 'success';
          console.log('[tryFillIdsFromRecord] matched! rowIndex=', i, 'id=', row[idIndex]);
        }
      }
    }
    saveMatchingState();
  } catch (e) {
    console.error('[tryFillIdsFromRecord] error', e);
  }
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

    const records = await waitForApiRecords('matchArticleId', 30000);
    const record = records.ArticleList;
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

let configCache = null;

async function loadConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    return await res.json();
  } catch (err) {
    console.warn('[loadConfig] 加载配置失败，使用默认配置', err);
    return {
      keywords: ['ArticleList', 'ArticleDetailsUpdate', 'ArticleDetails'],
      defaultChangeType: '替换',
      selectors: {},
      apiPatterns: {
        matchArticleId: { required: ['ArticleList'] },
        saveArticleTags: { required: ['ArticleDetailsUpdate', 'ArticleDetails'] },
      },
    };
  }
}

async function getConfig() {
  if (configCache) return configCache;
  configCache = await loadConfig();
  return configCache;
}

// 解析 URL 中是否包含某个 keyword
function urlContainsKeyword(url, keyword) {
  if (!url || !keyword) return false;
  return url.includes(keyword);
}

// 统一等待一组接口记录
async function waitForApiRecords(patternName, timeoutMs = 30000) {
  const config = await getConfig();
  const patterns = config.apiPatterns || {};
  const pattern = patterns[patternName];
  if (!pattern || !Array.isArray(pattern.required) || pattern.required.length === 0) {
    throw new Error(`未配置 apiPatterns.${patternName}`);
  }

  const required = pattern.required;
  const result = Object.fromEntries(required.map((key) => [key, null]));

  console.log(`[waitForApiRecords] pattern=${patternName} required=${JSON.stringify(required)}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const shouldStop = state.matching.shouldStop || state.tagging.shouldStop;
    if (shouldStop) return result;

    if (state.latestRecord) {
      const url = state.latestRecord.url || '';
      if (url.includes('admin.shopify.com/api/operations')) {
        for (const key of required) {
          if (!result[key] && url.includes(key)) {
            result[key] = state.latestRecord;
            console.log(`[waitForApiRecords] 捕获 ${key}`);
          }
        }
      }
      state.latestRecord = null;

      if (required.every((key) => result[key])) {
        console.log('[waitForApiRecords] 所有接口均已捕获');
        return result;
      }
    }
    await sleep(500);
  }
  console.log('[waitForApiRecords] 超时', result);
  return result;
}

function hasGraphQLError(data) {
  if (!data) return false;
  if (Array.isArray(data.errors) && data.errors.length > 0) return true;
  if (data.data && Array.isArray(data.data.errors) && data.data.errors.length > 0) return true;
  return false;
}

async function clearLatestRecord() {
  state.latestRecord = null;
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
      console.log('[startTaggingProcess] tag result JSON', JSON.stringify(result, null, 2));

      // 等待 3 秒，避免 Shopify 的 beforeunload 弹窗
      await sleep(3000);

      if (result && result.success) {
        tagging.results[i] = 'success';
        tagging.message = `已处理：文章 ${row.id}`;
        row.beforeTags = result.beforeTags || [];
        row.afterTags = result.afterTags || [];
        row.status = '已打标';
        console.log('[startTaggingProcess] success result row', i, 'rowIndex=', row.rowIndex, 'beforeTags=', row.beforeTags, 'afterTags=', row.afterTags);
      } else {
        tagging.results[i] = 'fail';
        tagging.message = `处理失败：文章 ${row.id}，${result?.error || '未知错误'}`;
        row.status = '未打标';
        console.log('[startTaggingProcess] fail error=', result?.error, 'rowIndex=', row.rowIndex);
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
