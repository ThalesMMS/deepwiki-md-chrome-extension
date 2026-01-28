importScripts('lib/jszip.min.js');

const MESSAGE_TIMEOUT = 30000;
const messageQueue = {};
const CONTENT_READY_TIMEOUT = 20000;
const CONTENT_READY_MIN_TEXT = 160;

/**
 * Pause execution for a specified duration.
 * @param {number} ms - Duration to wait in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the specified delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines whether a URL string refers to a supported site (deepwiki.com or devin.ai).
 * @param {string} url - The URL string to validate.
 * @returns {boolean} `true` if the URL is non-empty and contains 'deepwiki.com' or 'devin.ai', `false` otherwise.
 */
function isValidUrl(url) {
  return url && (url.includes('deepwiki.com') || url.includes('devin.ai'));
}

/**
 * Derives the site-specific project path prefix from a page URL.
 *
 * For devin.ai this typically returns a prefix like `/wiki/{owner}`; for DeepWiki/other wikis it typically returns `/wiki/{owner}/{repo}`. Falls back to the first one or two path segments or `/` when markers are absent.
 * @param {string} urlString - The full page URL to analyze.
 * @returns {string|null} The project path prefix starting with `/` used to group pages by project, or `null` if the URL could not be parsed.
 */
function getProjectPrefix(urlString) {
  try {
    const url = new URL(urlString);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const hostname = url.hostname;

    // Devin.ai wiki structure: /wiki/{owner}/{page_slug}
    // The owner level is the project scope, not the page
    const isDevinAi = hostname.includes('devin.ai');

    // If we have a clear marker like "wiki" or "docs", we want to grab everything up to that point
    // plus the appropriate number of segments based on the site
    const markerIdx = pathSegments.findIndex(seg => ['deepwiki', 'wiki', 'docs'].includes(seg.toLowerCase()));

    if (markerIdx >= 0) {
       // For Devin.ai: /wiki/{owner} is the project scope (marker + 1 segment)
       // For DeepWiki: /wiki/{owner}/{repo} is the project scope (marker + 2 segments)
       const segmentsAfterMarker = pathSegments.length - (markerIdx + 1);

       if (isDevinAi) {
         // Devin.ai: /wiki/Owner is the project prefix (all pages under this owner)
         if (segmentsAfterMarker >= 1) {
           return `/${pathSegments.slice(0, markerIdx + 2).join('/')}`;
         }
         return `/${pathSegments.slice(0, markerIdx + 1).join('/')}`;
       }

       // DeepWiki and others: /wiki/Owner/Repo is the project prefix
       if (segmentsAfterMarker >= 2) {
           return `/${pathSegments.slice(0, markerIdx + 3).join('/')}`;
       }
       return `/${pathSegments.slice(0, markerIdx + 2).join('/')}`;
    }

    // Fallbacks for paths without markers
    if (pathSegments.length >= 2) {
      return `/${pathSegments.slice(0, 2).join('/')}`;
    }
    if (pathSegments.length === 1) {
      return `/${pathSegments[0]}`;
    }
    return '/';
  } catch (error) {
    console.warn('Failed to derive project prefix:', error.message);
    return null;
  }
}

