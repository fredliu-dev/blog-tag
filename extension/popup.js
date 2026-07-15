document.addEventListener('DOMContentLoaded', async () => {
  const clearBtn = document.getElementById('clear');
  const exportBtn = document.getElementById('export');
  const statusEl = document.getElementById('status');

  async function updateStatus() {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    statusEl.textContent = `已抓取 ${state.records?.length || 0} 条接口`;
  }

  await updateStatus();

  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_RECORDS' });
    await updateStatus();
  });

  exportBtn.addEventListener('click', async () => {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    const records = state.records || [];

    if (records.length === 0) {
      statusEl.textContent = '没有可导出的记录';
      return;
    }

    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    await chrome.downloads.download({
      url,
      filename: `api-capture-${timestamp}.json`,
      saveAs: true,
    });

    statusEl.textContent = `已导出 ${records.length} 条记录`;
  });
});
