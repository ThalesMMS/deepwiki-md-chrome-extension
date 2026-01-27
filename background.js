importScripts('lib/jszip.min.js');

const MESSAGE_TIMEOUT = 30000;
const messageQueue = {};
const CONTENT_READY_TIMEOUT = 20000;
const CONTENT_READY_MIN_TEXT = 160;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Função auxiliar para validar URL no background também
function isValidUrl(url) {
  return url && (url.includes('deepwiki.com') || url.includes('devin.ai'));
}

function getProjectPrefix(urlString) {
  try {
    const url = new URL(urlString);
    const segments = url.pathname.split('/').filter(Boolean);

    const markers = new Set(['deepwiki', 'wiki', 'docs']);
    const markerIdx = segments.findIndex(seg => markers.has(seg.toLowerCase()));
    if (markerIdx >= 0) {
      const markerPrefixLength = Math.min(segments.length, markerIdx + 3);
      return `/${segments.slice(0, markerPrefixLength).join('/')}`;
    }

    if (segments.length >= 2) {
      return `/${segments.slice(0, 2).join('/')}`;
    }
    if (segments.length === 1) {
      return `/${segments[0]}`;
    }
    return '/';
  } catch (error) {
    console.warn('Failed to derive project prefix:', error.message);
    return null;
  }
}

function filterPagesToProject(pages, currentUrl) {
  let base;
  try {
    base = new URL(currentUrl);
  } catch (error) {
    console.warn('Invalid current URL for filtering:', error.message);
    return pages || [];
  }

  const prefix = getProjectPrefix(currentUrl);
  if (!Array.isArray(pages) || pages.length === 0) {
    return [];
  }

  const filtered = pages.filter(page => {
    try {
      const pageUrl = new URL(page.url, base.origin);
      if (pageUrl.origin !== base.origin) return false;
      if (!prefix) return true;
      return pageUrl.pathname.startsWith(prefix);
    } catch (error) {
      return false;
    }
  });

  console.log('Batch page filtering:', {
    extracted: pages.length,
    filtered: filtered.length,
    prefix
  });

  return filtered;
}

const createInitialBatchState = () => ({
  isRunning: false,
  tabId: null,
  originalUrl: null,
  pages: [],
  convertedPages: [],
  folderName: '',
  processed: 0,
  failed: 0,
  cancelRequested: false,
  total: 0,
  currentTitle: '',
  fileNames: new Set()
});

let batchState = createInitialBatchState();
let lastBatchReport = {
  type: 'idle',
  message: 'Batch converter ready.',
  level: 'info',
  processed: 0,
  failed: 0,
  total: 0,
  running: false
};

function markTabPending(tabId) {
  if (!messageQueue[tabId]) {
    messageQueue[tabId] = { isReady: false, queue: [] };
    return;
  }
  messageQueue[tabId].isReady = false;
}

function dispatchMessageToTab(tabId, item) {
  chrome.tabs.sendMessage(tabId, item.message, response => {
    if (chrome.runtime.lastError) {
      item.reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    item.resolve(response);
  });
}

function flushMessageQueue(tabId) {
  const entry = messageQueue[tabId];
  if (!entry) return;
  entry.isReady = true;
  while (entry.queue.length > 0) {
    const payload = entry.queue.shift();
    dispatchMessageToTab(tabId, payload);
  }
}

function queueMessageForTab(tabId, message, resolve, reject) {
  if (!messageQueue[tabId]) {
    messageQueue[tabId] = { isReady: false, queue: [] };
  }

  const queueItem = {
    message,
    resolve: (response) => {
      clearTimeout(queueItem.timeoutId);
      resolve(response);
    },
    reject: (error) => {
      clearTimeout(queueItem.timeoutId);
      reject(error);
    }
  };

  queueItem.timeoutId = setTimeout(() => {
    queueItem.reject(new Error(`Timed out waiting for response for ${message.action}`));
  }, MESSAGE_TIMEOUT);

  messageQueue[tabId].queue.push(queueItem);
}

function attemptDirectMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function shouldQueueForError(error) {
  if (!error || !error.message) return false;
  return error.message.includes('Receiving end does not exist') ||
    error.message.includes('Could not establish connection');
}

function sendMessageToTab(tabId, message) {
  const entry = messageQueue[tabId];
  const tryDirect = () => attemptDirectMessage(tabId, message);

  // Se a aba foi marcada como "pending", não tente envio direto:
  // isso evita falar com a página antiga durante a navegação.
  if (entry && entry.isReady === false) {
    return new Promise((resolve, reject) => {
      queueMessageForTab(tabId, message, resolve, reject);
    });
  }

  if (entry && entry.isReady) {
    return tryDirect();
  }

  return tryDirect().catch(error => {
    if (!shouldQueueForError(error)) {
      throw error;
    }

    return new Promise((resolve, reject) => {
      queueMessageForTab(tabId, message, resolve, reject);
    });
  });
}

function urlsRoughlyMatch(expectedUrl, actualUrl) {
  if (!expectedUrl || !actualUrl) return true;
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(actualUrl);
    if (expected.origin !== actual.origin) return false;
    return actual.pathname.startsWith(expected.pathname) ||
      expected.pathname.startsWith(actual.pathname);
  } catch (error) {
    return true;
  }
}