/**
 * Selects pages that belong to the same project/context as the provided current page URL.
 *
 * Filters the input pages to those that are same-origin and relevant to the current project:
 * - For devin.ai pages: keeps only links whose path equals the current page's path (topics are treated as hash sections of the same page).
 * - For other sites: keeps links whose path starts with a derived project prefix; if a prefix cannot be derived, keeps all same-origin links.
 * If the provided currentUrl is invalid, a warning is logged and the original pages array (or an empty array if none) is returned.
 *
 * @param {Array<{url: string}>} pages - Array of page objects with a `url` property to be filtered.
 * @param {string} currentUrl - The current page URL used to determine project scope.
 * @returns {Array<{url: string}>} The subset of pages that belong to the same project/context.
function filterPagesToProject(pages, currentUrl) {
  let base;
  try {
    base = new URL(currentUrl);
  } catch (error) {
    console.warn('Invalid current URL for filtering:', error.message);
    return pages || [];
  }

  const isDevinAi = base.hostname.includes('devin.ai');
  const currentPathNormalized = base.pathname.replace(/\/$/, '');

  // Use the robust prefix calculation
  const prefix = getProjectPrefix(currentUrl);

  if (!Array.isArray(pages) || pages.length === 0) {
    return [];
  }

  const filtered = pages.filter(page => {
    try {
      const pageUrl = new URL(page.url, base.origin);
      if (pageUrl.origin !== base.origin) return false;

      // For Devin.ai: Only keep links to the SAME page (topics are hash sections)
      if (isDevinAi) {
        const pagePathNormalized = pageUrl.pathname.replace(/\/$/, '');
        return pagePathNormalized === currentPathNormalized;
      }

      // For DeepWiki: Use the project prefix filter
      if (!prefix) return true;
      return pageUrl.pathname.startsWith(prefix);
    } catch (error) {
      return false;
    }
  });

  console.log('[Batch Debug] Filtering Report:', {
    currentUrl: currentUrl,
    siteType: isDevinAi ? 'devin.ai (same-page filter)' : 'deepwiki (prefix filter)',
    derivedPrefix: prefix,
    totalReceived: pages.length,
    kept: filtered.length,
    dropped: pages.length - filtered.length
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

/**
 * Send a message to a tab, using direct delivery when possible and queueing the message if the tab is marked not ready or the error indicates the message should be retried later.
 * @param {number} tabId - The target tab id.
 * @param {any} message - The message payload to send to the tab.
 * @returns {Promise<any>} The tab's response value; resolves when the message is delivered and the tab responds, or rejects if delivery fails with a non-queueable error.
 */
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

/**
 * Determines whether two URLs refer to the same page context, allowing flexible path-prefix matches while enforcing exact hash equality when present.
 * @param {string} expectedUrl - The reference URL; may be a prefix of the actual URL's path.
 * @param {string} actualUrl - The URL to compare against the reference.
 * @returns {boolean} `true` if either input is missing or unparsable, or if both origins match and one path starts with the other (and hashes match when the expected URL includes a hash); `false` otherwise.
 */
function urlsRoughlyMatch(expectedUrl, actualUrl) {
  if (!expectedUrl || !actualUrl) return true;
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(actualUrl);
    if (expected.origin !== actual.origin) return false;
    
    // STRICT hash check for SPA navigation
    if (expected.hash && expected.hash !== actual.hash) {
        return false;
    }

    return actual.pathname.startsWith(expected.pathname) ||
      expected.pathname.startsWith(actual.pathname);
  } catch (error) {
    return true;
  }
}

/**
 * Waits until a tab's URL roughly matches the given expected URL or fails when the timeout elapses.
 * @param {number} tabId - The ID of the tab to monitor.
 * @param {string} expectedUrl - The target URL to match; if falsy, the function resolves immediately.
 * @param {number} [timeoutMs=30000] - Maximum time in milliseconds to wait before rejecting.
 * @param {number} [intervalMs=200] - Polling interval in milliseconds between checks.
 * @returns {Promise<void>} Resolves when the tab's URL matches `expectedUrl`; rejects with an Error if the tab cannot be accessed or the timeout is reached.
 */
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

/**
 * Broadcasts the current batch processing status to the extension runtime.
 *
 * Builds a payload containing the provided `type`, merged progress fields (processed, failed, total)
 * from `data` or current batch state, the running flag (overridden when `overrideRunning` is boolean),
 * cancelRequested, and optional message/level; stores it to `lastBatchReport` and sends it via runtime messaging.
 *
 * @param {string} type - The batch update type (e.g., 'started', 'progress', 'completed', 'error', 'cancelled').
 * @param {Object} [data={}] - Optional fields to include or override in the payload.
 * @param {number} [data.processed] - Number of pages processed so far.
 * @param {number} [data.failed] - Number of pages that failed processing.
 * @param {number} [data.total] - Total number of pages in the batch.
 * @param {string} [data.message] - Human-readable message to include with the update.
 * @param {string} [data.level] - Severity level for the message (defaults to 'info').
 * @param {boolean} [overrideRunning] - When boolean, forces the `running` flag in the payload; otherwise uses current batch state.
 */
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

/**
 * Navigate the batch's tab back to the original URL saved at batch start, if present.
 *
 * If an original URL is stored and a tab is associated with the current batch, attempts to navigate that tab to the saved URL. Clears the stored original URL regardless of success; navigation failures are caught and logged as warnings.
 */
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

/**
 * Waits until the given tab finishes navigating to a URL that matches the expected target.
 * @param {number} tabId - The ID of the tab to monitor.
 * @param {string} expectedUrl - The target URL to match against the tab's navigation events.
 * @returns {Promise<void>} Resolves when the tab completes navigation to a URL that roughly matches `expectedUrl`; rejects with an Error if navigation fails or a timeout occurs.
 */
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

