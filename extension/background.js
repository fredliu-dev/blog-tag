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
    chunks: [],
    currentIndex: 0,
    isRunning: false,
    shouldStop: false,
    step: 'idle',
    message: '就绪',
    results: [], // 'success' | 'fail' | null
    tabIds: [],
    workerResults: {}, // { tabId: { success/fail count } }
    workerProgress: {}, // { tabId: { workerIndex, currentRowId, message } }
    tabRecords: {}, // { tabId: [record] }
    completedWorkers: 0,
    totalWorkers: 0,
    tabId: null,
    failedRows: [], // 所有 worker 完成后汇总的失败行，用于手动重试
    isRetrying: false, // 是否处于等待用户手动重试的状态
    retryDone: false, // 是否已经执行过一次自动重试
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
    taggingChunks: state.tagging.chunks,
    taggingCurrentIndex: state.tagging.currentIndex,
    taggingStep: state.tagging.step,
    taggingMessage: state.tagging.message,
    taggingResults: state.tagging.results,
    taggingTabIds: state.tagging.tabIds,
    taggingWorkerProgress: state.tagging.workerProgress,
    taggingCompletedWorkers: state.tagging.completedWorkers,
    taggingTotalWorkers: state.tagging.totalWorkers,
    taggingTabId: state.tagging.tabId,
    taggingFailedRows: state.tagging.failedRows,
    taggingIsRetrying: state.tagging.isRetrying,
    taggingRetryDone: state.tagging.retryDone,
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
  const total = state.tagging.rows.length;
  const successCount = state.tagging.results.filter((r) => r === 'success').length;
  const failCount = state.tagging.results.filter((r) => r === 'fail').length;

  const workerMessages = Object.values(state.tagging.workerProgress || {})
    .sort((a, b) => (a.workerIndex || 0) - (b.workerIndex || 0))
    .map((p) => {
      const progress = p.total > 0 ? `${p.success}/${p.total}（失败 ${p.fail}）` : '';
      return {
        message: p.message || '准备中',
        progress,
      };
    });

  if (state.tagging.isRetrying) {
    workerMessages.push({
      message: `还有 ${state.tagging.failedRows.length} 条失败，请点击左侧重试按钮`,
      progress: '',
    });
  }

  return {
    isRunning: state.tagging.isRunning,
    step: state.tagging.step,
    message: state.tagging.message,
    currentIndex: successCount,
    total,
    successCount,
    failCount,
    results: state.tagging.results,
    tabIds: state.tagging.tabIds,
    completedWorkers: state.tagging.completedWorkers,
    totalWorkers: state.tagging.totalWorkers,
    workerMessages,
    isRetrying: state.tagging.isRetrying,
    failedRowsCount: state.tagging.failedRows.length,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_RECORD') {
    const record = message.record || {};
    const tabId = sender?.tab?.id;
    state.records.push(record);
    state.latestRecord = record;
    if (tabId) {
      if (!state.tagging.tabRecords[tabId]) {
        state.tagging.tabRecords[tabId] = [];
      }
      state.tagging.tabRecords[tabId].push(record);
      console.log('CAPTURE_RECORD', { tabId, queueSize: state.tagging.tabRecords[tabId].length, url: record.url });
    } else {
      console.log('CAPTURE_RECORD', record);
    }
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
    const chunks = message.chunks || [];
    const parallel = message.parallel || 1;
    state.tagging.rows = chunks.flat();
    state.tagging.chunks = chunks;
    state.tagging.currentIndex = 0;
    state.tagging.isRunning = true;
    state.tagging.shouldStop = false;
    state.tagging.step = 'idle';
    state.tagging.message = '开始打标签';
    state.tagging.results = new Array(state.tagging.rows.length).fill(null);
    state.tagging.tabIds = [];
    state.tagging.workerResults = {};
    state.tagging.workerProgress = {};
    state.tagging.tabRecords = {};
    state.tagging.completedWorkers = 0;
    state.tagging.totalWorkers = chunks.length;
    state.tagging.tabId = null;
    state.tagging.failedRows = [];
    state.tagging.isRetrying = false;
    state.tagging.retryDone = false;
    saveTaggingState();
    startTaggingProcess();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'RETRY_FAILED_TAGGING') {
    state.tagging.isRetrying = false;
    state.tagging.isRunning = true;
    state.tagging.shouldStop = false;
    state.tagging.step = 'retry';
    state.tagging.message = '开始重试失败的标签';
    saveTaggingState();
    retryFailedTagging();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_TAGGING') {
    state.tagging.shouldStop = true;
    if (!state.tagging.isRetrying) {
      state.tagging.step = 'idle';
      state.tagging.message = '已停止';
    } else {
      state.tagging.message = '重试已停止';
    }
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
  const config = await getConfig();
  const blogTitles = config.blogTitle || [];

  if (!Array.isArray(blogTitles) || blogTitles.length === 0) {
    matching.step = 'idle';
    matching.message = '配置中未设置 blogTitle';
    matching.isRunning = false;
    saveMatchingState();
    stopKeepAlive();
    return;
  }

  let idIndex = getColumnIndex(matching.csvHeaders, 'id');
  if (idIndex === -1) {
    matching.csvHeaders.push('id');
    idIndex = matching.csvHeaders.length - 1;
    for (let i = 0; i < matching.csvRows.length; i++) {
      matching.csvRows[i].push('');
    }
  }

  let changeTypeIndex = getColumnIndex(matching.csvHeaders, '修改类型');
  if (changeTypeIndex === -1) {
    matching.csvHeaders.push('修改类型');
    changeTypeIndex = matching.csvHeaders.length - 1;
    const defaultChangeType = config.defaultChangeType || '替换';
    for (let i = 0; i < matching.csvRows.length; i++) {
      matching.csvRows[i].push(defaultChangeType);
    }
  }

  // 确保所有行长度与表头一致
  for (let i = 0; i < matching.csvRows.length; i++) {
    while (matching.csvRows[i].length < matching.csvHeaders.length) {
      matching.csvRows[i].push('');
    }
  }

  const urlIndex = getColumnIndex(matching.csvHeaders, 'URL');
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

  // 所有未匹配的索引
  let rowIndexes = [];
  for (let i = 0; i < total; i++) {
    if (!matching.csvRows[i][idIndex]) {
      rowIndexes.push(i);
    }
  }

  console.log('[startMatchingProcess] blogTitles=', blogTitles, 'pendingRows=', rowIndexes.length);

  for (const blogTitle of blogTitles) {
    console.log('[startMatchingProcess] blogTitle=', blogTitle);
    if (matching.shouldStop) break;
    if (!blogTitle) continue;
    if (rowIndexes.length === 0) {
      console.log('[startMatchingProcess] all rows matched, stop iteration');
      break;
    }

    const pendingRows = rowIndexes.filter((i) => !matching.csvRows[i][idIndex]);
    if (pendingRows.length === 0) break;

    matching.step = 'capture';
    matching.currentTitle = blogTitle;
    matching.currentIndex = pendingRows[0];
    matching.message = `正在匹配 blog：${blogTitle}，剩余 ${pendingRows.length} 条`;
    saveMatchingState();

    const allMatched = await matchRowsByBlogTitle(shopifyTab.id, blogTitle, pendingRows, idIndex, urlIndex);
    console.log('[matchRowsByBlogTitle] allMatched=', allMatched, 'blogTitle=', blogTitle, 'remaining=', pendingRows.length);

    // 更新剩余未匹配索引
    rowIndexes = rowIndexes.filter((i) => !matching.csvRows[i][idIndex]);
  }

  // 补齐状态
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

    const records = await waitForApiRecords('matchArticleId', tabId, 30000);
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
      blogTitle: ['Blog', 'Stories', 'Ambassadors', 'Events', 'Press', 'Support', 'Guides', 'Newsroom'],
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
async function waitForApiRecords(patternName, tabId, timeoutMs = 30000) {
  const config = await getConfig();
  const patterns = config.apiPatterns || {};
  const pattern = patterns[patternName];
  if (!pattern || !Array.isArray(pattern.required) || pattern.required.length === 0) {
    throw new Error(`未配置 apiPatterns.${patternName}`);
  }

  const required = pattern.required;
  const result = Object.fromEntries(required.map((key) => [key, null]));

  console.log(`[waitForApiRecords] pattern=${patternName} tabId=${tabId} required=${JSON.stringify(required)}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const shouldStop = state.matching.shouldStop || state.tagging.shouldStop;
    if (shouldStop) return result;

    const queue = tabId ? state.tagging.tabRecords[tabId] : [];
    if (Array.isArray(queue) && queue.length > 0) {
      while (queue.length > 0) {
        const record = queue.shift();
        const url = record.url || '';
        if (url.includes('admin.shopify.com/api/operations')) {
          for (const key of required) {
            if (!result[key] && url.includes(key)) {
              result[key] = record;
              console.log(`[waitForApiRecords] tab=${tabId} 捕获 ${key}`);
            }
          }
        }
      }

      if (required.every((key) => result[key])) {
        console.log('[waitForApiRecords] 所有接口均已捕获');
        return result;
      }
    }

    // fallback: 单 tab 兼容模式
    if (!tabId && state.latestRecord) {
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

async function getOrCreateShopifyTab(createNew = false) {
  if (!createNew) {
    const tabs = await chrome.tabs.query({ url: 'https://admin.shopify.com/store/aftershokz-com/*' });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      return tabs[0];
    }
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: 'https://admin.shopify.com/store/aftershokz-com/', active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tab || !tab.id) {
        reject(new Error('创建标签页失败：返回的 tab 无效'));
        return;
      }
      resolve(tab);
    });
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let resolved = false;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolved = true;
        // Shopify 是 SPA，status complete 后 React 组件仍在初始化，多等一会儿
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);

    const checkStop = setInterval(() => {
      if (state.tagging.shouldStop && !resolved) {
        clearInterval(checkStop);
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 500);
  });
}

async function startTaggingProcess() {
  startKeepAlive();
  const tagging = state.tagging;
  const chunks = tagging.chunks;

  if (!chunks || chunks.length === 0) {
    tagging.step = 'idle';
    tagging.message = '没有可处理的标签数据';
    tagging.isRunning = false;
    tagging.isRetrying = false;
    saveTaggingState();
    stopKeepAlive();
    return;
  }

  // 创建并行 tab
  const tabPromises = chunks.map(async (chunk, index) => {
    try {
      const tab = await getOrCreateShopifyTab(true);
      tagging.tabIds.push(tab.id);
      tagging.workerResults[tab.id] = { success: 0, fail: 0 };
      tagging.workerProgress[tab.id] = {
        workerIndex: index,
        total: chunk.length,
        success: 0,
        fail: 0,
        currentRowId: '',
        message: `Worker ${index + 1} 准备中`,
      };
      tagging.tabRecords[tab.id] = [];
      return { tabId: tab.id, chunk, index };
    } catch (err) {
      console.error('[startTaggingProcess] 创建 tab 失败', err);
      return null;
    }
  });

  const workers = (await Promise.all(tabPromises)).filter(Boolean);
  tagging.totalWorkers = workers.length;

  if (workers.length === 0) {
    tagging.step = 'idle';
    tagging.message = '无法创建 Shopify 标签页';
    tagging.isRunning = false;
    tagging.isRetrying = false;
    saveTaggingState();
    stopKeepAlive();
    return;
  }

  saveTaggingState();

  // 并行启动所有 worker，并收集各自的失败行
  const workerResults = await Promise.all(workers.map((worker) => runTaggingWorker(worker.tabId, worker.chunk, worker.index)));

  // 汇总所有失败行
  const allFailedRows = [];
  for (const failedRows of workerResults) {
    if (failedRows && failedRows.length > 0) {
      allFailedRows.push(...failedRows);
    }
  }
  tagging.failedRows = allFailedRows;
  saveTaggingState();

  if (allFailedRows.length === 0 || tagging.shouldStop) {
    finishTagging();
    return;
  }

  // 所有 worker 完成后，统一创建一个重试 worker 自动重试一次
  tagging.message = '正在重试失败的标签...';
  tagging.step = 'retry';
  saveTaggingState();

  await retryFailedTagging(true);

  // 自动重试后如果还有失败，进入等待用户手动重试状态
  if (tagging.failedRows.length > 0 && !tagging.shouldStop) {
    tagging.isRetrying = true;
    tagging.isRunning = false;
    tagging.step = 'retry';
    tagging.message = `还有 ${tagging.failedRows.length} 条失败，请点击左侧重试按钮`;
    saveTaggingState();
    stopKeepAlive();
    return;
  }

  finishTagging();
}

async function retryFailedTagging(isAuto = false) {
  const tagging = state.tagging;
  if (tagging.shouldStop) return;

  let failedRows = tagging.failedRows;
  if (!failedRows || failedRows.length === 0) {
    return;
  }

  // 重置失败行的状态，准备重试
  failedRows.forEach((row) => {
    tagging.results[row.rowIndex] = null;
    row.status = '';
  });

  // 创建专门处理失败行的重试 worker
  let retryTab;
  try {
    retryTab = await getOrCreateShopifyTab(true);
  } catch (err) {
    console.error('[retryFailedTagging] 创建重试 tab 失败', err);
    return;
  }

  tagging.tabIds.push(retryTab.id);
  const retryWorkerIndex = tagging.totalWorkers;
  tagging.workerResults[retryTab.id] = { success: 0, fail: 0 };
  tagging.workerProgress[retryTab.id] = {
    workerIndex: retryWorkerIndex,
    total: failedRows.length,
    success: 0,
    fail: 0,
    currentRowId: '',
    message: '重试 Worker 准备中',
  };
  tagging.tabRecords[retryTab.id] = [];
  saveTaggingState();

  const retryFailedRows = await runTaggingWorker(retryTab.id, failedRows, retryWorkerIndex);
  tagging.failedRows = retryFailedRows;

  const res = tagging.workerResults[retryTab.id];
  tagging.workerProgress[retryTab.id] = {
    workerIndex: retryWorkerIndex,
    total: failedRows.length,
    success: res.success,
    fail: retryFailedRows.length,
    currentRowId: '',
    message: `重试 Worker 完成：成功 ${res.success}，失败 ${retryFailedRows.length}`,
  };
  saveTaggingState();

  if (!isAuto) {
    // 手动重试结束后，如果还有失败则继续等待用户，否则完成
    if (tagging.failedRows.length > 0) {
      tagging.isRetrying = true;
      tagging.isRunning = false;
      tagging.step = 'retry';
      tagging.message = `还有 ${tagging.failedRows.length} 条失败，请点击左侧重试按钮`;
      saveTaggingState();
      stopKeepAlive();
    } else {
      finishTagging();
    }
  }
}

function finishTagging() {
  const tagging = state.tagging;
  tagging.step = 'done';
  tagging.message = '打标签完成';
  tagging.isRunning = false;
  tagging.isRetrying = false;
  tagging.currentIndex = tagging.results.filter((r) => r === 'success').length;
  saveTaggingState();
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

async function runTaggingWorker(tabId, chunk, workerIndex) {
  const tagging = state.tagging;
  const failedRows = [];
  for (let i = 0; i < chunk.length; i++) {
    if (tagging.shouldStop) {
      // 停止时把剩余未处理的行也标记为失败，保证后续可以重试
      for (let j = i; j < chunk.length; j++) {
        const remainingRow = chunk[j];
        if (tagging.results[remainingRow.rowIndex] !== 'success') {
          tagging.results[remainingRow.rowIndex] = 'fail';
          tagging.workerResults[tabId].fail += 1;
          tagging.workerProgress[tabId].fail += 1;
          failedRows.push(remainingRow);
        }
      }
      break;
    }

    const row = chunk[i];
    tagging.step = 'process';
    tagging.message = '正在打标签...';
    tagging.workerProgress[tabId] = {
      workerIndex,
      total: tagging.workerProgress[tabId].total,
      success: tagging.workerResults[tabId].success,
      fail: tagging.workerResults[tabId].fail,
      currentRowId: row.id,
      message: `Worker ${workerIndex + 1} 正在打标签：文章 ${row.id}`,
    };
    console.log(`[runTaggingWorker] worker=${workerIndex} tab=${tabId} start row`, i, 'id=', row.id, 'row=', row);
    saveTaggingState();

    const url = `https://admin.shopify.com/store/aftershokz-com/content/articles/${row.id}`;
    try {
      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId);

      console.log('[runTaggingWorker] send TAG_ROW to tab', tabId, 'row=', row);
      const globalTotal = tagging.rows.length;
      const globalSuccess = tagging.results.filter((r) => r === 'success').length;
      const globalFail = tagging.results.filter((r) => r === 'fail').length;
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'TAG_ROW',
        row,
        workerIndex,
        workerTotal: tagging.totalWorkers,
        workerProgress: {
          total: tagging.workerProgress[tabId].total,
          success: tagging.workerProgress[tabId].success,
          fail: tagging.workerProgress[tabId].fail,
        },
        globalProgress: {
          total: globalTotal,
          success: globalSuccess,
          fail: globalFail,
        },
      });
      console.log('[runTaggingWorker] tag result', result, 'for row', row);

      // 等待 500ms，让页面状态稳定后再跳转
      await sleep(500);

      if (result && result.success) {
        tagging.results[row.rowIndex] = 'success';
        tagging.message = '正在打标签...';
        row.beforeTags = result.beforeTags || [];
        row.afterTags = result.afterTags || [];
        row.status = '已打标';
        tagging.workerResults[tabId].success += 1;
        tagging.workerProgress[tabId].success += 1;
        console.log('[runTaggingWorker] success row', row.rowIndex, 'beforeTags=', row.beforeTags, 'afterTags=', row.afterTags);
      } else {
        tagging.results[row.rowIndex] = 'fail';
        tagging.message = '正在打标签...';
        row.status = '未打标';
        tagging.workerResults[tabId].fail += 1;
        tagging.workerProgress[tabId].fail += 1;
        failedRows.push(row);
        console.log('[runTaggingWorker] fail error=', result?.error, 'rowIndex=', row.rowIndex);
      }
    } catch (err) {
      console.error('[runTaggingWorker] error', err);
      tagging.results[row.rowIndex] = 'fail';
      tagging.message = '正在打标签...';
      row.status = '未打标';
      tagging.workerResults[tabId].fail += 1;
      tagging.workerProgress[tabId].fail += 1;
      failedRows.push(row);
    }
    tagging.currentIndex = tagging.results.filter((r) => r === 'success').length;
    saveTaggingState();
  }
  tagging.completedWorkers += 1;
  const res = tagging.workerResults[tabId];
  tagging.workerProgress[tabId] = {
    workerIndex,
    total: tagging.workerProgress[tabId].total,
    success: res.success,
    fail: res.fail,
    currentRowId: '',
    message: `Worker ${workerIndex + 1} 完成：成功 ${res.success}，失败 ${res.fail}`,
  };
  saveTaggingState();
  console.log(`[runTaggingWorker] worker=${workerIndex} tab=${tabId} done`, tagging.workerResults[tabId]);
  return failedRows;
}

