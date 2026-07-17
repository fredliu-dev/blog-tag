// content script：监听页面注入脚本发送的记录，并转发给 background
(function () {
  if (window.__api_capture_content_injected__) return;
  window.__api_capture_content_injected__ = true;

  // 注入页面主世界脚本
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  let configCache = null;

  async function loadConfig() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const res = await fetch(url);
      return await res.json();
    } catch {
      return {
        keywords: [],
        defaultChangeType: '替换',
        selectors: {
          nextPageButton: '.Polaris-ButtonGroup__Item',
          saveButton: '._ContextualButton_10jvh_1._Primary_10jvh_28',
          tagRemoveButton: '.Polaris-Tag__Button.Polaris-Tag__Icon',
          tagRemoveButtonFallback: '[class*="Polaris-Tag__Button"]',
          tagRemoveButtonFallback2: '[class*="Polaris-Tag__Icon"]',
          tagText: '.Polaris-Tag__Text',
          tagWrapper: '[class*="Polaris-Tag"]',
          tagInput: 'input[name="article.tags"]',
          tagDropdownOption: '.Polaris-Listbox-Action',
        },
      };
    }
  }

  async function getConfig() {
    if (configCache) return configCache;
    configCache = await loadConfig();
    return configCache;
  }

  async function applyConfig() {
    const config = await getConfig();
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
    chrome.runtime.sendMessage({ type: 'CAPTURE_RECORD', record }).catch(() => { });
  });

  // 监听 background / popup 发来的指令
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const safeSendResponse = createSafeResponder(sendResponse);

    if (message.type === 'EXECUTE_CLICK_NEXT_BUTTON') {
      handleClickNext(safeSendResponse).catch((err) => {
        console.error('[onMessage] EXECUTE_CLICK_NEXT_BUTTON error', err);
        safeSendResponse({ success: false, error: err?.message || '未知错误', isDisabled: true });
      });
      return true;
    }

    if (message.type === 'TAG_ROW') {
      handleTagRow(message, safeSendResponse).catch((err) => {
        console.error('[onMessage] TAG_ROW error', err);
        safeSendResponse({ success: false, error: err?.message || '未知错误' });
      });
      return true;
    }

    safeSendResponse({ success: false, error: '未知消息类型' });
    return true;
  });

  function createSafeResponder(sendResponse) {
    let called = false;
    return (response) => {
      if (called) return;
      called = true;
      sendResponse(response);
    };
  }

  async function handleClickNext(sendResponse) {
    const config = await getConfig();
    const selectors = config.selectors || {};
    try {
      const buttons = document.querySelectorAll(selectors.nextPageButton || '.Polaris-ButtonGroup__Item');
      console.log('[EXECUTE_CLICK_NEXT_BUTTON] found buttons count=', buttons.length);
      if (buttons.length < 2) {
        sendResponse({ success: false, error: '未找到翻页按钮', isDisabled: true });
        return;
      }

      const secondButton = buttons[1];
      const innerButton = secondButton.querySelector('button');
      const isDisabled = innerButton ? innerButton.getAttribute('aria-disabled') === 'true' : false;
      console.log('[EXECUTE_CLICK_NEXT_BUTTON] innerButton=', innerButton, 'isDisabled=', isDisabled);

      if (isDisabled) {
        sendResponse({ success: false, error: '翻页按钮已禁用', isDisabled: true });
        return;
      }

      if (innerButton) {
        innerButton.click();
        console.log('[EXECUTE_CLICK_NEXT_BUTTON] clicked innerButton');
      } else {
        secondButton.click();
        console.log('[EXECUTE_CLICK_NEXT_BUTTON] clicked secondButton wrapper');
      }
      sendResponse({ success: true, isDisabled: false });
    } catch (err) {
      console.error('[EXECUTE_CLICK_NEXT_BUTTON] error', err);
      sendResponse({ success: false, error: err.message, isDisabled: true });
    }
  }

  async function handleTagRow(message, sendResponse) {
    const row = message.row || {};
    const workerIndex = message.workerIndex;
    const workerTotal = message.workerTotal;
    const workerProgress = message.workerProgress;
    let responded = false;
    const safeSendResponse = (response) => {
      if (responded) return;
      responded = true;
      sendResponse(response);
    };
    const onUnload = () => safeSendResponse({ success: false, error: '页面在处理过程中刷新或关闭' });
    window.addEventListener('beforeunload', onUnload);
    const globalProgress = message.globalProgress || {};
    try {
      console.log('[handleTagRow] start row=', row);
      showWorkerInfoBox({
        workerIndex,
        workerTotal,
        workerProgress,
        globalProgress,
        blogId: row.id,
        targetTags: row.tags || [],
        changeType: row.changeType || '替换',
        status: 'processing',
      });
      const result = await tagRow(row);
      console.log('[handleTagRow] result=', result);
      updateWorkerInfoBox({
        status: result.success ? 'success' : 'error',
        beforeTags: result.beforeTags,
        afterTags: result.afterTags,
        error: result.error,
        globalProgress,
      });
      safeSendResponse(result);
    } catch (err) {
      console.error('[handleTagRow] error', err);
      updateWorkerInfoBox({ status: 'error', error: err.message });
      safeSendResponse({ success: false, error: err.message });
    } finally {
      window.removeEventListener('beforeunload', onUnload);
    }
  }

  let workerInfoBoxEl = null;
  let workerInfoBoxHideTimer = null;

  function removeWorkerInfoBox() {
    if (workerInfoBoxHideTimer) {
      clearTimeout(workerInfoBoxHideTimer);
      workerInfoBoxHideTimer = null;
    }
    if (workerInfoBoxEl) {
      workerInfoBoxEl.remove();
      workerInfoBoxEl = null;
    }
  }

  function renderTagPills(tags) {
    if (!Array.isArray(tags) || tags.length === 0) {
      return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#8e8e93;font-size:11px;">无</span>';
    }
    return tags.map((tag) =>
      `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(10,132,255,0.12);border:1px solid rgba(10,132,255,0.35);color:#64d2ff;font-size:11px;margin:0 4px 4px 0;"
      >${tag}</span>`
    ).join('');
  }

  function renderWorkerInfoBoxContent(data) {
    const workerText = data.workerIndex != null
      ? `Worker ${data.workerIndex + 1}${data.workerTotal ? ` / ${data.workerTotal}` : ''}`
      : 'Worker';
    const blogText = data.blogId ? `博客 ID: ${data.blogId}` : '';
    const changeText = `修改类型: ${data.changeType || '替换'}`;

    const globalProgress = data.globalProgress || {};
    const globalTotal = globalProgress.total || 0;
    const globalSuccess = globalProgress.success || 0;
    const globalFail = globalProgress.fail || 0;
    const globalCurrent = globalSuccess + globalFail;
    const globalProgressText = globalTotal > 0
      ? `总进度: ${globalCurrent} / ${globalTotal} · 成功 ${globalSuccess} · 失败 ${globalFail}`
      : '';

    const progress = data.workerProgress || {};
    const progressTotal = progress.total || 0;
    const progressSuccess = progress.success || 0;
    const progressFail = progress.fail || 0;
    const progressCurrent = progressSuccess + progressFail + 1;
    const progressText = progressTotal > 0
      ? `Worker 进度: ${progressCurrent} / ${progressTotal} · 成功 ${progressSuccess} · 失败 ${progressFail}`
      : '';

    let statusText = '';
    let statusColor = '#0a84ff';
    if (data.status === 'processing') {
      statusText = '处理中...';
      statusColor = '#0a84ff';
    } else if (data.status === 'success') {
      statusText = '完成';
      statusColor = '#30d158';
    } else if (data.status === 'error') {
      statusText = data.error ? `失败: ${data.error}` : '失败';
      statusColor = '#ff453a';
    }

    let changeDetail = '';
    if (Array.isArray(data.beforeTags) || Array.isArray(data.afterTags)) {
      const before = Array.isArray(data.beforeTags) ? renderTagPills(data.beforeTags) : '<span style="color:#8e8e93;font-size:12px;">读取中...</span>';
      const after = Array.isArray(data.afterTags) ? renderTagPills(data.afterTags) : '<span style="color:#8e8e93;font-size:12px;">读取中...</span>';
      changeDetail = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;"><span style="font-size:12px;opacity:0.9;">标签变更：</span>${before}<span style="font-size:12px;opacity:0.6;">→</span>${after}</div>`;
    } else {
      changeDetail = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;"><span style="font-size:12px;opacity:0.9;">目标标签：</span>${renderTagPills(data.targetTags)}</div>`;
    }

    return `
      <button data-close-info style="position:absolute;top:8px;right:8px;background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;line-height:1;padding:4px;">✕</button>
      ${globalProgressText ? `<div style="margin-bottom:8px;font-size:12px;font-weight:600;color:#30d158;">${globalProgressText}</div>` : ''}
      <div style="font-weight:700;font-size:14px;padding-right:20px;" data-info-title>${workerText}</div>
      ${blogText ? `<div style="margin-top:4px;font-size:12px;opacity:0.8;">${blogText}</div>` : ''}
      ${progressText ? `<div style="margin-top:8px;font-size:12px;opacity:0.9;">${progressText}</div>` : ''}
      <div style="margin-top:8px;font-size:12px;opacity:0.9;">${changeText}</div>
      ${changeDetail}
      <div style="margin-top:8px;font-size:12px;font-weight:600;color:${statusColor};" data-info-status>${statusText}</div>
    `;
  }

  function showWorkerInfoBox(data) {
    removeWorkerInfoBox();

    const el = document.createElement('div');
    el.id = 'blog-tag-worker-info';
    el.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      min-width: 280px;
      max-width: 400px;
      padding: 14px 16px;
      background: #1c1c1e;
      color: #f5f5f7;
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      transition: opacity 0.3s ease, transform 0.3s ease;
    `;
    el.innerHTML = renderWorkerInfoBoxContent(data);
    document.body.appendChild(el);
    workerInfoBoxEl = el;
    setInfoBoxDataset(data);

    el.querySelector('[data-close-info]').addEventListener('click', () => {
      removeWorkerInfoBox();
    });
  }

  function updateWorkerInfoBox(data) {
    if (!workerInfoBoxEl) return;
    const prevData = {
      workerIndex: workerInfoBoxEl.dataset.workerIndex ? Number(workerInfoBoxEl.dataset.workerIndex) : undefined,
      workerTotal: workerInfoBoxEl.dataset.workerTotal ? Number(workerInfoBoxEl.dataset.workerTotal) : undefined,
      workerProgress: workerInfoBoxEl.dataset.workerProgress ? JSON.parse(workerInfoBoxEl.dataset.workerProgress) : undefined,
      blogId: workerInfoBoxEl.dataset.blogId,
      targetTags: workerInfoBoxEl.dataset.targetTags ? JSON.parse(workerInfoBoxEl.dataset.targetTags) : [],
      changeType: workerInfoBoxEl.dataset.changeType,
    };
    const nextData = { ...prevData, ...data };
    workerInfoBoxEl.innerHTML = renderWorkerInfoBoxContent(nextData);
    workerInfoBoxEl.querySelector('[data-close-info]').addEventListener('click', () => {
      removeWorkerInfoBox();
    });

    if (data.status === 'success' || data.status === 'error') {
      workerInfoBoxHideTimer = setTimeout(() => {
        removeWorkerInfoBox();
      }, 5000);
    }
  }

  function setInfoBoxDataset(data) {
    if (!workerInfoBoxEl) return;
    if (data.workerIndex != null) workerInfoBoxEl.dataset.workerIndex = String(data.workerIndex);
    if (data.workerTotal != null) workerInfoBoxEl.dataset.workerTotal = String(data.workerTotal);
    if (data.workerProgress) workerInfoBoxEl.dataset.workerProgress = JSON.stringify(data.workerProgress);
    if (data.blogId != null) workerInfoBoxEl.dataset.blogId = String(data.blogId);
    if (Array.isArray(data.targetTags)) workerInfoBoxEl.dataset.targetTags = JSON.stringify(data.targetTags);
    if (data.changeType != null) workerInfoBoxEl.dataset.changeType = String(data.changeType);
  }

  async function tagRow(row) {
    const { id, tags, changeType } = row;

    const normalizedChangeType = (changeType || '').trim();
    const shouldReplace = normalizedChangeType.toLowerCase() === '替换' || normalizedChangeType.toLowerCase() === 'replace';

    console.log('[tagRow] id=', id, 'changeType=', changeType, 'shouldReplace=', shouldReplace, 'tags=', tags);

    await waitForTagsStable();
    const beforeTags = readExistingTags();
    updateWorkerInfoBox({ beforeTags });
    console.log('[tagRow] final beforeTags=', beforeTags);

    if (shouldReplace) {
      const tagsToRemove = beforeTags.filter((tag) => !tags.includes(tag));
      const tagsToAdd = tags.filter((tag) => !beforeTags.includes(tag));

      console.log('[tagRow] replace mode tagsToRemove=', tagsToRemove, 'tagsToAdd=', tagsToAdd);

      if (tagsToRemove.length === 0 && tagsToAdd.length === 0) {
        return { success: true, action: 'skipped', beforeTags, afterTags: beforeTags, reason: '标签无需修改' };
      }

      if (tagsToRemove.length > 0) {
        console.log('[tagRow] start removeSpecificTags');
        await removeSpecificTags(tagsToRemove);
        console.log('[tagRow] end removeSpecificTags');
      }

      const addedTags = [];
      for (const tag of tagsToAdd) {
        console.log('[tagRow] start inputTag tag=', tag);
        const ok = await inputTag(tag);
        console.log('[tagRow] end inputTag tag=', tag, 'ok=', ok);
        if (ok) addedTags.push(tag);
      }

      const afterTags = readExistingTags();
      updateWorkerInfoBox({ afterTags });
      console.log('[tagRow] afterTags=', afterTags);

      console.log('[tagRow] start clickSaveButton');
      const saveResult = await clickSaveButton(tags);
      console.log('[tagRow] saveResult=', saveResult);
      if (!saveResult.success) {
        return { success: false, action: 'replace', beforeTags, afterTags: saveResult.finalTags || afterTags, addedTags, error: saveResult.error };
      }

      return {
        success: true,
        action: 'replace',
        beforeTags,
        afterTags: saveResult.finalTags || afterTags,
        addedTags,
      };
    } else {
      const tagsToAdd = tags.filter((tag) => !beforeTags.includes(tag));

      console.log('[tagRow] add mode tagsToAdd=', tagsToAdd);

      if (tagsToAdd.length === 0) {
        return { success: true, action: 'skipped', beforeTags, afterTags: beforeTags, reason: '所有标签已存在' };
      }

      const addedTags = [];
      for (const tag of tagsToAdd) {
        console.log('[tagRow] start inputTag tag=', tag);
        const ok = await inputTag(tag);
        console.log('[tagRow] end inputTag tag=', tag, 'ok=', ok);
        if (ok) addedTags.push(tag);
      }

      const afterTags = readExistingTags();
      updateWorkerInfoBox({ afterTags });
      console.log('[tagRow] afterTags=', afterTags);

      console.log('[tagRow] start clickSaveButton');
      const saveResult = await clickSaveButton(tags);
      console.log('[tagRow] saveResult=', saveResult);
      if (!saveResult.success) {
        return { success: false, action: 'add', beforeTags, afterTags: saveResult.finalTags || afterTags, addedTags, error: saveResult.error };
      }

      return {
        success: true,
        action: 'add',
        beforeTags,
        afterTags: saveResult.finalTags || afterTags,
        addedTags,
      };
    }
  }

  async function clickSaveButton(expectedTags) {
    const config = await getConfig();
    const selectors = config.selectors || {};
    let loopCount = 0;
    let saveBtn = document.querySelector(selectors.saveButton || '._ContextualButton_10jvh_1._Primary_10jvh_28');
    while (!saveBtn && loopCount < 3) {
      saveBtn = document.querySelector(selectors.saveButton || '._ContextualButton_10jvh_1._Primary_10jvh_28');
      loopCount++;
    }
    if (loopCount >= 3 && !saveBtn) {
      return { success: false, error: '未找到保存按钮，3次尝试均失败' };
    }
    saveBtn.click();
    console.log('[clickSaveButton] 已点击保存按钮');

    // 监控 _Contents_1qn6f_1 元素，如果元素存在则等待，如果消失则等待 500ms 后返回成功
    const contentsElement = document.querySelector('._Contents_1qn6f_1');
    if (contentsElement) {
      console.log('[clickSaveButton] 检测到 _Contents_1qn6f_1 元素，等待其消失');
      let checkCount = 0;
      while (document.querySelector('._Contents_1qn6f_1') && checkCount < 120) {
        await waitFor(250);
        checkCount++;
        console.log('[clickSaveButton] 等待 _Contents_1qn6f_1 消失，checkCount=', checkCount);
      }
      if (document.querySelector('._Contents_1qn6f_1')) {
        console.log('[clickSaveButton] _Contents_1qn6f_1 未消失，超时');
        return { success: false, error: '保存超时：_Contents_1qn6f_1 元素未消失' };
      }
      console.log('[clickSaveButton] _Contents_1qn6f_1 已消失');
    } else {
      console.log('[clickSaveButton] 未检测到 _Contents_1qn6f_1 元素，可能无修改或已完成');
    }

    // 保存成功后临时屏蔽 beforeunload 弹窗，避免跳转时提示
    window.postMessage({ type: 'SUPPRESS_BEFORE_UNLOAD', duration: 5000 }, '*');

    // 保存成功后等待页面状态落盘
    await waitFor(500);

    // 验证保存结果：重新读取当前标签，确认期望标签都在
    const finalTags = readExistingTags();
    console.log('[clickSaveButton] finalTags=', finalTags, 'expectedTags=', expectedTags);
    if (finalTags.length > 0 && expectedTags && expectedTags.length > 0) {
      const missing = expectedTags.filter((tag) => !finalTags.includes(tag));
      if (missing.length > 0) {
        return { success: false, error: `保存后标签验证失败，缺少: ${missing.join(', ')}` };
      }
    }

    return { success: true, finalTags };
  }

  function hasGraphQLError(data) {
    if (!data) return false;
    if (Array.isArray(data.errors) && data.errors.length > 0) return true;
    if (data.data && Array.isArray(data.data.errors) && data.data.errors.length > 0) return true;
    return false;
  }

  function readExistingTags() {
    const config = configCache || {};
    const selectors = config.selectors || {};
    const selectorList = [
      selectors.tagText,
      '.Polaris-Tag__Text',
      '[class*="Tag__Text"]',
      '[class*="Tag"][class*="Text"]',
    ].filter(Boolean);
    for (const sel of selectorList) {
      const elements = document.querySelectorAll(sel);
      console.log('[readExistingTags] selector=', sel, 'elementsCount=', elements.length);
      const tags = Array.from(elements).map((el) => {
        console.log('[readExistingTags] element text=', el.textContent.trim(), 'outerHTML=', el.outerHTML.slice(0, 200));
        return el.textContent.trim();
      }).filter(Boolean);
      if (tags.length > 0) {
        console.log('[readExistingTags] selector=', sel, 'tags=', tags);
        return tags;
      }
    }
    console.log('[readExistingTags] no tags found');
    return [];
  }

  async function removeAllExistingTags() {
    const buttons = findTagRemoveButtons();
    console.log('[removeAllExistingTags] found buttons count=', buttons.length);
    for (const btn of Array.from(buttons)) {
      btn.click();
      await waitFor(50);
    }
    // 等待标签 DOM 移除
    await waitFor(300);
  }

  async function removeSpecificTags(tagsToRemove) {
    console.log('[removeSpecificTags] tagsToRemove=', tagsToRemove);
    let maxAttempts = 30;
    while (maxAttempts-- > 0) {
      const buttons = findTagRemoveButtons();
      console.log('[removeSpecificTags] attempt', 30 - maxAttempts, 'buttons count=', buttons.length);
      if (buttons.length === 0) break;

      let clicked = false;
      for (const btn of buttons) {
        const tagText = getTagTextFromButton(btn);
        console.log('[removeSpecificTags] button tagText=', tagText);
        if (tagsToRemove.includes(tagText)) {
          btn.click();
          clicked = true;
          console.log('[removeSpecificTags] clicked tag=', tagText);
          await waitFor(150);
          break;
        }
      }
      if (!clicked) {
        console.log('[removeSpecificTags] no more matching tags to remove');
        break;
      }
    }
    // 等待标签 DOM 移除
    await waitFor(500);
  }

  function findTagRemoveButtons() {
    const config = configCache || {};
    const selectors = config.selectors || {};
    const selectorList = [
      selectors.tagRemoveButton,
      selectors.tagRemoveButtonFallback,
      selectors.tagRemoveButtonFallback2,
      '.Polaris-Tag__Button.Polaris-Tag__Icon',
      '[class*="Polaris-Tag__Button"]',
      '[class*="Polaris-Tag__Icon"]',
      'button[aria-label*="Remove"]',
      'button[class*="Tag"]',
      '.Polaris-Tag button',
      '[class*="Tag"] button',
    ].filter(Boolean);
    for (const sel of selectorList) {
      const buttons = document.querySelectorAll(sel);
      console.log('[findTagRemoveButtons] selector=', sel, 'count=', buttons.length);
      if (buttons.length > 0) {
        return Array.from(buttons);
      }
    }
    return [];
  }

  function getTagTextFromButton(button) {
    const config = configCache || {};
    const selectors = config.selectors || {};
    const wrapperSelector = selectors.tagWrapper || '[class*="Polaris-Tag"]';
    const tagWrapper = button.closest(wrapperSelector);
    if (tagWrapper) {
      const textSelectorList = [
        selectors.tagText,
        '.Polaris-Tag__Text',
        '[class*="Tag__Text"]',
        '[class*="Tag"][class*="Text"]',
      ].filter(Boolean);
      for (const sel of textSelectorList) {
        const tagTextEl = tagWrapper.querySelector(sel);
        if (tagTextEl) {
          const text = tagTextEl.textContent.trim();
          if (text) {
            console.log('[getTagTextFromButton] wrapper selector=', wrapperSelector, 'text selector=', sel, 'text=', text);
            return text;
          }
        }
      }
    }
    // 尝试从按钮前一个兄弟或父元素的文本读取
    const parent = button.parentElement;
    if (parent) {
      const childText = Array.from(parent.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE)
        .map((n) => n.textContent || '')
        .join('')
        .trim();
      if (childText) {
        console.log('[getTagTextFromButton] parent text=', childText);
        return childText;
      }
    }
    console.log('[getTagTextFromButton] no text found');
    return '';
  }

  async function inputTag(tag) {
    const config = configCache || {};
    const selectors = config.selectors || {};
    const input = await waitForElement(selectors.tagInput || 'input[name="article.tags"]');
    if (!input) return false;

    input.focus();
    input.value = tag;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 等待下拉选项出现，点击第一个 .Polaris-Listbox-Action，最多查询 10 次
    const option = await waitForElementWithInterval(selectors.tagDropdownOption || '.Polaris-Listbox-Action', 1000, 10);
    if (option) {
      option.click();
      await waitFor(200);
    } else {
      // 没有选项则按回车创建标签
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(200);
    }

    // 触发 blur 或 Tab 让下拉框收起
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    input.blur();
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await waitFor(200);

    return true;
  }

  function waitForElementWithInterval(selector, intervalMs, maxAttempts) {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        attempts++;
        if (attempts >= maxAttempts) {
          resolve(null);
          return;
        }
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  async function waitForAnyTagRemoveButton() {
    const config = configCache || {};
    const selectors = config.selectors || {};
    const selector = [
      selectors.tagRemoveButton,
      selectors.tagRemoveButtonFallback,
      selectors.tagRemoveButtonFallback2,
    ]
      .filter(Boolean)
      .join(', ') || '.Polaris-Tag__Button.Polaris-Tag__Icon, [class*="Polaris-Tag__Button"], [class*="Polaris-Tag__Icon"]';
    const el = await waitForElementWithInterval(selector, 1000, 10);
    console.log('[waitForAnyTagRemoveButton] found=', !!el);
    return el;
  }

  function isVisible(el) {
    return !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
  }

  function waitForElement(selector, timeout = 50000000000, checkVisible = false) {
    return new Promise((resolve) => {
      const check = () => {
        const el = document.querySelector(selector);
        if (el && (!checkVisible || isVisible(el))) {
          return el;
        }
        return null;
      };
      const found = check();
      if (found) {
        resolve(found);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = check();
        console.log('[waitForElement] check=', el);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        console.log('[waitForElement] timeout, resolve=', check());
        observer.disconnect();
        resolve(check());
      }, timeout);
    });
  }

  function waitFor(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForTagsStable() {
    const config = configCache || {};
    const selectors = config.selectors || {};

    // 等待 document.readyState 为 complete，确保页面基础资源加载完成
    for (let i = 0; i < 50 && document.readyState !== 'complete'; i++) {
      await waitFor(100);
    }

    // 等待标签输入框可见，说明组件已真正渲染
    await waitForElement(selectors.tagInput || 'input[name="article.tags"]', 10000000000, true);

    // 再额外等待，让标签异步加载
    console.log('[waitForTagsStable] input visible, wait for tags to render');
    await waitFor(800);

    let lastTags = [];
    let stableCount = 0;
    let emptyCount = 0;
    for (let i = 0; i < 30; i++) {
      const currentTags = readExistingTags();
      console.log('[waitForTagsStable] attempt', i, 'readyState=', document.readyState, 'tags=', currentTags);
      if (JSON.stringify(currentTags) === JSON.stringify(lastTags)) {
        stableCount++;
        if (currentTags.length === 0) {
          emptyCount++;
          // 空标签时多等几轮，避免异步标签还没加载完就误判为稳定
          if (emptyCount >= 10) {
            console.log('[waitForTagsStable] tags stable (empty)');
            return;
          }
        } else if (stableCount >= 3) {
          console.log('[waitForTagsStable] tags stable');
          return;
        }
      } else {
        stableCount = 0;
        emptyCount = 0;
      }
      lastTags = currentTags;
      await waitFor(300);
    }
    console.log('[waitForTagsStable] timeout, use lastTags=', lastTags);
  }

  // 注入后立即应用配置文件
  applyConfig();
})();
