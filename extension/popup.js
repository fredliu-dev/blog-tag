document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('csvFile');
  const fileLabel = document.getElementById('fileLabel');
  const fileCard = document.getElementById('fileCard');
  const fileNameEl = document.getElementById('fileName');
  const removeFileBtn = document.getElementById('removeFile');
  const matchBtn = document.getElementById('match');
  const exportBtn = document.getElementById('export');
  const parallelSelect = document.getElementById('parallelCount');
  const parallelDec = document.getElementById('parallelDec');
  const parallelInc = document.getElementById('parallelInc');
  const tagBtn = document.getElementById('tag');
  const stopBtn = document.getElementById('stop');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const statusStepEl = document.getElementById('statusStep');
  const statusTitleEl = document.getElementById('statusTitle');
  const statusHeaderEl = document.getElementById('statusHeader');
  const statusEmptyEl = document.getElementById('statusEmpty');
  const workerListEl = document.getElementById('workerList');

  let originalFileName = '';
  let originalFileContent = '';
  let csvHeaders = [];
  let csvRows = [];
  let isProcessed = false;
  let popupCurrentAction = '';
  let statusTimer = null;
  let extensionConfig = { defaultChangeType: '替换', maxParallelTabs: 4 };
  let parallelCount = 1;

  async function loadExtensionConfig() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const res = await fetch(url);
      const config = await res.json();
      extensionConfig = {
        defaultChangeType: config.defaultChangeType || '替换',
        maxParallelTabs: Math.max(1, config.maxParallelTabs || 4),
      };
      updateParallelSelectOptions();
    } catch {
      extensionConfig = { defaultChangeType: '替换', maxParallelTabs: 4 };
      updateParallelSelectOptions();
    }
  }

  function updateParallelSelectOptions() {
    const max = extensionConfig.maxParallelTabs || 4;
    parallelSelect.max = String(max);
    parallelSelect.min = '1';
    parallelSelect.value = String(Math.min(parallelCount, max));
  }

  function setParallelEnabled(enabled) {
    parallelSelect.disabled = !enabled;
    parallelDec.disabled = !enabled;
    parallelInc.disabled = !enabled;
  }

  function clampParallelValue(rawValue) {
    const max = extensionConfig.maxParallelTabs || 4;
    let value = Number(rawValue) || 1;
    return Math.max(1, Math.min(max, value));
  }

  parallelSelect.addEventListener('input', () => {
    const value = clampParallelValue(parallelSelect.value);
    parallelSelect.value = String(value);
    parallelCount = value;
  });

  parallelSelect.addEventListener('blur', () => {
    const value = clampParallelValue(parallelSelect.value);
    parallelSelect.value = String(value);
    parallelCount = value;
  });

  parallelDec.addEventListener('click', () => {
    const value = clampParallelValue(parallelSelect.value) - 1;
    parallelSelect.value = String(Math.max(1, value));
    parallelCount = Math.max(1, value);
  });

  parallelInc.addEventListener('click', () => {
    const value = clampParallelValue(clampParallelValue(parallelSelect.value) + 1);
    parallelSelect.value = String(value);
    parallelCount = value;
  });

  function savePopupState() {
    chrome.storage.local.set({
      popupOriginalFileName: originalFileName,
      popupOriginalFileContent: originalFileContent,
      popupCsvHeaders: csvHeaders,
      popupCsvRows: csvRows,
      popupIsProcessed: isProcessed,
      popupCurrentAction,
      popupParallelCount: parallelCount,
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
      'popupParallelCount',
    ]);
    if (stored.popupOriginalFileName && stored.popupOriginalFileContent) {
      originalFileName = stored.popupOriginalFileName;
      originalFileContent = stored.popupOriginalFileContent;
      showFileCard(originalFileName);
    }
    if (stored.popupCsvHeaders && stored.popupCsvRows) {
      csvHeaders = stored.popupCsvHeaders;
      csvRows = stored.popupCsvRows;
      isProcessed = !!stored.popupIsProcessed;
      exportBtn.disabled = !isProcessed;
      tagBtn.disabled = !canTag();
      setParallelEnabled(canTag());
      // 静默恢复，不覆盖状态提示
    }
    if (stored.popupParallelCount) {
      parallelCount = Math.max(1, Math.min(extensionConfig.maxParallelTabs, Number(stored.popupParallelCount) || 1));
      parallelSelect.value = String(parallelCount);
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
    exportBtn.disabled = true;
    tagBtn.disabled = true;
    stopBtn.disabled = true;
    progressContainer.style.display = 'none';
    progressBar.innerHTML = '';
    progressText.textContent = '0 / 0';
    showStatusEmpty();
  }

  function showFileCard(name) {
    originalFileName = name;
    fileNameEl.textContent = name;
    fileLabel.style.display = 'none';
    fileCard.style.display = 'flex';
    exportBtn.disabled = !isProcessed;
    tagBtn.disabled = !canTag();
    setParallelEnabled(canTag());
    progressContainer.style.display = 'none';
    setStatus('idle', '文件已选择，点击“匹配 ID”开始匹配');
  }

  function canTag() {
    const idIndex = getColumnIndex('id');
    const tagIndex = getColumnIndex('标签');
    return idIndex !== -1 && tagIndex !== -1 && csvRows.length > 0;
  }

  function canSplit(parallel) {
    return csvRows.length >= parallel;
  }

  function splitRows(rows, count) {
    const chunks = Array.from({ length: count }, () => []);
    rows.forEach((row, i) => {
      chunks[i % count].push(row);
    });
    return chunks;
  }

  function setStatus(step, title) {
    if (statusHeaderEl) statusHeaderEl.style.display = '';
    if (statusEmptyEl) statusEmptyEl.style.display = 'none';
    statusStepEl.className = 'status-step';
    statusStepEl.classList.add(step);
    const stepLabels = {
      idle: '就绪',
      capture: '捕获接口',
      success: '捕获成功',
      process: '处理数据',
      done: '完成',
      retry: '重试',
      'process-csv': '处理 CSV',
      'match-id': '匹配 ID',
      tagging: '打标签',
    };
    statusStepEl.textContent = stepLabels[step] || '就绪';
    statusTitleEl.textContent = title || '';
  }

  function showStatusEmpty() {
    if (statusHeaderEl) statusHeaderEl.style.display = 'none';
    if (statusEmptyEl) statusEmptyEl.style.display = '';
  }

  function updateWorkerMessages(messages = []) {
    if (!workerListEl) return;
    workerListEl.innerHTML = '';
    if (!Array.isArray(messages) || messages.length === 0) return;
    messages.forEach((msg) => {
      const text = typeof msg === 'string' ? msg : msg.message;
      const progress = typeof msg === 'object' ? msg.progress : '';

      const el = document.createElement('div');
      el.className = 'worker-item';

      const spanText = document.createElement('span');
      spanText.textContent = text;
      el.appendChild(spanText);

      if (progress) {
        const spanProgress = document.createElement('span');
        spanProgress.className = 'worker-progress';
        spanProgress.textContent = progress;
        el.appendChild(spanProgress);
      }

      workerListEl.appendChild(el);
    });
  }

  function updateProgress(current, total, results = []) {
    progressContainer.style.display = 'block';

    const successCount = results && results.length > 0
      ? results.filter((r) => r === 'success').length
      : current;
    const effectiveCompleted = successCount;
    progressText.textContent = `${effectiveCompleted} / ${total}`;

    if (!results || results.length === 0) {
      progressBar.innerHTML = '';
      const progress = document.createElement('div');
      progress.className = 'progress-fill';
      progress.style.width = total > 0 ? `${(current / total) * 100}%` : '0%';
      progressBar.appendChild(progress);
      return;
    }

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
        console.log('[startStatusPolling] matching result=', result, 'csvRows sample=', result?.csvRows?.slice(0, 2));
        if (result) {
          if (result.csvHeaders) csvHeaders = result.csvHeaders;
          if (result.csvRows) csvRows = result.csvRows;
          isProcessed = true;
          savePopupState();
        }

        console.log('[startStatusPolling] after restore, csvHeaders=', csvHeaders, 'csvRows=', csvRows.slice(0, 2), 'canTag=', canTag());

        matchBtn.disabled = false;
        stopBtn.disabled = true;
        exportBtn.disabled = false;
        tagBtn.disabled = !canTag();
      }
    }, 500);
  }

  function startTaggingStatusPolling() {
    console.log('[startTaggingStatusPolling] start');
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'GET_TAGGING_STATUS' });
      console.log('[startTaggingStatusPolling] status=', status);
      if (!status) return;
      const step = status.isRunning ? 'tagging' : (status.step === 'done' ? 'tagging' : status.step);
      setStatus(step, status.message);
      if (status.total > 0) {
        updateProgress(status.currentIndex, status.total, status.results || []);
      }
      if (Array.isArray(status.workerMessages) && status.workerMessages.length > 0) {
        updateWorkerMessages(status.workerMessages);
      }

      if (status.isRunning) {
        // 运行中，确保按钮是停止状态
        stopBtn.textContent = '停止';
        stopBtn.classList.add('danger');
        stopBtn.classList.remove('primary');
      }

      if (!status.isRunning && status.isRetrying) {
        // 等待用户手动重试：按钮显示为重试，继续轮询
        stopBtn.textContent = `重试 (${status.failedRowsCount || 0})`;
        stopBtn.classList.remove('danger');
        stopBtn.classList.add('primary');
        stopBtn.disabled = false;
        return;
      }

      if (!status.isRunning) {
        stopStatusPolling();
        popupCurrentAction = '';

        console.log('[startTaggingStatusPolling] tagging done, fetch result');
        const result = await chrome.runtime.sendMessage({ type: 'GET_TAGGING_RESULT' });
        console.log('[startTaggingStatusPolling] result=', result);
        if (result && result.rows) {
          ensureTagResultColumns();
          const beforeIndex = getColumnIndex('打标前 tag');
          const afterIndex = getColumnIndex('打标后 tag');
          const statusIndex = getColumnIndex('打标情况');
          console.log('[startTaggingStatusPolling] column indexes', { beforeIndex, afterIndex, statusIndex, csvRowsLength: csvRows.length });
          result.rows.forEach((row, loopIndex) => {
            console.log('[startTaggingStatusPolling] process row', loopIndex, row);
            const idx = row.rowIndex;
            if (idx == null || idx < 0 || idx >= csvRows.length) {
              console.log('[startTaggingStatusPolling] skip row, invalid idx', idx, 'csvRows.length=', csvRows.length);
              return;
            }
            console.log('[startTaggingStatusPolling] writing to csvRows[', idx, ']', { beforeTags: row.beforeTags, afterTags: row.afterTags, status: row.status });
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

        // 恢复按钮为默认状态
        stopBtn.textContent = '停止';
        stopBtn.classList.add('danger');
        stopBtn.classList.remove('primary');
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

      exportBtn.disabled = true;
      showFileCard(file.name);
      setStatus('idle', '文件已选择，点击“匹配 ID”开始匹配');
      savePopupState();

      // 只要有数据就启用匹配 ID 按钮
      matchBtn.disabled = !(csvRows.length > 0);

      tagBtn.disabled = !canTag();
      setParallelEnabled(canTag());
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

  matchBtn.addEventListener('click', async () => {
    if (csvRows.length === 0) return;

    const hasUrl = getColumnIndex('URL') !== -1;
    const hasTag = getColumnIndex('标签') !== -1;
    if (!hasUrl) {
      alert('CSV 中需要包含 URL 列用于匹配 ID');
      return;
    }
    if (!hasTag) {
      alert('CSV 中需要包含 标签 列用于打标签');
      return;
    }

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
    const isRetryMode = stopBtn.textContent.includes('重试');
    if (isRetryMode) {
      // 点击重试：启动失败重试流程，按钮变回停止
      stopBtn.textContent = '停止';
      stopBtn.classList.add('danger');
      stopBtn.classList.remove('primary');
      await chrome.runtime.sendMessage({ type: 'RETRY_FAILED_TAGGING' });
      popupCurrentAction = 'tagging';
      savePopupState();
      startTaggingStatusPolling();
      return;
    }
    await chrome.runtime.sendMessage({ type: 'STOP_MATCHING' });
    await chrome.runtime.sendMessage({ type: 'STOP_TAGGING' });
    stopStatusPolling();
    popupCurrentAction = '';
    savePopupState();
    matchBtn.disabled = false;
    exportBtn.disabled = !isProcessed;
    tagBtn.disabled = !canTag();
    setParallelEnabled(canTag());
    stopBtn.disabled = true;
    stopBtn.textContent = '停止';
    stopBtn.classList.add('danger');
    stopBtn.classList.remove('primary');
    updateWorkerMessages([]);
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

    const parallel = Math.max(1, Math.min(extensionConfig.maxParallelTabs, Number(parallelSelect.value) || 1));
    if (!canSplit(parallel)) {
      alert(`数据量 ${tagRows.length} 条不足以拆分到 ${parallel} 个标签页，请减少并行数`);
      return;
    }

    const chunks = splitRows(tagRows, parallel);
    parallelCount = parallel;
    matchBtn.disabled = true;
    exportBtn.disabled = true;
    tagBtn.disabled = true;
    setParallelEnabled(false);
    stopBtn.disabled = false;
    setStatus('tagging', '开始打标签...');
    popupCurrentAction = 'tagging';
    savePopupState();

    await chrome.runtime.sendMessage({
      type: 'START_TAGGING',
      parallel,
      chunks,
    });

    startTaggingStatusPolling();
  });

  exportBtn.addEventListener('click', async () => {
    if (!csvHeaders.length || !csvRows.length) return;
    console.log('[export] headers=', csvHeaders, 'rows sample=', csvRows.slice(0, 2));
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

      chrome.runtime.sendMessage({ type: 'GET_MATCHING_STATUS' }).then((status) => {
        console.log('[loadPopupState] matching status=', status);
        if (status && status.isRunning) {
          exportBtn.disabled = true;
          stopBtn.disabled = false;
          popupCurrentAction = 'match-id';
          savePopupState();
          startStatusPolling();
          return;
        }
        if (status && status.step === 'done' && csvRows.length > 0) {
          // 匹配已结束，主动取回结果
          chrome.runtime.sendMessage({ type: 'GET_MATCHING_RESULT' }).then((result) => {
            console.log('[loadPopupState] matching done result=', result, 'csvRows sample=', result?.csvRows?.slice(0, 2));
            if (result) {
              if (result.csvHeaders) csvHeaders = result.csvHeaders;
              if (result.csvRows) csvRows = result.csvRows;
              isProcessed = true;
              savePopupState();
            }
            // 继续检查 tagging 状态
            restoreTaggingStatus(status);
          });
          return;
        }
        restoreTaggingStatus(status);
      });
    });
  });

  function restoreTaggingStatus(matchingStatus) {
    chrome.runtime.sendMessage({ type: 'GET_TAGGING_STATUS' }).then((tagStatus) => {
      console.log('[loadPopupState] tagging status=', tagStatus);
      if (tagStatus && tagStatus.isRunning) {
        matchBtn.disabled = true;
        exportBtn.disabled = true;
        tagBtn.disabled = true;
        setParallelEnabled(false);
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
        stopBtn.classList.add('danger');
        stopBtn.classList.remove('primary');
        popupCurrentAction = 'tagging';
        savePopupState();
        if (Array.isArray(tagStatus.workerMessages) && tagStatus.workerMessages.length > 0) {
          updateWorkerMessages(tagStatus.workerMessages);
        }
        startTaggingStatusPolling();
        return;
      }
      if (tagStatus && tagStatus.isRetrying) {
        // 处于等待手动重试状态
        matchBtn.disabled = true;
        exportBtn.disabled = true;
        tagBtn.disabled = true;
        setParallelEnabled(false);
        stopBtn.disabled = false;
        stopBtn.textContent = `重试 (${tagStatus.failedRowsCount || 0})`;
        stopBtn.classList.remove('danger');
        stopBtn.classList.add('primary');
        popupCurrentAction = 'tagging';
        savePopupState();
        if (tagStatus.total > 0) {
          updateProgress(tagStatus.currentIndex, tagStatus.total, tagStatus.results || []);
        }
        if (Array.isArray(tagStatus.workerMessages) && tagStatus.workerMessages.length > 0) {
          updateWorkerMessages(tagStatus.workerMessages);
        }
        startTaggingStatusPolling();
        return;
      }
      if (tagStatus && tagStatus.step === 'done' && csvRows.length > 0) {
        // 打标签已结束，主动取回结果并写回 CSV
        chrome.runtime.sendMessage({ type: 'GET_TAGGING_RESULT' }).then((result) => {
          console.log('[loadPopupState] tagging done result=', result, 'csvRows.length=', csvRows.length);
          if (tagStatus.total > 0) {
            updateProgress(tagStatus.currentIndex, tagStatus.total, tagStatus.results || []);
          }
          ensureTagResultColumns();
          if (result && result.rows) {
            const beforeIndex = getColumnIndex('打标前 tag');
            const afterIndex = getColumnIndex('打标后 tag');
            const statusIndex = getColumnIndex('打标情况');
            console.log('[loadPopupState] tagging column indexes', { beforeIndex, afterIndex, statusIndex });
            result.rows.forEach((row, loopIndex) => {
              console.log('[loadPopupState] tagging process row', loopIndex, row);
              const idx = row.rowIndex;
              if (idx == null || idx < 0 || idx >= csvRows.length) {
                console.log('[loadPopupState] skip invalid rowIndex', idx);
                return;
              }
              if (beforeIndex !== -1) csvRows[idx][beforeIndex] = (row.beforeTags || []).join(', ');
              if (afterIndex !== -1) csvRows[idx][afterIndex] = (row.afterTags || []).join(', ');
              if (statusIndex !== -1) csvRows[idx][statusIndex] = row.status || '';
              console.log('[loadPopupState] wrote csvRows[', idx, ']=', csvRows[idx]);
            });
            isProcessed = true;
            savePopupState();
          }
          setStatus('done', '打标签完成');
          stopBtn.textContent = '停止';
          stopBtn.classList.add('danger');
          stopBtn.classList.remove('primary');
          matchBtn.disabled = false;
          exportBtn.disabled = false;
          tagBtn.disabled = !canTag();
          stopBtn.disabled = true;
        });
        return;
      }
      if (matchingStatus && matchingStatus.step === 'done' && csvRows.length > 0) {
        // 匹配已完成，显示匹配进度
        if (matchingStatus.total > 0) {
          updateProgress(matchingStatus.currentIndex, matchingStatus.total, matchingStatus.results || []);
        }
        setStatus('done', '匹配完成');
        matchBtn.disabled = false;
        exportBtn.disabled = false;
        tagBtn.disabled = !canTag();
        stopBtn.disabled = true;
        return;
      }
      if (csvRows.length > 0) {
        // 没有运行中任务但已有数据，显示默认就绪状态
        setStatus('idle', '就绪');
      } else {
        showStatusEmpty();
      }
    });
  }
});