function waitForTabUrl(tabId, expectedUrl, timeoutMs = MESSAGE_TIMEOUT, intervalMs = 200) {
  if (!expectedUrl) {
    return Promise.resolve();
  }

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      chrome.tabs.get(tabId, tab => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }

        if (urlsRoughlyMatch(expectedUrl, tab.url)) {
          resolve();
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          reject(new Error('Tab URL did not reach expected value in time.'));
          return;
        }

        setTimeout(poll, intervalMs);
      });
    };

    poll();
  });
}

function broadcastBatchUpdate(type, data = {}, overrideRunning) {
  const running = typeof overrideRunning === 'boolean' ? overrideRunning : batchState.isRunning;
  const payload = {
    action: 'batchUpdate',
    type,
    running,
    processed: data.processed ?? batchState.processed,
    failed: data.failed ?? batchState.failed,
    total: data.total ?? batchState.total,
    cancelRequested: batchState.cancelRequested,
    message: data.message || '',
    level: data.level || 'info'
  };

  lastBatchReport = payload;

  chrome.runtime.sendMessage(payload, () => {
    const error = chrome.runtime.lastError;
    if (error && error.message && !error.message.includes('Receiving end does not exist')) {
      console.warn('Batch update broadcast error:', error.message);
    }
  });
}

function getBatchStatusPayload() {
  if (batchState.isRunning) {
    return {
      running: true,
      processed: batchState.processed,
      failed: batchState.failed,
      total: batchState.total,
      cancelRequested: batchState.cancelRequested,
      message: lastBatchReport.message,
      level: lastBatchReport.level,
      type: lastBatchReport.type
    };
  }

  const { action, ...rest } = lastBatchReport;
  return { running: false, ...rest };
}

function sanitizeName(value, fallback = 'page') {
  if (!value || typeof value !== 'string') return fallback;
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || fallback;
}

function getUniqueFileName(desired) {
  const base = sanitizeName(desired, 'page');
  let candidate = base;
  let counter = 1;
  while (batchState.fileNames.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  batchState.fileNames.add(candidate);
  return candidate;
}

function resetBatchState() {
  batchState = createInitialBatchState();
}

function cancelBatchProcessing() {
  if (!batchState.isRunning) {
    return false;
  }
  batchState.cancelRequested = true;
  broadcastBatchUpdate('cancelling', {
    message: `Cancelling... processed ${batchState.processed}/${batchState.total}.`
  });
  return true;
}

async function restoreOriginalPage() {
  if (!batchState.tabId || !batchState.originalUrl) {
    return;
  }
  try {
    await navigateToPage(batchState.tabId, batchState.originalUrl);
  } catch (error) {
    console.warn('Failed to restore original page:', error.message);
  } finally {
    batchState.originalUrl = null;
  }
}

function waitForNavigation(tabId, expectedUrl) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Navigation timeout.'));
    }, MESSAGE_TIMEOUT);
    let settled = false;

    const tabUrlWait = waitForTabUrl(tabId, expectedUrl).then(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }).catch(error => {
      // Não falha aqui; deixamos o evento de navegação decidir.
      console.warn('waitForTabUrl warning:', error.message);
    });

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
    }

    function onCompleted(details) {
      if (details.tabId === tabId && details.frameId === 0 && urlsRoughlyMatch(expectedUrl, details.url)) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
    }

    function onError(details) {
      if (details.tabId === tabId && details.frameId === 0) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(details.error || 'Navigation error'));
      }
    }

    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
  });
}

function navigateToPage(tabId, url) {
  markTabPending(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      waitForNavigation(tabId, url).then(resolve).catch(reject);
    });
  });
}

