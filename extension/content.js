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
      handleTagRow(message.row, safeSendResponse).catch((err) => {
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

  async function handleTagRow(row, sendResponse) {
    try {
      console.log('[handleTagRow] start row=', row);
      const result = await tagRow(row);
      console.log('[handleTagRow] success result=', result);
      sendResponse({ success: true, result });
    } catch (err) {
      console.error('[handleTagRow] error', err);
      sendResponse({ success: false, error: err.message });
    }
  }

  async function tagRow(row) {
    const { id, tags, changeType } = row;

    const normalizedChangeType = (changeType || '').trim();
    const shouldReplace = normalizedChangeType.toLowerCase() === '替换' || normalizedChangeType.toLowerCase() === 'replace';

    console.log('[tagRow] id=', id, 'changeType=', changeType, 'shouldReplace=', shouldReplace, 'tags=', tags);

    await waitForTagsStable();
    const beforeTags = readExistingTags();
    console.log('[tagRow] beforeTags=', beforeTags);

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
      console.log('[tagRow] afterTags=', afterTags);

      console.log('[tagRow] start clickSaveButton');
      const saveResult = await clickSaveButton();
      console.log('[tagRow] saveResult=', saveResult);
      if (!saveResult.success) {
        return { success: false, action: 'replace', beforeTags, afterTags, addedTags, error: saveResult.error };
      }

      return {
        success: true,
        action: 'replace',
        beforeTags,
        afterTags,
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
      console.log('[tagRow] afterTags=', afterTags);

      console.log('[tagRow] start clickSaveButton');
      const saveResult = await clickSaveButton();
      console.log('[tagRow] saveResult=', saveResult);
      if (!saveResult.success) {
        return { success: false, action: 'add', beforeTags, afterTags, addedTags, error: saveResult.error };
      }

      return {
        success: true,
        action: 'add',
        beforeTags,
        afterTags,
        addedTags,
      };
    }
  }

  async function clickSaveButton() {
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

    const record = await waitForUpdateRecord(30000);
    if (!record) {
      return { success: false, error: '未捕获到 ArticleDetailsUpdate 接口' };
    }

    const status = record.status || 0;
    const hasError = hasGraphQLError(record.data);
    console.log('[clickSaveButton] ArticleDetailsUpdate status=', status, 'hasError=', hasError);

    if (status >= 200 && status < 300 && !hasError) {
      return { success: true, record };
    }
    return { success: false, error: `更新失败：HTTP ${status}${hasError ? '，GraphQL 返回错误' : ''}`, record };
  }

  function waitForUpdateRecord(timeoutMs = 30000) {
    return new Promise((resolve) => {
      let resolved = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const msg = event.data || {};
        if (msg.type !== 'API_CAPTURE_RECORD') return;
        const record = msg.record || {};
        const url = record.url || '';
        if (url.includes('admin.shopify.com/api/operations') && url.includes('ArticleDetailsUpdate')) {
          window.removeEventListener('message', handler);
          resolved = true;
          resolve(record);
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => {
        if (!resolved) {
          window.removeEventListener('message', handler);
          resolve(null);
        }
      }, timeoutMs);
    });
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
      const tags = Array.from(elements).map((el) => el.textContent.trim()).filter(Boolean);
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

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(document.querySelector(selector));
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

    // 等待标签输入框出现，说明组件已初始化
    await waitForElement(selectors.tagInput || 'input[name="article.tags"]', 10000);

    let lastTags = [];
    let stableCount = 0;
    for (let i = 0; i < 30; i++) {
      const currentTags = readExistingTags();
      console.log('[waitForTagsStable] attempt', i, 'readyState=', document.readyState, 'tags=', currentTags);
      if (JSON.stringify(currentTags) === JSON.stringify(lastTags)) {
        stableCount++;
        if (stableCount >= 3) {
          console.log('[waitForTagsStable] tags stable');
          return;
        }
      } else {
        stableCount = 0;
      }
      lastTags = currentTags;
      await waitFor(300);
    }
    console.log('[waitForTagsStable] timeout, use lastTags=', lastTags);
  }

  // 注入后立即应用配置文件
  applyConfig();
})();
