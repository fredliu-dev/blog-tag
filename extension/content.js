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
    console.log('API_CAPTURE_RECORD', record);
    chrome.runtime.sendMessage({ type: 'CAPTURE_RECORD', record }).catch(() => {});
  });

  // 监听 background / popup 发来的指令
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_CLICK_NEXT_BUTTON') {
      handleClickNext(sendResponse);
      return true;
    }

    if (message.type === 'TAG_ROW') {
      handleTagRow(message.row, sendResponse);
      return true;
    }

    return true;
  });

  function handleClickNext(sendResponse) {
    try {
      const buttons = document.querySelectorAll('.Polaris-ButtonGroup__Item');
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
      const result = await tagRow(row);
      sendResponse({ success: true, result });
    } catch (err) {
      console.error('[handleTagRow] error', err);
      sendResponse({ success: false, error: err.message });
    }
  }

  async function tagRow(row) {
    const { id, tags, changeType } = row;
    const existingTags = readExistingTags();
    const tagsToAdd = tags.filter((tag) => !existingTags.includes(tag));

    const shouldReplace = changeType === '替换';
    const shouldAdd = !changeType || changeType === '新增' || changeType === '替换';

    if (!shouldReplace && tagsToAdd.length === 0) {
      return { action: 'skipped', reason: '所有标签已存在' };
    }

    // 替换模式下先删除所有现有标签
    if (shouldReplace) {
      await removeAllExistingTags();
    }

    // 输入标签
    const addedTags = [];
    for (const tag of shouldReplace ? tags : tagsToAdd) {
      const ok = await inputTag(tag);
      if (ok) addedTags.push(tag);
    }

    return {
      action: shouldReplace ? 'replace' : 'add',
      existingTags,
      addedTags,
    };
  }

  function readExistingTags() {
    const elements = document.querySelectorAll('.Polaris-Tag__Text');
    return Array.from(elements).map((el) => el.textContent.trim()).filter(Boolean);
  }

  async function removeAllExistingTags() {
    const buttons = document.querySelectorAll('.Polaris-Tag__Button.Polaris-Tag__Icon');
    for (const btn of Array.from(buttons)) {
      btn.click();
      await waitFor(50);
    }
    // 等待标签 DOM 移除
    await waitFor(300);
  }

  async function inputTag(tag) {
    const input = await waitForElement('input[name="article.tags"]');
    if (!input) return false;

    input.focus();
    input.value = tag;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 等待下拉选项出现，点击第一个 .Polaris-Listbox-Action，最多查询 10 次
    const option = await waitForElementWithInterval('.Polaris-Listbox-Action', 1000, 10);
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

  // 注入后立即应用配置文件
  applyConfig();
})();