async function waitForPageContent(tabId, expectedUrl) {
  try {
    const response = await sendMessageToTab(tabId, {
      action: 'waitForContentReady',
      expectedUrl,
      timeoutMs: CONTENT_READY_TIMEOUT,
      minTextLength: CONTENT_READY_MIN_TEXT
    });
    return response || null;
  } catch (error) {
    console.warn('waitForContentReady failed:', error.message);
    return null;
  }
}

function isMarkdownSuspiciouslyEmpty(markdown, readiness) {
  const length = (markdown || '').trim().length;
  if (length >= 80) return false;
  const metrics = readiness?.metrics;
  if (!metrics) {
    return length < 20;
  }
  const contentLooksSubstantial = metrics.textLength >= CONTENT_READY_MIN_TEXT || metrics.meaningfulCount >= 6 || metrics.hasMermaid;
  return contentLooksSubstantial && length < 80;
}

async function processSinglePage(page) {
  if (batchState.cancelRequested) return;

  const currentStep = batchState.processed + batchState.failed + 1;
  batchState.currentTitle = page.title;
  broadcastBatchUpdate('processing', {
    message: `Processing ${currentStep}/${batchState.total}: ${page.title}`
  });

  await navigateToPage(batchState.tabId, page.url);
  if (batchState.cancelRequested) return;

  // Aguarda conteúdo real renderizar (importante para SPA como app.devin.ai)
  const readiness = await waitForPageContent(batchState.tabId, page.url);

  let convertResponse = await sendMessageToTab(batchState.tabId, { action: 'convertToMarkdown' });
  if (!convertResponse || !convertResponse.success) {
    throw new Error(convertResponse?.error || 'Conversion failed');
  }

  // Se parece vazio mas a página aparenta ter conteúdo, tenta novamente após um pequeno delay
  if (isMarkdownSuspiciouslyEmpty(convertResponse.markdown, readiness)) {
    console.warn('Suspiciously empty markdown, retrying once:', {
      title: page.title,
      url: page.url,
      readiness
    });
    await sleep(900);
    const retryReadiness = await waitForPageContent(batchState.tabId, page.url);
    const retryResponse = await sendMessageToTab(batchState.tabId, { action: 'convertToMarkdown' });
    if (retryResponse && retryResponse.success) {
      convertResponse = retryResponse;
      if (isMarkdownSuspiciouslyEmpty(convertResponse.markdown, retryReadiness || readiness)) {
        throw new Error('Converted markdown appears empty after retry.');
      }
    } else {
      throw new Error(retryResponse?.error || 'Conversion retry failed');
    }
  }

  const fileName = getUniqueFileName(convertResponse.markdownTitle || page.title);
  batchState.convertedPages.push({ title: fileName, content: convertResponse.markdown });
  batchState.processed += 1;
  broadcastBatchUpdate('pageProcessed', {
    message: `Converted ${batchState.processed}/${batchState.total}: ${page.title}`
  });

  // Pequeno respiro para evitar navegação agressiva demais
  await sleep(250);
}

