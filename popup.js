document.addEventListener('DOMContentLoaded', () => {
  const convertBtn = document.getElementById('convertBtn');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const status = document.getElementById('status');

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'batchUpdate') {
      applyBatchStatus(request);
    }
  });

  initializeBatchStatus();

  // Função auxiliar para verificar se o site é válido
  function isValidSite(url) {
    return url.includes('deepwiki.com') || url.includes('devin.ai');
  }

  // Helper to sanitize filenames
  function sanitizeFilename(name) {
    if (!name) return 'document';
    // Replace characters that are not alphanumeric, underscore, hyphen, or period with an underscore
    // Then replace multiple underscores with a single underscore
    return name.replace(/[^a-z0-9_\-\.]/gi, '_').replace(/_+/g, '_');
  }

  convertBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // VERIFICAÇÃO ATUALIZADA
      if (!isValidSite(tab.url)) {
        showStatus('Please use this extension on a DeepWiki or Devin page', 'error');
        return;
      }

      showStatus('Converting page...', 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'convertToMarkdown' });

      if (response && response.success) {
        const headTitle = response.headTitle || '';
        const currentTitle = response.markdownTitle;
        
        // Sanitize filename components
        const sanitizedHeadTitle = sanitizeFilename(headTitle);
        const sanitizedCurrentTitle = sanitizeFilename(currentTitle);

        const fileName = sanitizedHeadTitle
          ? `${sanitizedHeadTitle}-${sanitizedCurrentTitle}.md`
          : `${sanitizedCurrentTitle}.md`;

        const blob = new Blob([response.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({
          url,
          filename: fileName,
          saveAs: true
        });

        showStatus('Conversion successful! Downloading...', 'success');
      } else {
        showStatus('Conversion failed: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    }
  });

  batchDownloadBtn.addEventListener('click', async () => {
    console.log('[Popup] Batch Convert button clicked!');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('[Popup] Active tab:', tab.url);

      // VERIFICAÇÃO ATUALIZADA
      if (!isValidSite(tab.url)) {
        showStatus('Please use this extension on a DeepWiki or Devin page', 'error');
        return;
      }

      showCancelButton(true);
      disableBatchButton(true);
      showStatus('Starting batch conversion...', 'info');

      const response = await chrome.runtime.sendMessage({ action: 'startBatch', tabId: tab.id });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to start batch conversion.');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
      showCancelButton(false);
      disableBatchButton(false);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'cancelBatch' });
      if (response && response.success) {
        showStatus('Cancelling batch operation...', 'info');
      } else {
        showStatus('No active batch operation to cancel.', 'info');
      }
    } catch (error) {
      showStatus('Unable to cancel batch: ' + error.message, 'error');
    }
  });

  async function initializeBatchStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getBatchStatus' });
      applyBatchStatus(response);
    } catch (error) {
      console.warn('Unable to fetch batch status:', error.message);
    }
  }

  function applyBatchStatus(statusPayload) {
    if (!statusPayload) {
      return;
    }

    if (statusPayload.running) {
      showCancelButton(true);
      disableBatchButton(true);
    } else {
      showCancelButton(false);
      disableBatchButton(false);
    }

    if (statusPayload.message) {
      showStatus(statusPayload.message, statusPayload.level || 'info');
    }
  }

  function showCancelButton(show) {
    cancelBtn.style.display = show ? 'block' : 'none';
  }

  function disableBatchButton(disable) {
    batchDownloadBtn.disabled = disable;
  }

  function showStatus(message, type) {
    status.textContent = message;
    status.className = type;
  }
});