// 启动时恢复状态
chrome.storage.local.get([
  'matchingCsvHeaders', 'matchingCsvRows', 'matchingCurrentIndex', 'matchingStep',
  'matchingCurrentTitle', 'matchingMessage', 'matchingResults',
  'taggingRows', 'taggingChunks', 'taggingCurrentIndex', 'taggingStep', 'taggingMessage',
  'taggingResults', 'taggingTabIds', 'taggingCompletedWorkers', 'taggingTotalWorkers',
  'taggingWorkerProgress', 'taggingTabId', 'taggingFailedRows', 'taggingIsRetrying', 'taggingRetryDone',
], (result) => {
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
    state.tagging.chunks = result.taggingChunks || [];
    state.tagging.currentIndex = result.taggingCurrentIndex || 0;
    state.tagging.step = result.taggingStep || 'idle';
    state.tagging.message = result.taggingMessage || '就绪';
    state.tagging.results = result.taggingResults || [];
    state.tagging.tabIds = result.taggingTabIds || [];
    state.tagging.completedWorkers = result.taggingCompletedWorkers || 0;
    state.tagging.totalWorkers = result.taggingTotalWorkers || 0;
    state.tagging.workerProgress = result.taggingWorkerProgress || {};
    state.tagging.tabId = result.taggingTabId || null;
    state.tagging.failedRows = result.taggingFailedRows || [];
    state.tagging.isRetrying = result.taggingIsRetrying || false;
    state.tagging.retryDone = result.taggingRetryDone || false;
    state.tagging.isRunning = false;
    state.tagging.shouldStop = false;
    saveTaggingState();
  }
});