async function createZipArchive() {
  const zip = new JSZip();
  let indexContent = `# ${batchState.folderName}\n\n## Content Index\n\n`;

  batchState.convertedPages.forEach(page => {
    indexContent += `- [${page.title}](${page.title}.md)\n`;
    zip.file(`${page.title}.md`, page.content);
  });

  zip.file('README.md', indexContent);

  const base64Zip = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  const dataUrl = `data:application/zip;base64,${base64Zip}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: `${batchState.folderName}.zip`,
      saveAs: true
    }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function runBatchProcessing() {
  try {
    for (const page of batchState.pages) {
      if (batchState.cancelRequested) {
        break;
      }

      try {
        await processSinglePage(page);
      } catch (error) {
        batchState.failed += 1;
        broadcastBatchUpdate('pageFailed', {
          message: `Failed ${page.title}: ${error.message || error}`,
          level: 'error'
        });
      }
    }

    if (batchState.cancelRequested) {
      batchState.isRunning = false;
      broadcastBatchUpdate('cancelled', {
        message: `Batch cancelled. Success ${batchState.processed}, Failed ${batchState.failed}.`
      }, false);
      return;
    }

    if (!batchState.convertedPages.length) {
      throw new Error('No pages were converted successfully.');
    }

    broadcastBatchUpdate('zipping', {
      message: `Creating ZIP with ${batchState.convertedPages.length} files...`
    });

    await createZipArchive();

    batchState.isRunning = false;
    broadcastBatchUpdate('completed', {
      message: `ZIP ready. Success ${batchState.processed}, Failed ${batchState.failed}.`,
      level: 'success'
    }, false);
  } catch (error) {
    batchState.isRunning = false;
    broadcastBatchUpdate('error', {
      message: error.message || 'Batch conversion failed.',
      level: 'error'
    }, false);
  } finally {
    await restoreOriginalPage();
    resetBatchState();
  }
}

function sanitizeFolderName(value) {
  return sanitizeName(value, 'deepwiki');
}

function getTabById(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function startBatchProcessing(tabId) {
  if (batchState.isRunning) {
    throw new Error('Batch conversion already running.');
  }

  const tab = await getTabById(tabId);
  
  // ALTERADO AQUI
  if (!isValidUrl(tab.url)) {
    throw new Error('Please open a DeepWiki or Devin page before starting batch conversion.');
  }

  const extraction = await sendMessageToTab(tabId, { action: 'extractAllPages' });
  if (!extraction || !extraction.success) {
    throw new Error(extraction?.error || 'Failed to extract sidebar links.');
  }

  const extractedPages = extraction.pages || [];
  const pages = filterPagesToProject(extractedPages, tab.url);
  if (!pages.length) {
    throw new Error('No child pages were detected for the current project.');
  }

  batchState = {
    isRunning: true,
    tabId,
    originalUrl: tab.url,
    pages,
    convertedPages: [],
    folderName: sanitizeFolderName(extraction.headTitle || extraction.currentTitle || 'deepwiki'),
    processed: 0,
    failed: 0,
    cancelRequested: false,
    total: pages.length,
    currentTitle: '',
    fileNames: new Set()
  };

  broadcastBatchUpdate('started', {
    message: `Found ${batchState.total} pages. Starting batch conversion...`
  });

  runBatchProcessing();

  return {
    total: batchState.total,
    folderName: batchState.folderName
  };
}

// Listen for extension installation event
chrome.runtime.onInstalled.addListener(() => {
  console.log('DeepWiki to Markdown extension installed');
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('Message from page:', request.message);
    return;
  }

  if (request.action === 'contentScriptReady') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ status: 'no-tab' });
      return;
    }

    if (!messageQueue[tabId]) {
      messageQueue[tabId] = { isReady: true, queue: [] };
    } else {
      messageQueue[tabId].isReady = true;
    }
    flushMessageQueue(tabId);
    sendResponse({ status: 'ready' });
    return;
  }

  if (request.action === 'startBatch') {
    const tabId = request.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tabId for batch start.' });
      return;
    }

    startBatchProcessing(tabId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'cancelBatch') {
    const cancelled = cancelBatchProcessing();
    sendResponse({ success: cancelled });
    return;
  }

  if (request.action === 'getBatchStatus') {
    sendResponse(getBatchStatusPayload());
    return;
  }

  if (request.action === 'pageLoaded' || request.action === 'tabActivated') {
    sendResponse({ received: true });
    return;
  }

  return false;
});

// Listen for tab updates to reset readiness and notify content scripts
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // ALTERADO AQUI
  if (!isValidUrl(tab.url)) {
    return;
  }

  // Marque como pending apenas no início da navegação (ou quando a URL muda).
  // Marcar em "complete" pode sobrescrever um contentScriptReady já recebido.
  if (changeInfo.status === 'loading' || changeInfo.url) {
    markTabPending(tabId);
  }

  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { action: 'pageLoaded' }, () => {
      const error = chrome.runtime.lastError;
      if (error && !error.message.includes('Receiving end does not exist')) {
        console.log('Page loaded ping error:', error.message);
      }
    });
  }
});

// Keep content script informed when a DeepWiki tab becomes active
chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, tab => {
    // ALTERADO AQUI
    if (tab && isValidUrl(tab.url)) {
      chrome.tabs.sendMessage(activeInfo.tabId, { action: 'tabActivated' }, () => {
        const error = chrome.runtime.lastError;
        if (error && !error.message.includes('Receiving end does not exist')) {
          console.log('Tab activated ping error:', error.message);
        }
      });
    }
  });
});

// Clean up the queue when a tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  if (messageQueue[tabId]) {
    messageQueue[tabId].queue.forEach(item => item.reject(new Error('Tab closed.')));
    delete messageQueue[tabId];
  }

  if (batchState.isRunning && batchState.tabId === tabId) {
    batchState.isRunning = false;
    batchState.cancelRequested = true;
    broadcastBatchUpdate('error', {
      message: 'Batch cancelled because the tab was closed.',
      level: 'error'
    }, false);
    resetBatchState();
  }
});