/**
 * Determines whether two URLs refer to the same resource but differ only by the fragment (hash).
 * @param {string} currentUrl - The current URL string.
 * @param {string} targetUrl - The target URL string.
 * @returns {boolean} `true` if both URLs have the same origin and path and their hashes are different, `false` otherwise.
 */
function isHashChange(currentUrl, targetUrl) {
  if (!currentUrl || !targetUrl) return false;
  try {
    const curr = new URL(currentUrl);
    const tgt = new URL(targetUrl);
    const currPath = curr.pathname.replace(/\/$/, '');
    const tgtPath = tgt.pathname.replace(/\/$/, '');
    
    return curr.origin === tgt.origin && 
           currPath === tgtPath && 
           curr.hash !== tgt.hash;
  } catch (e) {
    return false;
  }
}

/**
 * Navigate the given tab to a target URL, using an in-page hash update when possible.
 *
 * If the change is a hash-only navigation, attempts to update window.location.hash in-page
 * and waits for the tab's URL to reflect the change. For non-hash navigations, marks the tab
 * as pending (to defer runtime messages) and performs a full tab update, then waits for
 * navigation completion.
 *
 * @param {number} tabId - ID of the tab to navigate.
 * @param {string} url - Destination URL to navigate the tab to.
 * @returns {Promise<void>} Resolves when navigation and any required waiting for the tab URL complete.
 * @throws {Error} If the tab update or the subsequent wait fails (e.g., chrome.runtime.lastError or timeout).
 */
