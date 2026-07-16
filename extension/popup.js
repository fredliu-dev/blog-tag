document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('csvFile');
  const fileLabel = document.getElementById('fileLabel');
  const fileCard = document.getElementById('fileCard');
  const fileNameEl = document.getElementById('fileName');
  const removeFileBtn = document.getElementById('removeFile');
  const processBtn = document.getElementById('process');
  const matchBtn = document.getElementById('match');
  const exportBtn = document.getElementById('export');
  const tagBtn = document.getElementById('tag');
  const stopBtn = document.getElementById('stop');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const statusStepEl = document.getElementById('statusStep');
  const statusTitleEl = document.getElementById('statusTitle');

  let originalFileName = '';
  let originalFileContent = '';
  let csvHeaders = [];
  let csvRows = [];
  let isProcessed = false;
  let popupCurrentAction = '';
  let statusTimer = null;
  let extensionConfig = { defaultChangeType: '替换' };

  async function loadExtensionConfig() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const res = await fetch(url);
      const config = await res.json();
      extensionConfig = {
        defaultChangeType: config.defaultChangeType || '替换',
      };
    } catch {
      extensionConfig = { defaultChangeType: '替换' };
    }
  }

  function savePopupState() {
    chrome.storage.local.set({
      popupOriginalFileName: originalFileName,
      popupOriginalFileContent: originalFileContent,
      popupCsvHeaders: csvHeaders,
      popupCsvRows: csvRows,
      popupIsProcessed: isProcessed,
      popupCurrentAction,
    });
  }

  function clearPopupState() {
    return chrome.storage.local.remove([
      'popupOriginalFileName',
      'popupOriginalFileContent',
      'popupCsvHeaders',
      'popupCsvRows',
      'popupIsProcessed',
      'popupCurrentAction',
      'matchingCsvHeaders',
      'matchingCsvRows',
      'matchingCurrentIndex',
      'matchingStep',
      'matchingCurrentTitle',
      'matchingMessage',
      'matchingResults',
      'taggingRows',
      'taggingCurrentIndex',
      'taggingStep',
      'taggingMessage',
      'taggingResults',
      'taggingTabId',
    ]);
  }

  async function loadPopupState() {
    const stored = await chrome.storage.local.get([
      'popupOriginalFileName',
      'popupOriginalFileContent',
      'popupCsvHeaders',
      'popupCsvRows',
      'popupIsProcessed',
      'popupCurrentAction',
    ]);
    if (stored.popupOriginalFileName && stored.popupOriginalFileContent) {
      originalFileName = stored.popupOriginalFileName;
      originalFileContent = stored.popupOriginalFileContent;
      processBtn.disabled = false;
      showFileCard(originalFileName);
    }
    if (stored.popupCsvHeaders && stored.popupCsvRows) {
      csvHeaders = stored.popupCsvHeaders;
      csvRows = stored.popupCsvRows;
      isProcessed = !!stored.popupIsProcessed;
      matchBtn.disabled = false;
      exportBtn.disabled = !isProcessed;
      tagBtn.disabled = !canTag();
      // 静默恢复，不覆盖状态提示
    }
    return stored.popupCurrentAction || '';
  }

  function toTitleCase(str) {
    if (!str) return '';
    return str.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  // 尝试用 UTF-8 解码，如果失败则回退到 GBK（中文 Windows 常见编码）
  function decodeBuffer(buffer) {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      return utf8Decoder.decode(buffer);
    } catch {
      return new TextDecoder('gbk').decode(buffer);
    }
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(decodeBuffer(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return { headers: [], rows: [] };
    let headers = parseLine(lines[0]);
    while (headers.length > 0 && headers[headers.length - 1] === '') {
      headers.pop();
    }
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      const row = parseLine(lines[i]);
      while (row.length > headers.length) row.pop();
      while (row.length < headers.length) row.push('');
      // 过滤所有字段都为空的行
      if (row.every((cell) => cell.trim() === '')) continue;
      rows.push(row);
    }
    return { headers, rows };
  }

  function parseLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  function serializeCSV(headers, rows) {
    const lines = [serializeLine(headers)];
    rows.forEach((row) => lines.push(serializeLine(row)));
    return lines.join('\n') + '\n';
  }

  function serializeLine(fields) {
    return fields.map((field) => {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',');
  }

  function getColumnIndex(name) {
    return csvHeaders.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  }

  function ensureTagResultColumns() {
    const columns = ['打标前 tag', '打标后 tag', '打标情况'];
    columns.forEach((col) => {
      if (getColumnIndex(col) === -1) {
        csvHeaders.push(col);
        csvRows.forEach((row) => row.push(''));
      }
    });
  }

  async function resetState() {
    originalFileName = '';
    originalFileContent = '';
    csvHeaders = [];
    csvRows = [];
    isProcessed = false;
    fileInput.value = '';
    await clearPopupState();

    fileLabel.style.display = 'block';
    fileCard.style.display = 'none';
    fileNameEl.textContent = '';

    matchBtn.disabled = true;
    processBtn.disabled = true;
    exportBtn.disabled = true;
    tagBtn.disabled = true;
    stopBtn.disabled = true;
    progressContainer.style.display = 'none';
    progressBar.innerHTML = '';
    progressText.textContent = '0 / 0';
    setStatus('idle', '请选择 CSV 文件');
  }

  function showFileCard(name) {
    originalFileName = name;
    fileNameEl.textContent = name;
    fileLabel.style.display = 'none';
    fileCard.style.display = 'flex';
    exportBtn.disabled = !isProcessed;
    tagBtn.disabled = !canTag();
    progressContainer.style.display = 'none';
  }

  function canTag() {
    const idIndex = getColumnIndex('id');
    const tagIndex = getColumnIndex('标签');
    return isProcessed && idIndex !== -1 && tagIndex !== -1 && csvRows.length > 0;
  }

  function setStatus(step, title) {
    statusStepEl.className = 'status-step';
    statusStepEl.classList.add(step);
    const stepLabels = {
      idle: '就绪',
      capture: '捕获接口',
      success: '捕获成功',
      process: '处理数据',
      done: '完成',
      'process-csv': '处理 CSV',
      'match-id': '匹配 ID',
      tagging: '打标签',
    };
    statusStepEl.textContent = stepLabels[step] || '就绪';
    statusTitleEl.textContent = title || '';
  }

  function updateProgress(current, total, results = []) {
    progressContainer.style.display = 'block';

    const effectiveCompleted = results && results.length > 0
      ? results.filter((r) => r === 'success' || r === 'fail').length
      : current;
    progressText.textContent = `${effectiveCompleted} / ${total}`;

    if (!results || results.length === 0) {
      progressBar.innerHTML = '';
      const progress = document.createElement('div');
      progress.className = 'progress-fill';
      progress.style.width = total > 0 ? `${(current / total) * 100}%` : '0%';
      progressBar.appendChild(progress);
      return;
    }

    const successCount = results.filter((r) => r === 'success').length;
    const failCount = results.filter((r) => r === 'fail').length;
    const pendingCount = total - successCount - failCount;

    progressBar.innerHTML = '';
    if (successCount > 0) {
      const el = document.createElement('div');
      el.className = 'progress-segment success';
      el.style.width = `${(successCount / total) * 100}%`;
      progressBar.appendChild(el);
    }
    if (failCount > 0) {
      const el = document.createElement('div');
      el.className = 'progress-segment fail';
      el.style.width = `${(failCount / total) * 100}%`;
      progressBar.appendChild(el);
    }
    if (pendingCount > 0) {
      const el = document.createElement('div');
      el.className = 'progress-segment pending';
      el.style.width = `${(pendingCount / total) * 100}%`;
      progressBar.appendChild(el);
    }
  }

  function startStatusPolling() {
    if (statusTimer) return;
    statusTimer = setInterval(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'GET_MATCHING_STATUS' });
      if (!status) return;
      const step = status.isRunning ? 'match-id' : (status.step === 'done' ? 'match-id' : status.step);
      setStatus(step, status.message || status.currentTitle);
      updateProgress(status.currentIndex, status.total, status.results);
      if (!status.isRunning && status.step === 'done') {
        stopStatusPolling();
        popupCurrentAction = '';

        const result = await chrome.runtime.sendMessage({ type: 'GET_MATCHING_RESULT' });
        if (result) {
          if (result.csvHeaders) csvHeaders = result.csvHeaders;
          if (result.csvRows) csvRows = result.csvRows;
          isProcessed = true;
          savePopupState();
        }

        matchBtn.disabled = false;
        stopBtn.disabled = true;
        exportBtn.disabled = false;
        processBtn.disabled = false;
        tagBtn.disabled = !canTag();
      }
    }, 500);
  }

  function startTaggingStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'GET_TAGGING_STATUS' });
      if (!status) return;
      const step = status.isRunning ? 'tagging' : (status.step === 'done' ? 'tagging' : status.step);
      setStatus(step, status.message);
      if (status.total > 0) {
        updateProgress(status.currentIndex, status.total, status.results || []);
      }
      if (!status.isRunning) {
        stopStatusPolling();
        popupCurrentAction = '';

        console.log('[startTaggingStatusPolling] tagging done, fetch result');
        const result = await chrome.runtime.sendMessage({ type: 'GET_TAGGING_RESULT' });
        console.log('[startTaggingStatusPolling] result=', result);
        if (result && result.rows) {
          const beforeIndex = getColumnIndex('打标前 tag');
          const afterIndex = getColumnIndex('打标后 tag');
          const statusIndex = getColumnIndex('打标情况');
          console.log('[startTaggingStatusPolling] column indexes', { beforeIndex, afterIndex, statusIndex });
          result.rows.forEach((row) => {
            console.log('[startTaggingStatusPolling] process row', row);
            const idx = row.rowIndex;
            if (idx == null || idx < 0 || idx >= csvRows.length) {
              console.log('[startTaggingStatusPolling] skip row, invalid idx', idx, 'csvRows.length=', csvRows.length);
              return;
            }
            if (beforeIndex !== -1) {
              csvRows[idx][beforeIndex] = (row.beforeTags || []).join(', ');
            }
            if (afterIndex !== -1) {
              csvRows[idx][afterIndex] = (row.afterTags || []).join(', ');
            }
            if (statusIndex !== -1) {
              csvRows[idx][statusIndex] = row.status || '';
            }
            console.log('[startTaggingStatusPolling] wrote csvRows[', idx, ']=', csvRows[idx]);
          });
          savePopupState();
          console.log('[startTaggingStatusPolling] savePopupState done');
        }

        processBtn.disabled = false;
        matchBtn.disabled = false;
        exportBtn.disabled = false;
        tagBtn.disabled = !canTag();
        stopBtn.disabled = true;
      }
    }, 500);
  }

  function stopStatusPolling() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (file) {
      // 清空旧数据，避免新文件受到缓存影响
      originalFileName = '';
      originalFileContent = '';
      csvHeaders = [];
      csvRows = [];
      isProcessed = false;
      await clearPopupState();

      originalFileName = file.name;
      originalFileContent = await readFileAsText(file);
      isProcessed = false;

      // 解析原始数据
      const parsed = parseCSV(originalFileContent);
      csvHeaders = parsed.headers;
      csvRows = parsed.rows;

      processBtn.disabled = false;
      exportBtn.disabled = true;
      showFileCard(file.name);
      setStatus('process-csv', '文件已选择，点击“处理 CSV”开始处理');
      savePopupState();

      // 校验是否包含 blog_title 和 Title 列，决定是否启用匹配 ID
      const hasBlogTitle = getColumnIndex('blog_title') !== -1;
      const hasTitle = getColumnIndex('Title') !== -1;
      matchBtn.disabled = !(hasBlogTitle && hasTitle && csvRows.length > 0);

      // 如果有 URL 列，自动处理
      const urlIndex = getColumnIndex('URL');
      if (urlIndex !== -1) {
        progressContainer.style.display = 'block';
        setStatus('process-csv', '正在读取 CSV...');
        popupCurrentAction = 'process-csv';
        savePopupState();
        const ok = await processCSV();
        popupCurrentAction = '';
        savePopupState();
        if (ok) {
          isProcessed = true;
          setStatus('process-csv', `处理完成：共 ${csvRows.length} 行数据`);
        }
        progressContainer.style.display = 'none';
      }

      exportBtn.disabled = !isProcessed;
      tagBtn.disabled = !canTag();
    } else {
      resetState();
    }
  });

  removeFileBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_MATCHING' });
    await chrome.runtime.sendMessage({ type: 'STOP_TAGGING' });
    await chrome.runtime.sendMessage({ type: 'CLEAR_RECORDS' });
    resetState();
  });

  async function processCSV() {
    const parsed = parseCSV(originalFileContent);
    csvHeaders = parsed.headers;
    csvRows = parsed.rows;

    const urlIndex = getColumnIndex('URL');
    if (urlIndex === -1) {
      setStatus('idle', '未找到 URL 列');
      return false;
    }

    // 只保留标题非空的列
    const validIndexes = csvHeaders
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.trim() !== '')
      .map(({ i }) => i);

    csvHeaders = validIndexes.map((i) => csvHeaders[i]);
    for (let i = 0; i < csvRows.length; i++) {
      csvRows[i] = validIndexes.map((idx) => csvRows[i][idx] || '');
    }

    // 重新计算 URL 索引，并插入 blog_title / Title
    const newUrlIndex = csvHeaders.findIndex((h) => h.trim().toLowerCase() === 'url');
    let blogTitleIndex = getColumnIndex('blog_title');
    let titleIndex = getColumnIndex('Title');
    if (blogTitleIndex === -1 || titleIndex === -1) {
      csvHeaders.splice(newUrlIndex + 1, 0, 'blog_title', 'Title');
      blogTitleIndex = newUrlIndex + 1;
      titleIndex = newUrlIndex + 2;
      for (let i = 0; i < csvRows.length; i++) {
        csvRows[i].splice(newUrlIndex + 1, 0, '', '');
      }
    }

    // 确保存在“修改类型”列，不存在则添加并填充默认值
    let changeTypeIndex = getColumnIndex('修改类型');
    if (changeTypeIndex === -1) {
      csvHeaders.push('修改类型');
      changeTypeIndex = csvHeaders.length - 1;
      for (let i = 0; i < csvRows.length; i++) {
        csvRows[i].push(extensionConfig.defaultChangeType);
      }
    }

    const total = csvRows.length;
    for (let i = 0; i < total; i++) {
      const row = csvRows[i];
      const url = row[newUrlIndex] || '';
      let blogTitle = '';
      let title = '';
      try {
        const pathname = new URL(url).pathname.replace(/\/$/, '');
        const segments = pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1] || '';
        const secondLast = segments[segments.length - 2] || '';
        blogTitle = toTitleCase(secondLast);
        title = last;
      } catch (e) {}
      row[blogTitleIndex] = blogTitle;
      row[titleIndex] = title;
      updateProgress(i + 1, total);
      setStatus('process-csv', `正在处理：${title || url}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return true;
  }

  processBtn.addEventListener('click', async () => {
    if (!originalFileContent) {
      setStatus('idle', '请先选择 CSV 文件');
      return;
    }

    processBtn.disabled = true;
    exportBtn.disabled = true;
    progressContainer.style.display = 'block';
    setStatus('process-csv', '正在读取 CSV...');
    popupCurrentAction = 'process-csv';
    savePopupState();

    const ok = await processCSV();
    if (!ok) {
      popupCurrentAction = '';
      savePopupState();
      processBtn.disabled = false;
      progressContainer.style.display = 'none';
      return;
    }

    isProcessed = true;
    popupCurrentAction = '';
    savePopupState();
    await chrome.runtime.sendMessage({
      type: 'SET_MATCHING_RESULT',
      csvHeaders,
      csvRows,
    });
    setStatus('process-csv', `处理完成：共 ${csvRows.length} 行数据`);
    chrome.notifications.create('process-csv-done', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '处理 CSV 完成',
      message: `共处理 ${csvRows.length} 行数据，可以进行匹配 ID 了`,
    });
    processBtn.disabled = false;
    matchBtn.disabled = false;
    exportBtn.disabled = false;
    tagBtn.disabled = !canTag();
  });

  matchBtn.addEventListener('click', async () => {
    if (csvRows.length === 0) return;

    const hasUrl = getColumnIndex('URL') !== -1;
    const hasBlogTitle = getColumnIndex('blog_title') !== -1;
    const hasTitle = getColumnIndex('Title') !== -1;
    if (!hasUrl || !hasBlogTitle || !hasTitle) {
      alert('请先处理 CSV，确保包含 URL、blog_title 和 Title 三列');
      return;
    }

    processBtn.disabled = true;
    exportBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('match-id', '开始匹配...');
    popupCurrentAction = 'match-id';
    savePopupState();

    await chrome.runtime.sendMessage({
      type: 'START_MATCHING',
      csvHeaders,
      csvRows,
    });

    startStatusPolling();
  });

  stopBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_MATCHING' });
    await chrome.runtime.sendMessage({ type: 'STOP_TAGGING' });
    stopStatusPolling();
    popupCurrentAction = '';
    savePopupState();
    processBtn.disabled = false;
    matchBtn.disabled = false;
    exportBtn.disabled = !isProcessed;
    tagBtn.disabled = !canTag();
    stopBtn.disabled = true;
    setStatus('idle', '已停止');
  });

  tagBtn.addEventListener('click', async () => {
    const idIndex = getColumnIndex('id');
    const tagIndex = getColumnIndex('标签');
    const changeTypeIndex = getColumnIndex('修改类型');
    if (idIndex === -1 || tagIndex === -1) {
      alert('CSV 中需要包含 id 和 标签 列');
      return;
    }

    ensureTagResultColumns();

    const tagRows = csvRows
      .map((row, rowIndex) => {
        const id = row[idIndex]?.trim();
        const tagsText = row[tagIndex] || '';
        const changeType = changeTypeIndex >= 0 ? (row[changeTypeIndex] || '').trim() : '';
        if (!id || !tagsText) return null;
        return {
          id,
          tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
          changeType,
          rowIndex,
        };
      })
      .filter(Boolean);

    if (tagRows.length === 0) {
      alert('没有可处理的标签数据');
      return;
    }

    processBtn.disabled = true;
    matchBtn.disabled = true;
    exportBtn.disabled = true;
    tagBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('tagging', '开始打标签...');
    popupCurrentAction = 'tagging';
    savePopupState();

    await chrome.runtime.sendMessage({
      type: 'START_TAGGING',
      rows: tagRows,
    });

    startTaggingStatusPolling();
  });

  exportBtn.addEventListener('click', async () => {
    if (!csvHeaders.length || !csvRows.length) return;
    const csv = serializeCSV(csvHeaders, csvRows);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const baseName = originalFileName.replace(/\.csv$/i, '') || 'processed';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}-matched-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('done', '导出成功');
  });

  // 弹窗打开时，恢复状态并检查后台任务
  loadExtensionConfig().then(() => {
    loadPopupState().then((action) => {
      popupCurrentAction = action;
      stopBtn.disabled = true;

      if (popupCurrentAction === 'process-csv') {
        processBtn.disabled = true;
        exportBtn.disabled = true;
        progressContainer.style.display = 'block';
        setStatus('process-csv', '正在恢复处理 CSV...');
        (async () => {
          const ok = await processCSV();
          if (!ok) {
            popupCurrentAction = '';
            savePopupState();
            processBtn.disabled = false;
            progressContainer.style.display = 'none';
            return;
          }
          isProcessed = true;
          popupCurrentAction = '';
          savePopupState();
          await chrome.runtime.sendMessage({
            type: 'SET_MATCHING_RESULT',
            csvHeaders,
            csvRows,
          });
          setStatus('process-csv', `处理完成：共 ${csvRows.length} 行数据`);
          processBtn.disabled = false;
          matchBtn.disabled = false;
          exportBtn.disabled = false;
          tagBtn.disabled = !canTag();
        })();
        return;
      }

      chrome.runtime.sendMessage({ type: 'GET_MATCHING_STATUS' }).then((status) => {
        if (status && status.isRunning) {
          processBtn.disabled = true;
          exportBtn.disabled = true;
          stopBtn.disabled = false;
          popupCurrentAction = 'match-id';
          savePopupState();
          startStatusPolling();
          return;
        }
        chrome.runtime.sendMessage({ type: 'GET_TAGGING_STATUS' }).then((tagStatus) => {
          if (tagStatus && tagStatus.isRunning) {
            processBtn.disabled = true;
            matchBtn.disabled = true;
            exportBtn.disabled = true;
            tagBtn.disabled = true;
            stopBtn.disabled = false;
            popupCurrentAction = 'tagging';
            savePopupState();
            startTaggingStatusPolling();
          } else if (csvRows.length > 0) {
            // 没有运行中任务但已有数据，显示默认就绪状态
            setStatus('idle', '就绪');
          }
        });
      });
    });
  });
});