async function navigateToPage(tabId, url) {
  const tab = await getTabById(tabId);
  const hashOnly = isHashChange(tab.url, url);
  
  if (hashOnly) {
     console.log('[Background] Hash change detected. Injecting location update script.');
     try {
       await chrome.scripting.executeScript({
         target: { tabId },
         func: (destUrl) => {
           // Push state or set href? Set href with hash usually just scrolls.
           // Let's try explicit hash setting if purely hash
           const u = new URL(destUrl);
           if (window.location.hash !== u.hash) {
             window.location.hash = u.hash;
           }
         },
         args: [url]
       });
       // Now wait for it to stick
       await waitForTabUrl(tabId, url);
     } catch (err) {
       console.warn('Script navigation failed, falling back:', err);
       return new Promise((resolve, reject) => {
         chrome.tabs.update(tabId, { url }, () => {
             // ... handling
             if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
             else waitForTabUrl(tabId, url).then(resolve).catch(reject);
         });
       });
     }
     return;
  }

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

/**
 * Waits for a tab's page content to reach readiness matching an expected URL.
 * @param {number} tabId - ID of the tab to query.
 * @param {string} expectedUrl - URL expected for the page whose content readiness is awaited.
 * @returns {Object|null} Readiness data from the content script when content is ready, or `null` on timeout or error.
 */
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

/**
 * Detects whether converted Markdown appears suspiciously empty compared to page readiness signals.
 * @param {string} markdown - The converted Markdown text to evaluate.
 * @param {Object} readiness - Optional readiness object containing content metrics.
 * @param {Object} readiness.metrics - Metrics about the page content.
 * @param {number} readiness.metrics.textLength - Estimated text length of the source content.
 * @param {number} readiness.metrics.meaningfulCount - Count of meaningful content elements detected.
 * @param {boolean} readiness.metrics.hasMermaid - Whether the page contains Mermaid diagrams.
 * @returns {boolean} `true` if the Markdown is likely too empty given the readiness metrics (or very short when metrics are absent), `false` otherwise.
 */
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

/**
 * Process a single page in the current batch: navigate or select the correct topic, wait for content readiness,
 * convert the page to Markdown, store the result in batch state, and emit progress updates.
 *
 * @param {Object} page - Page descriptor with properties used for processing.
 * @param {string} page.title - The page or topic title used for reporting and topic selection.
 * @param {string} page.url - The full target URL for navigation or hash selection.
 * @param {number} [page.devinIndex] - If present and an integer, indicates a Devin.ai topic index to select on the page.
 * @param {string|number} [page.numberPrefix] - Optional prefix to prepend to the output file name.
 *
 * @throws {Error} If topic selection fails, conversion fails, retry conversion fails, or converted markdown is empty after retry.
 */
async function processSinglePage(page) {
  if (batchState.cancelRequested) return;

  const currentStep = batchState.processed + batchState.failed + 1;
  batchState.currentTitle = page.title;
  broadcastBatchUpdate('processing', {
    message: `Processing ${currentStep}/${batchState.total}: ${page.title}`
  });

  const tab = await getTabById(batchState.tabId);
  const isDevinTopic = Number.isInteger(page.devinIndex);

  // Parse URLs for comparison
  let currentUrl, targetUrl;
  try {
    currentUrl = new URL(tab.url);
    targetUrl = new URL(page.url);
  } catch (e) {
    console.warn('[Background] URL parse error:', e.message);
    // Fallback to full navigation
    await navigateToPage(batchState.tabId, page.url);
    return;
  }

  // Check if same page (same origin + pathname)
  const samePage = currentUrl.origin === targetUrl.origin &&
                   currentUrl.pathname.replace(/\/$/, '') === targetUrl.pathname.replace(/\/$/, '');
  const targetHash = targetUrl.hash;

  console.log('[Background] Navigation check:', {
    currentUrl: tab.url,
    targetUrl: page.url,
    samePage,
    targetHash: targetHash || '(none)',
    devinTopic: isDevinTopic
  });

  let readiness = null;
  let devinSignature = null;

  if (isDevinTopic) {
    if (!samePage) {
      console.log('[Background] Devin topic: navigating to base page:', page.url);
      await navigateToPage(batchState.tabId, page.url);
    }

    const signatureResponse = await sendMessageToTab(batchState.tabId, { action: 'getContentSignature' });
    devinSignature = signatureResponse?.signature || null;

    const selection = await sendMessageToTab(batchState.tabId, {
      action: 'selectDevinTopic',
      index: page.devinIndex,
      title: page.title
    });
    if (!selection || !selection.success) {
      throw new Error(selection?.error || 'Failed to select Devin topic.');
    }

    // Give the page a moment to start rendering the new topic
    await sleep(350);

    const topicReady = await sendMessageToTab(batchState.tabId, {
      action: 'waitForTopicReady',
      expectedTitle: page.title,
      previousSignature: devinSignature,
      timeoutMs: CONTENT_READY_TIMEOUT,
      minTextLength: CONTENT_READY_MIN_TEXT
    });

    if (topicReady?.timedOut) {
      console.warn('[Background] Devin topic readiness timed out:', {
        title: page.title,
        url: page.url,
        details: topicReady
      });
    }

    readiness = topicReady;
  } else {
    if (samePage) {
      // Same page - use hash navigation (no page reload)
      if (targetHash && targetHash !== currentUrl.hash) {
        // Navigate to a different hash
        console.log('[Background] Hash navigation to:', targetHash);
        try {
          await chrome.scripting.executeScript({
            target: { tabId: batchState.tabId },
            func: (newHash) => {
              window.location.hash = newHash;
            },
            args: [targetHash]
          });
          await sleep(500);
        } catch (err) {
          console.warn('[Background] Hash navigation failed:', err);
        }
      } else if (!targetHash || targetHash === currentUrl.hash) {
        // Same hash or base URL - no navigation needed
        console.log('[Background] Same location or base URL - no navigation');
        await sleep(100);
      }
    } else {
      // Different page - full navigation
      console.log('[Background] Full page navigation to:', page.url);
      await navigateToPage(batchState.tabId, page.url);
    }

    if (batchState.cancelRequested) return;

    // For same-page (hash) navigation, skip heavy content waiting - content is already loaded
    if (!samePage) {
      // Aguarda conteúdo real renderizar (para navegação entre páginas diferentes)
      readiness = await waitForPageContent(batchState.tabId, page.url);
    }
  }

  if (batchState.cancelRequested) return;

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
    const retryReadiness = isDevinTopic
      ? await sendMessageToTab(batchState.tabId, {
        action: 'waitForTopicReady',
        expectedTitle: page.title,
        previousSignature: devinSignature,
        timeoutMs: CONTENT_READY_TIMEOUT,
        minTextLength: CONTENT_READY_MIN_TEXT
      })
      : await waitForPageContent(batchState.tabId, page.url);
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

  let baseTitle = convertResponse.markdownTitle || page.title;
  if (page.numberPrefix) {
    baseTitle = `${page.numberPrefix}-${baseTitle}`;
  }
  const fileName = getUniqueFileName(baseTitle);
  batchState.convertedPages.push({ title: fileName, content: convertResponse.markdown });
  
  // Increment processed count
  batchState.processed += 1;
  
  broadcastBatchUpdate('pageProcessed', {
    message: `Converted ${batchState.processed}/${batchState.total}: ${page.title}`
  });

  // Pequeno respiro
  await sleep(250);
}

/**
 * Create a ZIP archive containing all converted Markdown files and initiate a browser download.
 *
 * Builds an index README listing each page, adds each converted page as `TITLE.md` to the archive,
 * compresses the archive, and starts a download named after the batch folder.
 *
 * @returns {Promise<void>} Resolves when the download has been initiated, rejects with an Error if the download API reports an error.
 */
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

/**
 * Orchestrates processing of all pages in the current batch, producing a ZIP of converted files.
 *
 * Processes pages in sequence, updating batch progress and broadcasting status events. Stops early if
 * batch cancellation is requested. If at least one page is converted, creates a ZIP archive and
 * broadcasts completion; if no pages are converted, signals an error. Always resets batch state at
 * the end of the run.
 *
 * Side effects:
 * - Broadcasts batch lifecycle updates (started/processing/pageFailed/zipping/completed/cancelled/error).
 * - May create and trigger a ZIP download for converted pages.
 * - Resets the global batch state when finished.
 *
 * @throws {Error} If no pages were converted successfully.
 */
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
    // Don't restore original page - user prefers to stay on last processed page to preserve console logs
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

/**
 * Initiates a batch conversion of pages for the project associated with the given tab.
 * @param {number} tabId - ID of the browser tab to start the batch from.
 * @returns {{total: number, folderName: string}} Object containing the number of pages to convert and the chosen output folder name.
 * @throws {Error} If a batch is already running.
 * @throws {Error} If the tab's URL is not a supported DeepWiki or Devin page.
 * @throws {Error} If extraction from the content script fails or no project pages are found.
 */
async function startBatchProcessing(tabId) {
  if (batchState.isRunning) {
    throw new Error('Batch conversion already running.');
  }

  const tab = await getTabById(tabId);
  
  console.log('[Background] startBatchProcessing called for tab:', tabId);
  
  // ALTERADO AQUI
  if (!isValidUrl(tab.url)) {
    console.error('[Background] Invalid URL:', tab.url);
    throw new Error('Please open a DeepWiki or Devin page before starting batch conversion.');
  }

  console.log('[Background] Sending extractAllPages to content script...');
  const extraction = await sendMessageToTab(tabId, { action: 'extractAllPages' });
  console.log('[Background] Extraction response:', extraction);
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
      messageQueue[tabId] = { isReady: true, queue: [], lastUrl: sender.tab?.url };
    } else {
      messageQueue[tabId].isReady = true;
      if (sender.tab?.url) {
        messageQueue[tabId].lastUrl = sender.tab.url;
      }
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

  // Only mark as pending for actual page navigation, NOT hash-only changes
  // Hash-only changes don't reload the content script, so we shouldn't block messages
  if (changeInfo.status === 'loading') {
    const entry = messageQueue[tabId];
    if (entry && entry.lastUrl) {
      try {
        const oldUrl = new URL(entry.lastUrl);
        const newUrl = new URL(tab.url || changeInfo.url || entry.lastUrl);
        const sameBase = oldUrl.origin === newUrl.origin &&
                         oldUrl.pathname === newUrl.pathname;
        if (!sameBase) {
          markTabPending(tabId);
        } else {
          console.log('[Background] Hash-only loading detected, not marking pending:', newUrl.href);
        }
      } catch (e) {
        markTabPending(tabId);
      }
    } else {
      markTabPending(tabId);
    }
  } else if (changeInfo.url) {
    // Check if this is just a hash change (same page, different hash)
    const entry = messageQueue[tabId];
    if (entry && entry.lastUrl) {
      try {
        const oldUrl = new URL(entry.lastUrl);
        const newUrl = new URL(changeInfo.url);
        const sameBase = oldUrl.origin === newUrl.origin &&
                         oldUrl.pathname === newUrl.pathname;
        if (sameBase) {
          // Hash-only change - don't mark as pending
          console.log('[Background] Hash-only URL change, not marking pending:', changeInfo.url);
        } else {
          markTabPending(tabId);
        }
      } catch (e) {
        markTabPending(tabId);
      }
    } else {
      markTabPending(tabId);
    }
    // Store the URL for future comparison
    if (!messageQueue[tabId]) {
      messageQueue[tabId] = { isReady: true, queue: [], lastUrl: changeInfo.url };
    } else {
      messageQueue[tabId].lastUrl = changeInfo.url;
    }
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