function normalizeUrlKey(urlObj) {
  try {
    const normalized = new URL(urlObj.href);
    const path = normalized.pathname.replace(/\/$/, '');
    normalized.pathname = path === '' ? '/' : path;
    return `${normalized.origin}${normalized.pathname}${normalized.search}${normalized.hash}`;
  } catch (e) {
    return urlObj.href;
  }
}

function getElementTitle(element) {
  const rawText = (element.textContent || '').replace(/\s+/g, ' ').trim();
  if (rawText) return rawText;
  const aria = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-title');
  if (aria) return aria.trim();
  const imgAlt = element.querySelector('img[alt]')?.getAttribute('alt');
  return imgAlt ? imgAlt.trim() : '';
}

function expandAllNavSections(navRoot) {
  const toggles = Array.from(navRoot.querySelectorAll(
    'button[aria-expanded="false"], [role="button"][aria-expanded="false"], details:not([open]) > summary, [data-state="closed"][aria-controls]'
  )).filter(el => el.tagName !== 'A');

  toggles.forEach(toggle => {
    if (toggle.tagName === 'SUMMARY') {
      const details = toggle.closest('details');
      if (details && !details.open) {
        details.open = true;
      }
    } else if (typeof toggle.click === 'function') {
      toggle.click();
    }
  });

  return toggles.length;
}

function findDevinTopicButtons() {
  const containers = Array.from(document.querySelectorAll(
    'aside, nav, [class*="border-r"], [class*="sidebar"], [class*="drawer"]'
  ));

  const buttons = [];
  const seen = new Set();
  containers.forEach(container => {
    expandAllNavSections(container);
    const listButtons = Array.from(container.querySelectorAll('ul li button'));
    listButtons.forEach(btn => {
      const title = getElementTitle(btn);
      if (title && !seen.has(btn)) {
        seen.add(btn);
        buttons.push(btn);
      }
    });
  });

  if (buttons.length) {
    return buttons;
  }

  // Fallback: any buttons inside list items
  return Array.from(document.querySelectorAll('ul li button')).filter(btn => getElementTitle(btn));
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "convertToMarkdown") {
    try {
      // Get page title from head
      const headTitle = document.title || "";
      const formattedHeadTitle = headTitle.replace(/[\/|]/g, '-').replace(/\s+/g, '-').replace('---','-');

      // --- ESTRATÉGIA DE SELEÇÃO DE TÍTULO ---
      const title =
        document.querySelector('.container > div:nth-child(1) a[data-selected="true"]')?.textContent?.trim() ||
        document.querySelector("main h1")?.textContent?.trim() ||
        document.querySelector("article h1")?.textContent?.trim() ||
        document.querySelector("h1")?.textContent?.trim() ||
        "Untitled";

      // --- ESTRATÉGIA DE SELEÇÃO DE CONTEÚDO (Ultra Robusta) ---
      // Prioriza containers semânticos ou específicos de documentação
      const contentContainer = selectContentContainer();

      let markdown = ``;
      let markdownTitle = title.replace(/\s+/g, '-');

      contentContainer.childNodes.forEach((child) => {
        markdown += processNode(child);
      });

      // Normalize blank lines
      markdown = markdown.trim().replace(/\n{3,}/g, "\n\n");

      // --- INTEGRAÇÃO: DEEPWIKI LINK FIX ---
      console.log("Applying DeepWiki Fixes...");
      markdown = DeepWikiFixer.process(markdown);
      // -------------------------------------

      sendResponse({ 
        success: true, 
        markdown, 
        markdownTitle,
        headTitle: formattedHeadTitle
      });
    } catch (error) {
      console.error("Error converting to Markdown:", error);
      sendResponse({ success: false, error: error.message });
    }
  } else if (request.action === "extractAllPages") {
    (async () => {
      try {
      const headTitle = document.title || "";
      const formattedHeadTitle = headTitle.replace(/[\/|]/g, '-').replace(/\s+/g, '-').replace('---','-');
      const baseUrl = window.location.href;
      const baseOrigin = window.location.origin;
      const currentPath = window.location.pathname || "/";
      const hostname = window.location.hostname;

      // Detect site type for appropriate prefix depth
      const isDevinAi = hostname.includes('devin.ai');

      // Deriva prefixos do "projeto atual" a partir da URL corrente
      const pathSegments = currentPath.split("/").filter(Boolean);

      // For Devin.ai: /wiki/{owner} is the project scope (owner level, not page level)
      // For DeepWiki: /wiki/{owner}/{repo} is the project scope
      const markerIdx = pathSegments.findIndex(seg => ['deepwiki', 'wiki', 'docs'].includes(seg.toLowerCase()));

      let defaultPrefix = "/";
      if (markerIdx >= 0) {
        if (isDevinAi) {
          // Devin.ai: /wiki/Owner is the project prefix
          const segmentsAfterMarker = pathSegments.length - (markerIdx + 1);
          if (segmentsAfterMarker >= 1) {
            defaultPrefix = `/${pathSegments.slice(0, markerIdx + 2).join("/")}`;
          } else {
            defaultPrefix = `/${pathSegments.slice(0, markerIdx + 1).join("/")}`;
          }
        } else {
          // DeepWiki: /wiki/Owner/Repo is the project prefix
          const segmentsAfterMarker = pathSegments.length - (markerIdx + 1);
          if (segmentsAfterMarker >= 2) {
            defaultPrefix = `/${pathSegments.slice(0, markerIdx + 3).join("/")}`;
          } else {
            defaultPrefix = `/${pathSegments.slice(0, markerIdx + 2).join("/")}`;
          }
        }
      } else if (pathSegments.length >= 2) {
        defaultPrefix = `/${pathSegments.slice(0, 2).join("/")}`;
      } else if (pathSegments.length === 1) {
        defaultPrefix = `/${pathSegments[0]}`;
      }

      // Only generate prefix candidates at or shorter than the default prefix depth
      const prefixCandidates = new Set();
      const defaultDepth = defaultPrefix.split("/").filter(Boolean).length;
      for (let len = 2; len <= defaultDepth; len++) {
        if (len <= pathSegments.length) {
          prefixCandidates.add(`/${pathSegments.slice(0, len).join("/")}`);
        }
      }
      // Always include the computed default
      prefixCandidates.add(defaultPrefix);

      const prefixList = Array.from(prefixCandidates).sort((a, b) => b.length - a.length);

      function resolveUrl(href) {
        try {
          return new URL(href, baseUrl);
        } catch (e) {
          return null;
        }
      }

      // Use the computed default prefix directly - it already accounts for site-specific structure
      const bestPrefix = defaultPrefix;

      function matchesProjectPrefix(urlObj) {
        if (!urlObj) return false;
        if (!bestPrefix) return true;
        return urlObj.pathname.startsWith(bestPrefix);
      }

      // --- ESTRATÉGIA DE SELEÇÃO DE BARRA LATERAL ---
      let sidebarLinks = [];
      const currentPathNormalized = currentPath.replace(/\/$/, '');

      // For Devin.ai: Prefer sidebar buttons (no hrefs), fallback to numeric hash links
      if (isDevinAi) {
        const devinButtons = findDevinTopicButtons();
        if (devinButtons.length > 0) {
          console.log('[Batch Debug] Devin.ai mode: Found topic buttons:', devinButtons.length);
          const pages = devinButtons.map((btn, index) => {
            const title = getElementTitle(btn) || `Topic ${index + 1}`;
            const selected =
              btn.getAttribute('aria-current') === 'true' ||
              btn.getAttribute('aria-selected') === 'true' ||
              btn.classList.contains('selected') ||
              btn.classList.contains('active');
            return {
              url: baseUrl,
              title,
              selected,
              devinIndex: index
            };
          });

          const currentPageTitle =
            document.querySelector("main h1")?.textContent?.trim() ||
            document.querySelector("h1")?.textContent?.trim() ||
            "Untitled";

          sendResponse({
            success: true,
            pages,
            currentTitle: currentPageTitle,
            baseUrl: baseUrl,
            headTitle: formattedHeadTitle
          });
          return;
        }

        console.log('[Batch Debug] Devin.ai mode: Searching for numeric hash topic links...');

        // Find ALL links in the document
        const allLinks = Array.from(document.querySelectorAll('a[href]'));

        // Filter to only topic links (numeric hash patterns like #2, #3, #3.1)
        const topicLinks = allLinks.filter(link => {
          const href = link.getAttribute('href');
          if (!href) return false;

          // Direct hash links like #2, #3, #3.1, #7, etc. (numeric, optionally with dots)
          if (href.match(/^#\d[\d.]*$/)) return true;

          // Full URL links to current page
          const urlObj = resolveUrl(href);
          if (!urlObj) return false;
          const linkPathNormalized = urlObj.pathname.replace(/\/$/, '');

          if (linkPathNormalized === currentPathNormalized) {
            // Include base URL (first topic) or links with numeric hashes
            if (!urlObj.hash) return true; // Base URL = first topic
            return urlObj.hash.match(/^#\d[\d.]*$/); // Numeric hash
          }
          return false;
        });

        console.log('[Batch Debug] Found topic links:', topicLinks.length);
        if (topicLinks.length > 0) {
          console.log('[Batch Debug] Sample links:', topicLinks.slice(0, 10).map(l => l.getAttribute('href')));
        }

        sidebarLinks = topicLinks;
      } else {
        // DeepWiki: Use nav container selection
        const navContainers = Array.from(
          document.querySelectorAll('nav, aside, .sidebar, [class*="sidebar"], [class*="Sidebar"], [class*="menu"], [class*="drawer"]')
        );

        // Log prefix info for debugging
        if (navContainers.length > 0) {
          const allLinkPaths = navContainers
            .flatMap(nav => Array.from(nav.querySelectorAll("a")))
            .map(link => resolveUrl(link.getAttribute("href")))
            .filter(urlObj => urlObj && urlObj.origin === baseOrigin)
            .map(urlObj => urlObj.pathname);

          const matchCount = allLinkPaths.filter(path => path.startsWith(bestPrefix)).length;

          console.log("DeepWiki Batch Debug:", {
            totalLinksScanned: allLinkPaths.length,
            siteType: 'deepwiki',
            chosenPrefix: bestPrefix,
            matchCount: matchCount,
            currentPath
          });
        } else {
          console.log("DeepWiki Batch Debug: No nav containers found.");
        }

        if (navContainers.length > 0) {
          let expandedCount = 0;
          navContainers.forEach(nav => {
            expandedCount += expandAllNavSections(nav);
          });
          if (expandedCount > 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }

          const navCandidates = [];
          navContainers.forEach(nav => {
            const links = Array.from(nav.querySelectorAll("a"));
            if (links.length === 0) return;

            let sameOriginCount = 0;
            let projectMatchCount = 0;

            links.forEach(link => {
              const href = link.getAttribute("href");
              if (!href) return;
              const urlObj = resolveUrl(href);
              if (!urlObj || urlObj.origin !== baseOrigin) return;
              sameOriginCount += 1;
              if (matchesProjectPrefix(urlObj)) {
                projectMatchCount += 1;
              }
            });

            const ratio = sameOriginCount > 0 ? projectMatchCount / sameOriginCount : 0;
            const score = projectMatchCount * 10 + ratio;
            navCandidates.push({ nav, links, sameOriginCount, projectMatchCount, score });
          });

          if (navCandidates.length > 0) {
            const sorted = navCandidates.slice().sort((a, b) => b.score - a.score);
            const best = sorted[0];
            const minProjectMatches = Math.max(2, Math.floor(best.projectMatchCount * 0.6));
            let chosen = navCandidates.filter(candidate => candidate.projectMatchCount >= minProjectMatches);
            if (!chosen.length) {
              chosen = [best];
            }

            console.log('[Batch Debug] Selected Navs:', {
              expandedCount,
              bestScore: best.score,
              minProjectMatches,
              chosenCount: chosen.length
            });

            sidebarLinks = chosen.flatMap(candidate => candidate.links);
          }
        }

        // Fallback específico para DeepWiki original (listas aninhadas)
        if (sidebarLinks.length === 0) {
          console.log('[Batch Debug] Fallback: Trying specific selectors...');
          const nodes = document.querySelectorAll('.border-r-border ul li a, [class*="border-r"] ul li a');
          sidebarLinks = Array.from(nodes);
        }
      }

      console.log('[Batch Debug] Raw Sidebar Links:', sidebarLinks.length);

      // Filtragem e Limpeza dos Links
      const validLinks = sidebarLinks.filter(link => {
         const href = link.getAttribute('href');
         if (!href || href.startsWith('mailto') || href.startsWith('javascript')) return false;

         const urlObj = resolveUrl(href);
         if (!urlObj || urlObj.origin !== baseOrigin) return false;

         if (isDevinAi) {
           // Already filtered during hash link search
           const linkPathNormalized = urlObj.pathname.replace(/\/$/, '');
           if (linkPathNormalized !== currentPathNormalized) return false;
         } else {
           if (!matchesProjectPrefix(urlObj)) return false;
         }

         const fallbackTitle = urlObj.hash ? `Topic-${urlObj.hash.replace('#', '')}` : '';
         const title = getElementTitle(link) || fallbackTitle;
         const text = title.toLowerCase();
         if (['logout', 'sign out', 'settings', 'profile', 'home'].includes(text)) return false;
         if (text.length === 0) return false;

         return true;
      });

      console.log('[Batch Debug] Valid Links after filtering:', validLinks.length);
      if (validLinks.length > 0) {
        console.log('[Batch Debug] Sample valid links:', validLinks.slice(0, 5).map(l => l.getAttribute('href')));
      }

      // Remove duplicatas baseadas na URL
      const uniquePagesMap = new Map();
      validLinks.forEach(link => {
        const urlObj = resolveUrl(link.getAttribute('href'));
        if (!urlObj) return;
        const fullUrl = urlObj.href; // Includes Hash
        const key = normalizeUrlKey(urlObj);
        if (!uniquePagesMap.has(key)) {
            const fallbackTitle = urlObj.hash ? `Topic-${urlObj.hash.replace('#', '')}` : '';
            const linkTitle = getElementTitle(link) || fallbackTitle || "Untitled Page";
            uniquePagesMap.set(key, {
                url: fullUrl,
                title: linkTitle,
                selected: link.getAttribute('data-selected') === 'true' || link.classList.contains('active') || link.classList.contains('selected')
            });
        }
      });
      
      console.log('[Batch Debug] Unique Hashes/Pages:', uniquePagesMap.size);

      let pages = Array.from(uniquePagesMap.values());
      
      const currentPageTitle =
        document.querySelector("main h1")?.textContent?.trim() ||
        document.querySelector("h1")?.textContent?.trim() || 
        "Untitled";

      try {
        const currentUrlObj = new URL(baseUrl);
        const currentKey = normalizeUrlKey(currentUrlObj);
        const hasCurrent = pages.some(page => {
          try {
            return normalizeUrlKey(new URL(page.url)) === currentKey;
          } catch (e) {
            return false;
          }
        });
        if (!hasCurrent) {
          pages = [{
            url: currentUrlObj.href,
            title: currentPageTitle || "Untitled",
            selected: true
          }, ...pages];
          console.log('[Batch Debug] Added current page explicitly:', currentUrlObj.href);
        }
      } catch (e) {
        console.warn('[Batch Debug] Failed to add current page explicitly:', e.message);
      }
        
      sendResponse({ 
        success: true, 
        pages: pages, 
        currentTitle: currentPageTitle,
        baseUrl: baseUrl,
        headTitle: formattedHeadTitle
      });
      } catch (error) {
        console.error("Error extracting page links:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  } else if (request.action === "selectDevinTopic") {
    (async () => {
      try {
        const buttons = findDevinTopicButtons();
        if (!buttons.length) {
          throw new Error('No Devin topic buttons found.');
        }

        const index = Number.isInteger(request.index) ? request.index : -1;
        const targetTitle = typeof request.title === 'string' ? request.title.trim() : '';

        let targetButton = null;
        if (targetTitle) {
          targetButton = buttons.find(btn => getElementTitle(btn) === targetTitle);
          if (!targetButton) {
            targetButton = buttons.find(btn => getElementTitle(btn).includes(targetTitle));
          }
        }
        if (!targetButton && index >= 0 && index < buttons.length) {
          targetButton = buttons[index];
        }
        if (!targetButton) {
          throw new Error('Unable to resolve Devin topic button.');
        }

        const expectedTitle = getElementTitle(targetButton);
        const startHash = window.location.hash;

        if (typeof targetButton.scrollIntoView === 'function') {
          targetButton.scrollIntoView({ block: 'center' });
        }
        if (typeof targetButton.click === 'function') {
          targetButton.click();
        }

        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          if (window.location.hash && window.location.hash !== startHash) {
            break;
          }
          if (expectedTitle) {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            const matches = headings.some(h => (h.textContent || '').trim() === expectedTitle);
            if (matches) {
              break;
            }
          }
          if (
            targetButton.getAttribute('aria-selected') === 'true' ||
            targetButton.getAttribute('aria-current') === 'true' ||
            targetButton.classList.contains('active') ||
            targetButton.classList.contains('selected')
          ) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 120));
        }

        sendResponse({
          success: true,
          selectedIndex: buttons.indexOf(targetButton),
          selectedTitle: expectedTitle
        });
      } catch (error) {
        console.error('Error selecting Devin topic:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  } else if (request.action === "getContentSignature") {
    try {
      const signature = getContentSignature();
      const metrics = getContentReadinessMetrics();
      sendResponse({ success: true, signature, metrics, currentUrl: window.location.href });
    } catch (error) {
      console.error('Error getting content signature:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  } else if (request.action === "waitForTopicReady") {
    waitForTopicReady(request)
      .then(response => sendResponse(response))
      .catch(error => {
        console.error('waitForTopicReady error:', error);
        sendResponse({ ready: false, error: error.message });
      });
    return true;
  } else if (request.action === "waitForContentReady") {
    waitForContentReady(request)
      .then(response => sendResponse(response))
      .catch(error => {
        console.error("waitForContentReady error:", error);
        sendResponse({ ready: false, error: error.message });
      });
    return true;
  } else if (request.action === "pageLoaded") {
    console.log("Page loaded:", window.location.href);
    sendResponse({ received: true });
  } else if (request.action === "tabActivated") {
    console.log("Tab activated:", window.location.href);
    sendResponse({ received: true });
  }
  return true;
});

function selectContentContainer() {
  return (
    document.querySelector(".container > div:nth-child(2) .prose") ||
    document.querySelector(".container > div:nth-child(2) .prose-custom") ||
    document.querySelector(".container > div:nth-child(2)") || // DeepWiki fallback
    document.querySelector("main .prose") ||
    document.querySelector("article .prose") ||
    document.querySelector(".prose") || // Tailwind typography standard
    document.querySelector(".markdown-body") || // GitHub style
    document.querySelector(".wiki-content")   // Common wiki class
  );
}

function urlsRoughlyMatch(expectedUrl) {
  if (!expectedUrl) return true;
  try {
    const expected = new URL(expectedUrl);
    const current = new URL(window.location.href);
    if (expected.origin !== current.origin) return false;
    // Ignora search/hash e permite subpaths quando a navegação for SPA
    return current.pathname.startsWith(expected.pathname);
  } catch (e) {
    return true;
  }
}

function getContentReadinessMetrics() {
  const container = selectContentContainer();
  if (!container) {
    return {
      hasContainer: false,
      textLength: 0,
      meaningfulCount: 0,
      hasMermaid: false
    };
  }

  // Helper to check if node is inside a navigation-like element
  const isNavigational = (node) => {
    return node.closest('nav, aside, header, footer, .sidebar, .menu, [class*="sidebar"], [class*="nav-"]');
  };

  // Calculate text length excluding navigation
  let textLength = 0;
  if (container === document.body) {
    // If we fell back to body, we must be very careful to ignore sidebars
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (isNavigational(node.parentElement)) return NodeFilter.FILTER_REJECT;
           // Ignore script/style tags content which might be huge
          if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    while (walker.nextNode()) {
      textLength += walker.currentNode.textContent.trim().length;
    }
  } else {
    // If we have a specific container, mostly trust it, but safeguard against sidebar inclusion
    // (e.g. if the container WRAPS the sidebar)
    textLength = (container.textContent || "").trim().length; 
    // If the container itself IS the sidebar or contains it significantly, this might still be wrong, 
    // but usually specific containers are the article content. 
    // Let's apply a lighter filter just in case.
    if (container.querySelector('nav, aside, .sidebar')) {
       // Recalculate carefully if potential sidebar detected inside
       textLength = 0;
       const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            if (isNavigational(node.parentElement)) return NodeFilter.FILTER_REJECT;
            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      while (walker.nextNode()) {
        textLength += walker.currentNode.textContent.trim().length;
      }
    }
  }

  // Filter meaningful elements
  const allElements = container.querySelectorAll(
    "p, pre, code, table, ul, ol, h1, h2, h3, h4, h5, h6, svg[id^='mermaid-']"
  );
  
  let meaningfulCount = 0;
  allElements.forEach(el => {
    if (!isNavigational(el)) {
      meaningfulCount++;
    }
  });

  const hasMermaid = Boolean(Array.from(container.querySelectorAll("svg[id^='mermaid-'], pre code.language-mermaid"))
    .some(el => !isNavigational(el)));

  return {
    hasContainer: true,
    textLength,
    meaningfulCount,
    hasMermaid
  };
}

function getContentSignature() {
  const container = selectContentContainer();
  if (!container) {
    return {
      heading: '',
      snippet: '',
      textLength: 0,
      hash: window.location.hash || ''
    };
  }

  const heading = container.querySelector('h1, h2, h3')?.textContent?.trim() || '';
  const rawText = (container.textContent || '').replace(/\s+/g, ' ').trim();
  const snippet = rawText.slice(0, 240);

  return {
    heading,
    snippet,
    textLength: rawText.length,
    hash: window.location.hash || ''
  };
}

async function waitForContentReady(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 250;
  const minTextLength = Number(options.minTextLength) > 0 ? Number(options.minTextLength) : 160;
  const expectedUrl = options.expectedUrl || "";

  const start = Date.now();
  const deadline = start + timeoutMs;

  return new Promise(resolve => {
    const tick = () => {
      const urlOk = urlsRoughlyMatch(expectedUrl);
      const metrics = getContentReadinessMetrics();
      const ready =
        urlOk &&
        metrics.hasContainer &&
        (metrics.textLength >= minTextLength ||
          metrics.meaningfulCount >= 6 ||
          metrics.hasMermaid);

      if (ready || Date.now() >= deadline) {
        const timedOut = !ready;
        console.log("Content readiness check:", {
          ready,
          timedOut,
          urlOk,
          expectedUrl,
          currentUrl: window.location.href,
          metrics
        });
        resolve({
          ready,
          timedOut,
          urlOk,
          metrics,
          currentUrl: window.location.href,
          expectedUrl
        });
        return;
      }

      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

async function waitForTopicReady(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 200;
  const minTextLength = Number(options.minTextLength) > 0 ? Number(options.minTextLength) : 160;
  const expectedTitle = (options.expectedTitle || '').trim();
  const previousSignature = options.previousSignature || null;

  const start = Date.now();
  const deadline = start + timeoutMs;

  const normalizedExpected = expectedTitle.toLowerCase();

  return new Promise(resolve => {
    const tick = () => {
      const metrics = getContentReadinessMetrics();
      const signature = getContentSignature();

      const headingNormalized = (signature.heading || '').toLowerCase();
      const titleMatched = normalizedExpected &&
        (headingNormalized === normalizedExpected || headingNormalized.includes(normalizedExpected));

      const previousSnippet = previousSignature?.snippet || '';
      const previousLength = previousSignature?.textLength || 0;
      const snippetChanged = Boolean(signature.snippet && signature.snippet !== previousSnippet);
      const lengthChanged = Math.abs(signature.textLength - previousLength) > 40;

      const contentLooksSubstantial =
        metrics.textLength >= minTextLength ||
        metrics.meaningfulCount >= 6 ||
        metrics.hasMermaid;

      const ready =
        metrics.hasContainer &&
        (titleMatched || snippetChanged || lengthChanged) &&
        (contentLooksSubstantial || metrics.meaningfulCount >= 3);

      if (ready || Date.now() >= deadline) {
        resolve({
          ready,
          timedOut: !ready,
          metrics,
          signature,
          expectedTitle,
          currentUrl: window.location.href
        });
        return;
      }

      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

// ==========================================
//  CLASSE DE INTEGRAÇÃO DO FIX_DOCS (PORT)
// ==========================================

const DeepWikiFixer = {
  process(text) {
    if (!text) return "";
    text = this.stripPreamble(text);
    text = this.removeLinkCopied(text);
    text = this.removeAskDevinLines(text);
    text = this.fixInternalLinks(text);
    text = this.fixSectionLinks(text);
    text = this.stripGithubBlobSha(text);
    text = this.sanitizeMermaid(text);
    return text;
  },

  SECTION_ANCHORS: {
    "Networking Section": "networking-configuration",
    "Virtual Environment Section": "virtual-environment-setup",
    "Module Import Section": "module-import-issues",
    "WSL.exe Section": "wslexe-issues",
    "Path Translation Section": "path-translation-issues",
    "Performance Section": "performance-optimization",
    "Line Ending Section": "line-ending-issues",
    "Distribution Section": "distribution-selection",
  },

  BRANCH_LABELS: new Set(["yes", "no", "true", "false"]),
  
  POSITIVE_HINTS: [
    "add", "use", "enable", "create", "remove", "success", "ready", 
    "connected", "established", "proceed", "continue"
  ],
  
  NEGATIVE_HINTS: [
    "fail", "error", "invalid", "reject", "timeout", "blocked", 
    "missing", "not", "false", "empty", "return", "skip", "default"
  ],

  stripPreamble(text) {
    const lines = text.split('\n');
    let firstHeaderIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('#')) {
        firstHeaderIdx = i;
        break;
      }
    }
    if (firstHeaderIdx === -1 || firstHeaderIdx === 0) return text;
    let remaining = lines.slice(firstHeaderIdx).join('\n');
    if (text.endsWith('\n')) remaining += '\n';
    return remaining;
  },

  removeLinkCopied(text) {
    return text.replace(/\s*Link copied!/g, "");
  },

  removeAskDevinLines(text) {
    const lines = text.split('\n');
    const filtered = lines.filter(line => !line.trim().startsWith("Ask Devin about"));
    let result = filtered.join('\n');
    if (text.endsWith('\n')) result += '\n';
    return result;
  },

  fixInternalLinks(text) {
    text = text.replace(/\]\((?!\s*http)(\/[^)\s]+)\)/g, (match, p1) => {
        return `](https://github.com${p1})`;
    });
    text = text.replace(/(^\s*\[[^\]]+\]:\s*)(\/[^)\s]+)/gm, (match, p1, p2) => {
        return `${p1}https://github.com${p2}`;
    });
    return text;
  },

  fixSectionLinks(text) {
    for (const [section, anchor] of Object.entries(this.SECTION_ANCHORS)) {
        const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`https://github\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/blob/(?<sha>[0-9a-f]{7,40})/${escapedSection}`, 'g');
        
        text = text.replace(pattern, (...args) => {
            const groups = args.pop(); 
            return `https://github.com/${groups.owner}/${groups.repo}/blob/${groups.sha}/README.md#${anchor}`;
        });
    }
    return text;
  },

  stripGithubBlobSha(text) {
    return text.replace(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{7,40})\//g, 
        "https://github.com/$1/$2/");
  },

  sanitizeMermaid(text) {
    const lines = text.split('\n');
    const out = [];
    let inBlock = false;
    let blockLines = [];

    for (const line of lines) {
      if (line.trim().startsWith("```") && line.toLowerCase().includes("mermaid")) {
        inBlock = true;
        out.push(line);
        blockLines = [];
        continue;
      }
      if (inBlock) {
        if (line.trim().startsWith("```")) {
          out.push(...this.sanitizeMermaidBlock(blockLines));
          out.push(line);
          inBlock = false;
        } else {
          blockLines.push(line);
        }
        continue;
      }
      out.push(line);
    }

    if (inBlock) {
      out.push(...this.sanitizeMermaidBlock(blockLines));
    }

    let result = out.join('\n');
    if (text.endsWith('\n')) result += '\n';
    return result;
  },

  sanitizeMermaidBlock(lines) {
    lines = this.sanitizeNodeLabels(lines);
    let blockType = null;
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) continue;
      if (stripped.startsWith("flowchart") || stripped.startsWith("graph")) {
        blockType = "flowchart";
      }
      break;
    }
    if (blockType === "flowchart") {
      return this.moveBranchLabels(lines);
    }
    return lines;
  },

  sanitizeNodeLabels(lines) {
    const nodeLabelRe = /\["(.*?)"\]/g;
    return lines.map(line => {
      return line.replace(nodeLabelRe, (match, label) => {
        return `["${this.sanitizeLabel(label)}"]`;
      });
    });
  },

  sanitizeLabel(label) {
    if (this.containsListMarker(label)) {
      return "Unsupported markdown: list";
    }
    label = label.replace(/\[[^\]]+\]\([^)]+\)/g, "Unsupported markdown: link");
    label = label.replace(/https?:\/\/\S+/g, "Unsupported markdown: link");
    return label;
  },

  containsListMarker(label) {
    const listItemRe = /^\s*(?:\d+\.\s+|[-*+]\s+)/;
    const parts = label.split(/<br\s*\/?>/i);
    return parts.some(part => listItemRe.test(part.trim()));
  },

  moveBranchLabels(lines) {
    const edgeRe = /^(?<indent>\s*)(?<src>[A-Za-z0-9_]+)\s*(?<arrow>[-.=]+>)\s*(?:\|"(?<label>[^"]*)"\|\s*)?(?<dst>[A-Za-z0-9_]+)\s*$/;
    const nodeLabelRe = /\["(.*?)"\]/;

    const edges = [];
    const nodeLabels = {};

    lines.forEach((line, idx) => {
      const labelMatch = line.match(nodeLabelRe);
      if (labelMatch) {
        const prefix = line.split('["')[0].trim();
        if (prefix) {
          nodeLabels[prefix] = labelMatch[1];
        }
      }

      const match = line.match(edgeRe);
      if (match && match.groups) {
        edges.push({
          lineIdx: idx,
          indent: match.groups.indent,
          src: match.groups.src,
          arrow: match.groups.arrow,
          label: match.groups.label || null,
          dst: match.groups.dst
        });
      }
    });

    const outgoing = {};
    edges.forEach((edge, idx) => {
      if (!outgoing[edge.src]) outgoing[edge.src] = [];
      outgoing[edge.src].push(idx);
    });

    const movedTargets = new Set();
    const labelMoves = [];

    edges.forEach((edge, edgeIdx) => {
      if (movedTargets.has(edgeIdx)) return;
      if (!this.isBranchLabel(edge.label)) return;
      if ((outgoing[edge.src] || []).length !== 1) return;

      const candidatesAll = outgoing[edge.dst] || [];
      if (candidatesAll.length < 2) return;

      const candidates = candidatesAll.filter(idx => edges[idx].label === null);
      if (candidates.length === 0) return;

      const polarity = this.labelPolarity(edge.label);
      const targetIdx = this.chooseEdge(edges, nodeLabels, candidates, polarity);

      if (targetIdx !== null) {
        labelMoves.push({ from: edgeIdx, to: targetIdx });
        movedTargets.add(targetIdx);
      }
    });

    labelMoves.forEach(move => {
      edges[move.to].label = edges[move.from].label;
      edges[move.from].label = null;
    });

    edges.forEach(edge => {
      if (edge.label) {
        lines[edge.lineIdx] = `${edge.indent}${edge.src} ${edge.arrow}|"${edge.label}"| ${edge.dst}`;
      } else {
        lines[edge.lineIdx] = `${edge.indent}${edge.src} ${edge.arrow} ${edge.dst}`;
      }
    });

    return lines;
  },

  isBranchLabel(label) {
    if (!label) return false;
    return this.BRANCH_LABELS.has(label.trim().toLowerCase());
  },

  labelPolarity(label) {
    if (!label) return null;
    const lowered = label.trim().toLowerCase();
    if (lowered === "yes" || lowered === "true") return "positive";
    if (lowered === "no" || lowered === "false") return "negative";
    return null;
  },

  edgeScore(text, polarity) {
    if (!polarity) return 0;
    const textLower = text.toLowerCase();
    
    let posHits = 0;
    this.POSITIVE_HINTS.forEach(hint => { if(textLower.includes(hint)) posHits++; });
    
    let negHits = 0;
    this.NEGATIVE_HINTS.forEach(hint => { if(textLower.includes(hint)) negHits++; });

    if (polarity === "positive") return posHits - negHits;
    return negHits - posHits;
  },

  chooseEdge(edges, nodeLabels, candidates, polarity) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (!polarity) {
      const unlabeled = candidates.filter(idx => edges[idx].label === null);
      return unlabeled.length === 1 ? unlabeled[0] : null;
    }

    const scored = candidates.map(idx => {
      const dstNode = edges[idx].dst;
      const targetLabel = nodeLabels[dstNode] || dstNode;
      return {
        score: this.edgeScore(targetLabel, polarity),
        idx: idx
      };
    });

    const maxScore = Math.max(...scored.map(s => s.score));
    if (maxScore <= 0) {
      const unlabeled = candidates.filter(idx => edges[idx].label === null);
      return unlabeled.length === 1 ? unlabeled[0] : null;
    }

    const winners = scored.filter(s => s.score === maxScore);
    return winners.length === 1 ? winners[0].idx : null;
  }
};

// Function for Flowchart (ensure this exists from previous responses)
function convertFlowchartSvgToMermaidText(svgElement) {
  if (!svgElement) return null;

  console.log("Starting flowchart conversion with hierarchical logic...");
  let mermaidCode = "flowchart TD\n\n";
  const nodes = {}; 
  const clusters = {}; 
    const parentMap = {}; // Maps a child SVG ID to its parent SVG ID
    const allElements = {}; // All nodes and clusters, for easy lookup

    // 1. Collect all nodes
    svgElement.querySelectorAll('g.node').forEach(nodeEl => {
    const svgId = nodeEl.id;
        if (!svgId) return;

        let textContent = "";
        const pElementForText = nodeEl.querySelector('.label foreignObject div > span > p, .label foreignObject div > p');
        if (pElementForText) {
            let rawParts = [];
            pElementForText.childNodes.forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) rawParts.push(child.textContent);
                else if (child.nodeName.toUpperCase() === 'BR') rawParts.push('<br>');
                else if (child.nodeType === Node.ELEMENT_NODE) rawParts.push(child.textContent || '');
            });
            textContent = rawParts.join('').trim().replace(/"/g, '#quot;');
        }
        if (!textContent.trim()) {
            const nodeLabel = nodeEl.querySelector('.nodeLabel, .label, foreignObject span, foreignObject div, text');
            if (nodeLabel && nodeLabel.textContent) {
                textContent = nodeLabel.textContent.trim().replace(/"/g, '#quot;');
            }
        }
        
        let mermaidId = svgId.replace(/^flowchart-/, '').replace(/-\d+$/, '');

        const bbox = nodeEl.getBoundingClientRect();
        if (bbox.width > 0 || bbox.height > 0) {
    nodes[svgId] = { 
                type: 'node',
      mermaidId: mermaidId, 
      text: textContent, 
                svgId: svgId,
                bbox: bbox,
            };
            allElements[svgId] = nodes[svgId];
        }
    });

    // 2. Collect all clusters
    svgElement.querySelectorAll('g.cluster').forEach(clusterEl => {
        const svgId = clusterEl.id;
        if (!svgId) return;

    let title = "";
        const labelEl = clusterEl.querySelector('.cluster-label, .label');
        if (labelEl && labelEl.textContent) {
            title = labelEl.textContent.trim();
    }
    if (!title) {
            title = svgId;
        }

        const rect = clusterEl.querySelector('rect');
        const bbox = rect ? rect.getBoundingClientRect() : clusterEl.getBoundingClientRect();

        if (bbox.width > 0 || bbox.height > 0) {
            clusters[svgId] = {
                type: 'cluster',
                mermaidId: svgId, // Use stable SVG ID for mermaid ID
      title: title, 
                svgId: svgId,
                bbox: bbox,
            };
            allElements[svgId] = clusters[svgId];
        }
    });

    // 3. Build hierarchy (parentMap) by checking for geometric containment
    for (const childId in allElements) {
        const child = allElements[childId];
        let potentialParentId = null;
        let minArea = Infinity;

        for (const parentId in clusters) {
            if (childId === parentId) continue;
            const parent = clusters[parentId];

            if (child.bbox.left >= parent.bbox.left &&
                child.bbox.right <= parent.bbox.right &&
                child.bbox.top >= parent.bbox.top &&
                child.bbox.bottom <= parent.bbox.bottom) {

                const area = parent.bbox.width * parent.bbox.height;
                if (area < minArea) {
                    minArea = area;
                    potentialParentId = parentId;
                }
            }
        }
        if (potentialParentId) {
            parentMap[childId] = potentialParentId;
        }
    }

    // 4. Process edges and assign to their lowest common ancestor cluster
    const edges = [];
    const edgeLabels = {};
    svgElement.querySelectorAll('g.edgeLabel').forEach(labelEl => {
        const labelCarrier = labelEl.querySelector('[data-id]') || labelEl;
        const labelId = labelCarrier.getAttribute('data-id') || labelEl.getAttribute('data-id') || labelEl.id;
        if (!labelId) return;

        const textEl = labelEl.querySelector('foreignObject p, foreignObject span, text');
        const text = (textEl ? textEl.textContent : labelEl.textContent || '').trim();
        if (!text) return;

        let bbox = null;
        try {
            bbox = labelEl.getBBox();
        } catch (e) {
            // ignore
        }

        const hasBbox = bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y);
        edgeLabels[labelId] = {
            text,
            center: hasBbox ? { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 } : null
        };
    });
  
  function getArrowForPath(pathEl) {
      const cls = pathEl.getAttribute('class') || '';
      let arrow = '-->';
      if (cls.includes('edge-pattern-dashed')) {
          arrow = '-.->';
      } else if (cls.includes('edge-pattern-dotted')) {
          arrow = '-..->';
      }

      const hasStart = Boolean(pathEl.getAttribute('marker-start'));
      if (hasStart) {
          if (arrow === '-->') return '<-->';
          if (arrow === '-.->') return '<-.->';
          if (arrow === '-..->') return '<-..->';
      }
      return arrow;
  }

  svgElement.querySelectorAll('path.flowchart-link').forEach(path => {
        const pathId = path.id;
    if (!pathId) return;
    
    let sourceNode = null;
    let targetNode = null;
        let idParts = pathId.replace(/^(L_|FL_)/, '').split('_');
        if(idParts.length > 1 && idParts[idParts.length-1].match(/^\d+$/)){
            idParts.pop();
        }
        idParts = idParts.join('_');

        for (let i = 1; i < idParts.length; i++) {
            const potentialSourceName = idParts.substring(0,i);
            const potentialTargetName = idParts.substring(i);
             const foundSourceNode = Object.values(nodes).find(n => n.mermaidId === potentialSourceName);
             const foundTargetNode = Object.values(nodes).find(n => n.mermaidId === potentialTargetName);
             if(foundSourceNode && foundTargetNode){
                 sourceNode = foundSourceNode;
                 targetNode = foundTargetNode;
                 break;
             }
        }
        
         if (!sourceNode || !targetNode) { // Fallback for complex names
            const pathIdParts = pathId.replace(/^(L_|FL_)/, '').split('_');
            if(pathIdParts.length > 2){
                 for (let i = 1; i < pathIdParts.length; i++) {
                    const sName = pathIdParts.slice(0, i).join('_');
                    const tName = pathIdParts.slice(i, pathIdParts.length -1).join('_');
                    const foundSourceNode = Object.values(nodes).find(n => n.mermaidId === sName);
                    const foundTargetNode = Object.values(nodes).find(n => n.mermaidId === tName);
                     if(foundSourceNode && foundTargetNode){
                         sourceNode = foundSourceNode;
                         targetNode = foundTargetNode;
          break;
                      }
                }
            }
        }

        if (!sourceNode || !targetNode) {
            console.warn("Could not determine source/target for edge:", pathId);
            return;
        }

        let label = "";
        const edgeKey = path.getAttribute('data-id') || pathId;
        if (edgeKey && edgeLabels[edgeKey]?.text) {
            label = edgeLabels[edgeKey].text;
        }

        if (!label) {
            try {
                const totalLength = path.getTotalLength();
                if (totalLength > 0) {
                    const midPoint = path.getPointAtLength(totalLength / 2);
                    let closestLabel = null;
                    let closestDist = Infinity;
                    for (const labelId in edgeLabels) {
                        const currentLabel = edgeLabels[labelId];
                        if (!currentLabel.center) continue;
                        const dist = Math.sqrt(
                            Math.pow(currentLabel.center.x - midPoint.x, 2) +
                            Math.pow(currentLabel.center.y - midPoint.y, 2)
                        );
                        if (dist < closestDist) {
                            closestDist = dist;
                            closestLabel = currentLabel;
                        }
                    }
                    if (closestLabel && closestDist < 90) {
                        label = closestLabel.text;
                    }
                }
            } catch (e) {
                console.error("Error matching label for edge " + pathId, e);
            }
        }

        const arrow = getArrowForPath(path);
        const safeLabel = label ? label.replace(/"/g, '#quot;') : '';
        const labelPart = safeLabel ? `|"${safeLabel}"|` : "";
        const edgeText = `${sourceNode.mermaidId} ${arrow}${labelPart} ${targetNode.mermaidId}`;
    
        // Find Lowest Common Ancestor
        const sourceAncestors = [parentMap[sourceNode.svgId]];
        while (sourceAncestors[sourceAncestors.length - 1]) {
            sourceAncestors.push(parentMap[sourceAncestors[sourceAncestors.length - 1]]);
        }
        let lca = parentMap[targetNode.svgId];
        while (lca && !sourceAncestors.includes(lca)) {
            lca = parentMap[lca];
        }
        
        edges.push({ text: edgeText, parentId: lca || 'root' });
    });
    
    // 5. Generate Mermaid output
    const definedNodeMermaidIds = new Set();
  for (const svgId in nodes) {
    const node = nodes[svgId];
        if (!definedNodeMermaidIds.has(node.mermaidId)) {
      mermaidCode += `${node.mermaidId}["${node.text}"]\n`;
            definedNodeMermaidIds.add(node.mermaidId);
        }
    }
    mermaidCode += '\n';
    
    // Group children and edges by parent
    const childrenMap = {};
    const edgeMap = {};

    for (const childId in parentMap) {
        const parentId = parentMap[childId];
        if (!childrenMap[parentId]) childrenMap[parentId] = [];
        childrenMap[parentId].push(childId);
    }
    
    edges.forEach(edge => {
        const parentId = edge.parentId || 'root';
        if (!edgeMap[parentId]) edgeMap[parentId] = [];
        edgeMap[parentId].push(edge.text);
    });
    
    // Add top-level edges
    (edgeMap['root'] || []).forEach(edgeText => {
        mermaidCode += `${edgeText}\n`;
    });

    function buildSubgraphOutput(clusterId) {
        const cluster = clusters[clusterId];
        if (!cluster) return;

        mermaidCode += `\nsubgraph ${cluster.mermaidId} ["${cluster.title}"]\n`;
        
        const childItems = childrenMap[clusterId] || [];
        
        // Render nodes within this subgraph
        childItems.filter(id => nodes[id]).forEach(nodeId => {
            mermaidCode += `    ${nodes[nodeId].mermaidId}\n`;
        });
        
        // Render edges within this subgraph
        (edgeMap[clusterId] || []).forEach(edgeText => {
            mermaidCode += `    ${edgeText}\n`;
        });
        
        // Render nested subgraphs
        childItems.filter(id => clusters[id]).forEach(subClusterId => {
            buildSubgraphOutput(subClusterId);
        });
        
        mermaidCode += "end\n";
    }

    const topLevelClusters = Object.keys(clusters).filter(id => !parentMap[id]);
    topLevelClusters.forEach(buildSubgraphOutput);
  
  if (Object.keys(nodes).length === 0 && Object.keys(clusters).length === 0) return null;
  return '```mermaid\n' + mermaidCode.trim() + '\n```';
}

// Function for Class Diagram (ensure this exists from previous responses)
function convertClassDiagramSvgToMermaidText(svgElement) {
  if (!svgElement) return null;
  const mermaidLines = ['classDiagram'];
  const classData = {}; 

  // 1. Parse Classes and their geometric information
  svgElement.querySelectorAll('g.node.default[id^="classId-"]').forEach(node => {
    const classIdSvg = node.getAttribute('id'); 
    if (!classIdSvg) return;
    
    const classNameMatch = classIdSvg.match(/^classId-([^-]+(?:-[^-]+)*)-(\d+)$/);
    if (!classNameMatch) return;
    const className = classNameMatch[1];

    let cx = 0, cy = 0, halfWidth = 0, halfHeight = 0;
    const transform = node.getAttribute('transform');
    if (transform) {
      const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        cx = parseFloat(match[1]);
        cy = parseFloat(match[2]);
      }
    }
    const pathForBounds = node.querySelector('g.basic.label-container > path[d^="M-"]');
    if (pathForBounds) {
      const d = pathForBounds.getAttribute('d');
      const dMatch = d.match(/M-([0-9.]+)\s+-([0-9.]+)/); // Extracts W and H from M-W -H
      if (dMatch && dMatch.length >= 3) {
        halfWidth = parseFloat(dMatch[1]);
        halfHeight = parseFloat(dMatch[2]);
      }
    }

    if (!classData[className]) {
        classData[className] = { 
            stereotype: "", 
            members: [], 
            methods: [], 
            svgId: classIdSvg, 
            x: cx, 
            y: cy, 
            width: halfWidth * 2, 
            height: halfHeight * 2 
        };
    }
    const stereotypeElem = node.querySelector('g.annotation-group.text foreignObject span.nodeLabel p, g.annotation-group.text foreignObject div p');
    if (stereotypeElem && stereotypeElem.textContent.trim()) {
        classData[className].stereotype = stereotypeElem.textContent.trim();
    }
    node.querySelectorAll('g.members-group.text g.label foreignObject span.nodeLabel p, g.members-group.text g.label foreignObject div p').forEach(m => {
      const txt = m.textContent.trim();
      if (txt) classData[className].members.push(txt);
    });
    node.querySelectorAll('g.methods-group.text g.label foreignObject span.nodeLabel p, g.methods-group.text g.label foreignObject div p').forEach(m => {
      const txt = m.textContent.trim();
      if (txt) classData[className].methods.push(txt);
    });
  });

  // 2. Parse Notes
  const notes = [];
  
  // Method 1: Find traditional rect.note and text.noteText
  svgElement.querySelectorAll('g').forEach(g => {
    const noteRect = g.querySelector('rect.note');
    const noteText = g.querySelector('text.noteText');
    
    if (noteRect && noteText) {
      const text = noteText.textContent.trim();
      const x = parseFloat(noteRect.getAttribute('x'));
      const y = parseFloat(noteRect.getAttribute('y'));
      const width = parseFloat(noteRect.getAttribute('width'));
      const height = parseFloat(noteRect.getAttribute('height'));
      
      if (text && !isNaN(x) && !isNaN(y)) {
        notes.push({
          text: text,
          x: x,
          y: y,
          width: width || 0,
          height: height || 0,
          id: g.id || `note_${notes.length}`
        });
      }
    }
  });
  
  // Method 2: Find other note formats (like node undefined type)
  svgElement.querySelectorAll('g.node.undefined, g[id^="note"]').forEach(g => {
    // Check if it's a note (by background color, id or other features)
    const hasNoteBackground = g.querySelector('path[fill="#fff5ad"], path[style*="#fff5ad"], path[style*="fill:#fff5ad"]');
    const isNoteId = g.id && g.id.includes('note');
    
    if (hasNoteBackground || isNoteId) {
      // Try to get text from foreignObject
      let text = '';
      const foreignObject = g.querySelector('foreignObject');
      if (foreignObject) {
        const textEl = foreignObject.querySelector('p, span.nodeLabel, .nodeLabel');
        if (textEl) {
          text = textEl.textContent.trim();
        }
      }
      
      // If no text found, try other selectors
      if (!text) {
        const textEl = g.querySelector('text, .label text, tspan');
        if (textEl) {
          text = textEl.textContent.trim();
        }
      }
      
      if (text) {
        // Get position information
        const transform = g.getAttribute('transform');
        let x = 0, y = 0;
        if (transform) {
          const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
          if (match) {
            x = parseFloat(match[1]);
            y = parseFloat(match[2]);
          }
        }
        
        // Check if this note has already been added
        const existingNote = notes.find(n => n.text === text && Math.abs(n.x - x) < 10 && Math.abs(n.y - y) < 10);
        if (!existingNote) {
          notes.push({
            text: text,
            x: x,
            y: y,
            width: 0,
            height: 0,
            id: g.id || `note_${notes.length}`
          });
        }
      }
    }
  });

  // 3. Parse Note-to-Class Connections
  const noteTargets = {}; // Maps note.id to target className
  const connectionThreshold = 50; // Increase connection threshold

  // Find note connection paths, support multiple path types
  const noteConnections = [
    ...svgElement.querySelectorAll('path.relation.edge-pattern-dotted'),
    ...svgElement.querySelectorAll('path[id^="edgeNote"]'),
    ...svgElement.querySelectorAll('path.edge-thickness-normal.edge-pattern-dotted')
  ];
  
  noteConnections.forEach(pathEl => {
    const dAttr = pathEl.getAttribute('d');
    if (!dAttr) return;

    // Improved path parsing, support Bezier curves
    const pathPoints = [];
    
    // Parse various path commands
    const commands = dAttr.match(/[A-Za-z][^A-Za-z]*/g) || [];
    let currentX = 0, currentY = 0;
    
    commands.forEach(cmd => {
      const parts = cmd.match(/[A-Za-z]|[-+]?\d*\.?\d+/g) || [];
      const type = parts[0];
      const coords = parts.slice(1).map(Number);
      
      switch(type.toUpperCase()) {
        case 'M': // Move to
          if (coords.length >= 2) {
            currentX = coords[0];
            currentY = coords[1];
            pathPoints.push({x: currentX, y: currentY});
          }
          break;
        case 'L': // Line to
          for (let i = 0; i < coords.length; i += 2) {
            if (coords[i+1] !== undefined) {
              currentX = coords[i];
              currentY = coords[i+1];
              pathPoints.push({x: currentX, y: currentY});
            }
          }
          break;
        case 'C': // Cubic bezier
          for (let i = 0; i < coords.length; i += 6) {
            if (coords[i+5] !== undefined) {
              // Get end point coordinates
              currentX = coords[i+4];
              currentY = coords[i+5];
              pathPoints.push({x: currentX, y: currentY});
            }
          }
          break;
        case 'Q': // Quadratic bezier
          for (let i = 0; i < coords.length; i += 4) {
            if (coords[i+3] !== undefined) {
              currentX = coords[i+2];
              currentY = coords[i+3];
              pathPoints.push({x: currentX, y: currentY});
            }
          }
          break;
      }
    });

    if (pathPoints.length < 2) return;
    
    const pathStart = pathPoints[0];
    const pathEnd = pathPoints[pathPoints.length - 1];

    // Find the closest note to path start point
    let closestNote = null;
    let minDistToNote = Infinity;
    notes.forEach(note => {
      const dist = Math.sqrt(Math.pow(note.x - pathStart.x, 2) + Math.pow(note.y - pathStart.y, 2));
      if (dist < minDistToNote) {
        minDistToNote = dist;
        closestNote = note;
      }
    });

    // Find the closest class to path end point
    let targetClassName = null;
    let minDistToClass = Infinity;
    for (const currentClassName in classData) {
      const classInfo = classData[currentClassName];
      const classCenterX = classInfo.x;
      const classCenterY = classInfo.y;
      const classWidth = classInfo.width || 200; // Default width
      const classHeight = classInfo.height || 200; // Default height

      // Calculate distance from path end to class center
      const distToCenter = Math.sqrt(
        Math.pow(pathEnd.x - classCenterX, 2) + 
        Math.pow(pathEnd.y - classCenterY, 2)
      );

      // Also calculate distance to class boundary
      const classLeft = classCenterX - classWidth/2;
      const classRight = classCenterX + classWidth/2;
      const classTop = classCenterY - classHeight/2;
      const classBottom = classCenterY + classHeight/2;
      
      const dx = Math.max(classLeft - pathEnd.x, 0, pathEnd.x - classRight);
      const dy = Math.max(classTop - pathEnd.y, 0, pathEnd.y - classBottom);
      const distToEdge = Math.sqrt(dx*dx + dy*dy);

      // Use the smaller distance as the judgment criterion
      const finalDist = Math.min(distToCenter, distToEdge + classWidth/4);
      
      if (finalDist < minDistToClass) {
        minDistToClass = finalDist;
        targetClassName = currentClassName;
      }
    }
    
    // Relax connection conditions
    if (closestNote && targetClassName && 
        minDistToNote < connectionThreshold && 
        minDistToClass < connectionThreshold * 2) {
      
      const existing = noteTargets[closestNote.id];
      const currentScore = minDistToNote + minDistToClass;
      
      if (!existing || currentScore < existing.score) {
        noteTargets[closestNote.id] = { 
          name: targetClassName, 
          score: currentScore,
          noteDistance: minDistToNote,
          classDistance: minDistToClass
        };
      }
    }
  });

  // 4. Add Note Definitions to Mermaid output
  const noteMermaidLines = [];
  notes.forEach(note => {
    const targetInfo = noteTargets[note.id];
    if (targetInfo && targetInfo.name) {
      noteMermaidLines.push(`    note for ${targetInfo.name} "${note.text}"`);
    } else {
      noteMermaidLines.push(`    note "${note.text}"`);
    }
  });
  // Insert notes after 'classDiagram' line
  if (noteMermaidLines.length > 0) {
    mermaidLines.splice(1, 0, ...noteMermaidLines);
  }
  
  // 5. Add Class Definitions
  for (const className in classData) {
    const data = classData[className];
    if (data.stereotype) {
        mermaidLines.push(`    class ${className} {`);
        mermaidLines.push(`        ${data.stereotype}`);
    } else {
        mermaidLines.push(`    class ${className} {`);
    }
    data.members.forEach(member => { mermaidLines.push(`        ${member}`); });
    data.methods.forEach(method => { mermaidLines.push(`        ${method}`); });
    mermaidLines.push('    }');
  }

  const pathElements = Array.from(svgElement.querySelectorAll('path.relation[id^="id_"]'));
  const labelElements = Array.from(svgElement.querySelectorAll('g.edgeLabels .edgeLabel foreignObject p'));

  pathElements.forEach((path, index) => {
    const id = path.getAttribute('id'); 
    if (!id || !id.startsWith('id_')) return;

    // Remove 'id_' prefix and trailing number (e.g., '_1')
    let namePart = id.substring(3).replace(/_\d+$/, '');

    const idParts = namePart.split('_');
    let fromClass = null;
    let toClass = null;

    // Iterate through possible split points to find valid class names
    for (let i = 1; i < idParts.length; i++) {
        const potentialFrom = idParts.slice(0, i).join('_');
        const potentialTo = idParts.slice(i).join('_');
        
        if (classData[potentialFrom] && classData[potentialTo]) {
            fromClass = potentialFrom;
            toClass = potentialTo;
            break; // Found a valid pair
        }
    }

    if (!fromClass || !toClass) {
        console.error("Could not parse class relation from ID:", id);
        return; // Skip if we couldn't parse
    }
    
    // Get key attributes
    const markerEndAttr = path.getAttribute('marker-end') || "";
    const markerStartAttr = path.getAttribute('marker-start') || "";
    const pathClass = path.getAttribute('class') || "";
    
    // Determine line style: solid or dashed
    const isDashed = path.classList.contains('dashed-line') || 
                     path.classList.contains('dotted-line') || 
                     pathClass.includes('dashed') || 
                     pathClass.includes('dotted');
    const lineStyle = isDashed ? ".." : "--";
    
    let relationshipType = "";
    
    // Inheritance relation: <|-- or --|> (corrected inheritance relationship judgment)
    if (markerStartAttr.includes('extensionStart')) { 
        // marker-start has extension, arrow at start point, means: toClass inherits fromClass
        if (isDashed) {
            // Dashed inheritance (implementation relationship): fromClass <|.. toClass
            relationshipType = `${fromClass} <|.. ${toClass}`;
        } else {
            // Solid inheritance: fromClass <|-- toClass
        relationshipType = `${fromClass} <|${lineStyle} ${toClass}`;
    } 
    } 
    else if (markerEndAttr.includes('extensionEnd')) { 
        // marker-end has extension, arrow at end point, means: fromClass inherits toClass
        if (isDashed) {
            // Dashed inheritance (implementation relationship): toClass <|.. fromClass
            relationshipType = `${toClass} <|.. ${fromClass}`;
        } else {
            // Solid inheritance: toClass <|-- fromClass
            relationshipType = `${toClass} <|${lineStyle} ${fromClass}`;
        }
    }
    // Implementation relation: ..|> (corrected implementation relationship judgment)
    else if (markerStartAttr.includes('lollipopStart') || markerStartAttr.includes('implementStart')) {
        relationshipType = `${toClass} ..|> ${fromClass}`;
    }
    else if (markerEndAttr.includes('implementEnd') || markerEndAttr.includes('lollipopEnd') || 
             (markerEndAttr.includes('interfaceEnd') && isDashed)) {
        relationshipType = `${fromClass} ..|> ${toClass}`;
    }
    // Composition relation: *-- (corrected composition relationship judgment)
    else if (markerStartAttr.includes('compositionStart')) {
        // marker-start has composition, diamond at start point, means: fromClass *-- toClass
        relationshipType = `${fromClass} *${lineStyle} ${toClass}`;
    }
    else if (markerEndAttr.includes('compositionEnd') || 
             markerEndAttr.includes('diamondEnd') && markerEndAttr.includes('filled')) { 
        relationshipType = `${toClass} *${lineStyle} ${fromClass}`;
    } 
    // Aggregation relation: o-- (corrected aggregation relationship judgment)
    else if (markerStartAttr.includes('aggregationStart')) {
        // marker-start has aggregation, empty diamond at start point, means: toClass --o fromClass
        relationshipType = `${toClass} ${lineStyle}o ${fromClass}`;
    }
    else if (markerEndAttr.includes('aggregationEnd') || 
             markerEndAttr.includes('diamondEnd') && !markerEndAttr.includes('filled')) { 
        relationshipType = `${fromClass} o${lineStyle} ${toClass}`;
    } 
    // Dependency relation: ..> or --> (corrected dependency relationship judgment)
    else if (markerStartAttr.includes('dependencyStart')) {
        if (isDashed) {
        relationshipType = `${toClass} <.. ${fromClass}`;
        } else {
            relationshipType = `${toClass} <-- ${fromClass}`;
    }
    }
    else if (markerEndAttr.includes('dependencyEnd')) { 
        if (isDashed) {
        relationshipType = `${fromClass} ..> ${toClass}`;
        } else {
            relationshipType = `${fromClass} --> ${toClass}`;
    }
    }
    // Association relation: --> (corrected association relationship judgment)
    else if (markerStartAttr.includes('arrowStart') || markerStartAttr.includes('openStart')) {
        relationshipType = `${toClass} <${lineStyle} ${fromClass}`;
    }
    else if (markerEndAttr.includes('arrowEnd') || markerEndAttr.includes('openEnd')) { 
        relationshipType = `${fromClass} ${lineStyle}> ${toClass}`;
    }
    // Arrowless solid line link: --
    else if (lineStyle === "--" && !markerEndAttr.includes('End') && !markerStartAttr.includes('Start')) { 
        relationshipType = `${fromClass} -- ${toClass}`;
    }
    // Arrowless dashed line link: ..
    else if (lineStyle === ".." && !markerEndAttr.includes('End') && !markerStartAttr.includes('Start')) {
        relationshipType = `${fromClass} .. ${toClass}`;
    }
    // Default relation
    else {
        relationshipType = `${fromClass} ${lineStyle} ${toClass}`;
    }
    
    // Get relationship label text
    const labelText = (labelElements[index] && labelElements[index].textContent) ? 
                       labelElements[index].textContent.trim() : "";
    
    if (relationshipType) {
        mermaidLines.push(`    ${relationshipType}${labelText ? ' : ' + labelText : ''}`);
    }
  });

  if (mermaidLines.length <= 1 && Object.keys(classData).length === 0 && notes.length === 0) return null;
  return '```mermaid\n' + mermaidLines.join('\n') + '\n```';
}

/**
 * Helper: Convert SVG Sequence Diagram to Mermaid code
 * @param {SVGElement} svgElement - The SVG DOM element for the sequence diagram
 * @returns {string|null}
 */
function convertSequenceDiagramSvgToMermaidText(svgElement) {
    if (!svgElement) return null;

    // 1. Parse participants 
    const participants = [];
    console.log("Looking for sequence participants..."); // DEBUG
    
    // Find all participant text elements
    svgElement.querySelectorAll('text.actor-box').forEach((textEl) => {
        const name = textEl.textContent.trim().replace(/^"|"$/g, ''); // Remove quotes
        const x = parseFloat(textEl.getAttribute('x'));
        console.log("Found participant:", name, "at x:", x); // DEBUG
        if (name && !isNaN(x)) {
            participants.push({ name, x });
        }
    });
    
    console.log("Total participants found:", participants.length); // DEBUG
    participants.sort((a, b) => a.x - b.x);
    
    // Remove duplicate participants
    const uniqueParticipants = [];
    const seenNames = new Set();
    participants.forEach(p => {
        if (!seenNames.has(p.name)) {
            uniqueParticipants.push(p);
            seenNames.add(p.name);
        }
    });

    // 2. Parse Notes
    const notes = [];
    svgElement.querySelectorAll('g').forEach(g => {
        const noteRect = g.querySelector('rect.note');
        const noteText = g.querySelector('text.noteText');
        
        if (noteRect && noteText) {
            const text = noteText.textContent.trim();
            const x = parseFloat(noteRect.getAttribute('x'));
            const width = parseFloat(noteRect.getAttribute('width'));
            const leftX = x;
            const rightX = x + width;
            
            // Find all participants within note coverage range
            const coveredParticipants = [];
            uniqueParticipants.forEach(p => {
                // Check if participant is within note's horizontal range
                if (p.x >= leftX && p.x <= rightX) {
                    coveredParticipants.push(p);
                }
            });
            
            // Sort by x coordinate
            coveredParticipants.sort((a, b) => a.x - b.x);
            
            if (coveredParticipants.length > 0) {
                let noteTarget;
                if (coveredParticipants.length === 1) {
                    // Single participant
                    noteTarget = coveredParticipants[0].name;
                } else {
                    // Multiple participants, use first and last
                    const firstParticipant = coveredParticipants[0].name;
                    const lastParticipant = coveredParticipants[coveredParticipants.length - 1].name;
                    noteTarget = `${firstParticipant},${lastParticipant}`;
                }
                
                notes.push({
                    text: text,
                    target: noteTarget,
                    y: parseFloat(noteRect.getAttribute('y'))
                });
            }
        }
    });
    
    // 3. Parse message lines and message text
    const messages = [];
    
    // Collect all message texts
    const messageTexts = [];
    svgElement.querySelectorAll('text.messageText').forEach(textEl => {
        const text = textEl.textContent.trim();
        const y = parseFloat(textEl.getAttribute('y'));
        const x = parseFloat(textEl.getAttribute('x'));
        if (text && !isNaN(y)) {
            messageTexts.push({ text, y, x });
        }
    });
    messageTexts.sort((a, b) => a.y - b.y);
    console.log("Found message texts:", messageTexts.length); // DEBUG
    
    // Collect all message lines
    const messageLines = [];
    svgElement.querySelectorAll('line.messageLine0, line.messageLine1').forEach(lineEl => {
        const x1 = parseFloat(lineEl.getAttribute('x1'));
        const y1 = parseFloat(lineEl.getAttribute('y1'));
        const x2 = parseFloat(lineEl.getAttribute('x2'));
        const y2 = parseFloat(lineEl.getAttribute('y2'));
        const isDashed = lineEl.classList.contains('messageLine1');
        
        if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
            messageLines.push({ x1, y1, x2, y2, isDashed });
        }
    });
    
    // Collect all curved message paths (self messages)
    svgElement.querySelectorAll('path.messageLine0, path.messageLine1').forEach(pathEl => {
        const d = pathEl.getAttribute('d');
        const isDashed = pathEl.classList.contains('messageLine1');
        
        if (d) {
            // Parse path, check if it's a self message
            const moveMatch = d.match(/M\s*([^,\s]+)[,\s]+([^,\s]+)/);
            const endMatch = d.match(/([^,\s]+)[,\s]+([^,\s]+)$/);
            
            if (moveMatch && endMatch) {
                const x1 = parseFloat(moveMatch[1]);
                const y1 = parseFloat(moveMatch[2]);
                const x2 = parseFloat(endMatch[1]);
                const y2 = parseFloat(endMatch[2]);
                
                // Check if it's a self message (start and end x coordinates are close)
                if (Math.abs(x1 - x2) < 20) { // Allow some margin of error
                    messageLines.push({ 
                        x1, y1, x2, y2, isDashed, 
                        isSelfMessage: true 
                    });
                }
            }
        }
    });
    
    messageLines.sort((a, b) => a.y1 - b.y1);
    console.log("Found message lines:", messageLines.length); // DEBUG
    
    // 4. Match message lines and message text
    for (let i = 0; i < Math.min(messageLines.length, messageTexts.length); i++) {
        const line = messageLines[i];
        const messageText = messageTexts[i];
        
        let fromParticipant = null;
        let toParticipant = null;
        
        if (line.isSelfMessage) {
            // Self message - find participant closest to x1
            let minDist = Infinity;
            for (const p of uniqueParticipants) {
                const dist = Math.abs(p.x - line.x1);
                if (dist < minDist) {
                    minDist = dist;
                    fromParticipant = toParticipant = p.name;
                }
            }
        } else {
            // Find sender and receiver based on x coordinates
            let minDist1 = Infinity;
            for (const p of uniqueParticipants) {
                const dist = Math.abs(p.x - line.x1);
                if (dist < minDist1) {
                    minDist1 = dist;
                    fromParticipant = p.name;
                }
            }
            
            let minDist2 = Infinity;
            for (const p of uniqueParticipants) {
                const dist = Math.abs(p.x - line.x2);
                if (dist < minDist2) {
                    minDist2 = dist;
                    toParticipant = p.name;
                }
            }
        }
        
        if (fromParticipant && toParticipant) {
            // Determine arrow type
            let arrow;
            if (line.isDashed) {
                arrow = '-->>'; // Dashed arrow
            } else {
                arrow = '->>'; // Solid arrow
            }
            
            messages.push({
                from: fromParticipant,
                to: toParticipant,
                text: messageText.text,
                arrow: arrow,
                y: line.y1,
                isSelfMessage: line.isSelfMessage || false
            });
            
            console.log(`Message ${i + 1}: ${fromParticipant} ${arrow} ${toParticipant}: ${messageText.text}`); // DEBUG
        }
    }

    // 5. Parse loop areas
    const loops = [];
    const loopLines = svgElement.querySelectorAll('line.loopLine');
    if (loopLines.length >= 4) {
        const xs = Array.from(loopLines).map(line => [
            parseFloat(line.getAttribute('x1')),
            parseFloat(line.getAttribute('x2'))
        ]).flat();
        const ys = Array.from(loopLines).map(line => [
            parseFloat(line.getAttribute('y1')),
            parseFloat(line.getAttribute('y2'))
        ]).flat();
        
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const yMin = Math.min(...ys);
        const yMax = Math.max(...ys);
        
        let loopText = '';
        const loopTextEl = svgElement.querySelector('.loopText');
        if (loopTextEl) {
            loopText = loopTextEl.textContent.trim();
        }
        
        loops.push({ xMin, xMax, yMin, yMax, text: loopText });
        console.log("Found loop:", loopText, "from y", yMin, "to", yMax); // DEBUG
    }

    // 6. Generate Mermaid code
    let mermaidOutput = "sequenceDiagram\n";
    
    // Add participants
    uniqueParticipants.forEach(p => {
        mermaidOutput += `  participant ${p.name}\n`;
    });
    mermaidOutput += "\n";

    // Sort all events by y coordinate (messages, notes, loops)
    const events = [];
    
    messages.forEach(msg => {
        events.push({ type: 'message', y: msg.y, data: msg });
    });
    
    notes.forEach(note => {
        events.push({ type: 'note', y: note.y, data: note });
    });
    
    loops.forEach(loop => {
        events.push({ type: 'loop_start', y: loop.yMin - 1, data: loop });
        events.push({ type: 'loop_end', y: loop.yMax + 1, data: loop });
    });
    
    events.sort((a, b) => a.y - b.y);
    
    // Generate events
    let loopStack = [];
    events.forEach(event => {
        if (event.type === 'loop_start') {
            const text = event.data.text ? ` ${event.data.text}` : '';
            mermaidOutput += `  loop${text}\n`;
            loopStack.push(event.data);
        } else if (event.type === 'loop_end') {
            if (loopStack.length > 0) {
                mermaidOutput += `  end\n`;
                loopStack.pop();
            }
        } else if (event.type === 'note') {
            const indent = loopStack.length > 0 ? '  ' : '';
            mermaidOutput += `${indent}  note over ${event.data.target}: ${event.data.text}\n`;
        } else if (event.type === 'message') {
            const indent = loopStack.length > 0 ? '  ' : '';
            const msg = event.data;
            mermaidOutput += `${indent}  ${msg.from}${msg.arrow}${msg.to}: ${msg.text}\n`;
        }
    });
    
    // Close remaining loops
    while (loopStack.length > 0) {
        mermaidOutput += `  end\n`;
        loopStack.pop();
    }

    if (uniqueParticipants.length === 0 && messages.length === 0) return null;
    console.log("Sequence diagram conversion completed. Participants:", uniqueParticipants.length, "Messages:", messages.length, "Notes:", notes.length); // DEBUG
    console.log("Generated sequence mermaid code:", mermaidOutput.substring(0, 200) + "..."); // DEBUG
    return '```mermaid\n' + mermaidOutput.trim() + '\n```';
}

/**
 * Helper: Convert SVG State Diagram to Mermaid code
 * @param {SVGElement} svgElement - The SVG DOM element for the state diagram
 * @returns {string|null}
 */
function convertStateDiagramSvgToMermaidText(svgElement) {
    if (!svgElement) return null;

    console.log("Converting state diagram...");
    
    const nodes = [];

    // 1. Parse all states
    svgElement.querySelectorAll('g.node.statediagram-state').forEach(stateEl => {
        const stateName = stateEl.querySelector('foreignObject .nodeLabel p, foreignObject .nodeLabel span')?.textContent.trim();
        if (!stateName) return;

        const transform = stateEl.getAttribute('transform');
        const rect = stateEl.querySelector('rect.basic.label-container');
        if (!transform || !rect) return;

        const transformMatch = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
        if (!transformMatch) return;

        const tx = parseFloat(transformMatch[1]);
        const ty = parseFloat(transformMatch[2]);
        const rx = parseFloat(rect.getAttribute('x'));
        const ry = parseFloat(rect.getAttribute('y'));
        const width = parseFloat(rect.getAttribute('width'));
        const height = parseFloat(rect.getAttribute('height'));

        nodes.push({
            name: stateName,
            x1: tx + rx,
            y1: ty + ry,
            x2: tx + rx + width,
            y2: ty + ry + height
        });
        console.log(`Found State: ${stateName}`, nodes[nodes.length-1]);
    });

    // 2. Find start state
    const startStateEl = svgElement.querySelector('g.node.default circle.state-start');
    if (startStateEl) {
        const startGroup = startStateEl.closest('g.node');
        const transform = startGroup.getAttribute('transform');
        const transformMatch = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
        const r = parseFloat(startStateEl.getAttribute('r'));
        if (transformMatch && r) {
            const tx = parseFloat(transformMatch[1]);
            const ty = parseFloat(transformMatch[2]);
            nodes.push({
                name: '[*]',
                x1: tx - r,
                y1: ty - r,
                x2: tx + r,
                y2: ty + r,
                isSpecial: true
            });
            console.log("Found Start State", nodes[nodes.length-1]);
        }
    }

    // 3. Find end state
    svgElement.querySelectorAll('g.node.default').forEach(endGroup => {
        if (endGroup.querySelectorAll('path').length >= 2) {
             const transform = endGroup.getAttribute('transform');
             if(transform) {
                const transformMatch = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
                if (transformMatch) {
                    const tx = parseFloat(transformMatch[1]);
                    const ty = parseFloat(transformMatch[2]);
                    const r = 7; // Mermaid end circle radius is 7
                    nodes.push({
                        name: '[*]',
                        x1: tx - r,
                        y1: ty - r,
                        x2: tx + r,
                        y2: ty + r,
                        isSpecial: true
                    });
                    console.log("Found End State", nodes[nodes.length-1]);
                }
            }
        }
    });

    // 4. Get all labels
    const labels = [];
    svgElement.querySelectorAll('g.edgeLabel').forEach(labelEl => {
        const text = labelEl.querySelector('foreignObject .edgeLabel p, foreignObject .edgeLabel span')?.textContent.trim().replace(/^"|"$/g, '');
        const transform = labelEl.getAttribute('transform');
        if (text && transform) {
            const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
            if (match) {
                labels.push({
                    text: text,
                    x: parseFloat(match[1]),
                    y: parseFloat(match[2])
                });
            }
        }
    });

    function getDistanceToBox(px, py, box) {
        const dx = Math.max(box.x1 - px, 0, px - box.x2);
        const dy = Math.max(box.y1 - py, 0, py - box.y2);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function getDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    const transitions = [];

    // 5. Process paths
    svgElement.querySelectorAll('path.transition').forEach(pathEl => {
        const dAttr = pathEl.getAttribute('d');
        if (!dAttr) return;

        const startMatch = dAttr.match(/M\s*([^,\s]+)[,\s]+([^,\s]+)/);
        // More robustly find the last coordinate pair in the d string
        const pathSegments = dAttr.split(/[A-Za-z]/);
        const lastSegment = pathSegments[pathSegments.length-1].trim();
        const endCoords = lastSegment.split(/[\s,]+/).map(parseFloat);

        if (!startMatch || endCoords.length < 2) return;

        const startX = parseFloat(startMatch[1]);
        const startY = parseFloat(startMatch[2]);
        const endX = endCoords[endCoords.length - 2];
        const endY = endCoords[endCoords.length - 1];

        let sourceNode = null, targetNode = null;
        let minSourceDist = Infinity, minTargetDist = Infinity;

        nodes.forEach(node => {
            const distToStart = getDistanceToBox(startX, startY, node);
            if (distToStart < minSourceDist) {
                minSourceDist = distToStart;
                sourceNode = node;
            }
            const distToEnd = getDistanceToBox(endX, endY, node);
            if (distToEnd < minTargetDist) {
                minTargetDist = distToEnd;
                targetNode = node;
            }
        });

        let transitionLabel = '';
        if (sourceNode && targetNode && (minSourceDist < 5) && (minTargetDist < 5)) {
            // Find label
            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2;
            let closestLabel = null;
            let minLabelDist = Infinity;

            labels.forEach(label => {
                const dist = getDistance(midX, midY, label.x, label.y);
                if (dist < minLabelDist) {
                    minLabelDist = dist;
                    closestLabel = label;
                }
            });

            if (closestLabel && minLabelDist < 150) { // Arbitrary threshold, seems to work
                transitionLabel = closestLabel.text;
            }
            
            if(sourceNode === targetNode) return; // Ignore self-loops for now
            
            const newTransition = {
                from: sourceNode.name,
                to: targetNode.name,
                label: transitionLabel
            };
            
            // Avoid adding duplicates
            if (!transitions.some(t => t.from === newTransition.from && t.to === newTransition.to && t.label === newTransition.label)) {
                 transitions.push(newTransition);
            }
        }
    });

    // 6. Generate Mermaid code
    let mermaidCode = "stateDiagram-v2\n";
    transitions.forEach(t => {
        let line = `    ${t.from} --> ${t.to}`;
        if (t.label) {
            line += ` : "${t.label}"`;
        }
        mermaidCode += line + '\n';
    });

    if (transitions.length === 0) return null;

    console.log("State diagram conversion completed. Transitions:", transitions.length);
    console.log("Generated state diagram mermaid code:", mermaidCode);
    
    return '```mermaid\n' + mermaidCode.trim() + '\n```';
}
// Helper function: recursively process nodes
function processNode(node) {
  // console.log("processNode START:", node.nodeName, node.nodeType, node.textContent ? node.textContent.substring(0,50) : ''); // DEBUG
  let resultMd = "";

  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentNode && node.parentNode.nodeName === 'PRE') { return node.textContent; }
    // Fix: For normal text nodes, avoid consecutive blank lines being converted to a single newline, 
    // then having \n\n added by outer logic causing too many empty lines
    // Simply return the text and let the parent block element handle the trailing \n\n
    return node.textContent;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node;
  const style = window.getComputedStyle(element);

  if (
    (style.display === "none" || style.visibility === "hidden") &&
    !["DETAILS", "SUMMARY"].includes(element.nodeName)
  ) {
    return "";
  }

  if (element.matches('button, [role="button"], nav, footer, aside, script, style, noscript, iframe, embed, object, header')) { // Added header to general skip
      return "";
  }
  if (element.classList.contains("bg-input-dark") && element.querySelector("svg")){ // Your specific rule
    return "";
  }


  // Main logic wrapped in try...catch to catch errors when processing specific nodes
  try {
    switch (element.nodeName) {
      case "P": {
        let txt = "";
        element.childNodes.forEach((c) => {
            try { txt += processNode(c); } catch (e) { console.error("Error processing child of P:", c, e); txt += "[err]";}
        });
        txt = txt.trim();
        if (txt.startsWith("```mermaid") && txt.endsWith("```")) { // Already processed as Mermaid
          resultMd = txt + "\n\n";
        } else if (txt) {
          resultMd = txt + "\n\n";
        } else {
          resultMd = "\n"; // Keep empty P tag as a newline if needed
        }
        break;
      }
      case "H1": resultMd = (element.textContent.trim() ? `# ${element.textContent.trim()}\n\n` : ""); break;
      case "H2": resultMd = (element.textContent.trim() ? `## ${element.textContent.trim()}\n\n` : ""); break;
      case "H3": resultMd = (element.textContent.trim() ? `### ${element.textContent.trim()}\n\n` : ""); break;
      case "H4": resultMd = (element.textContent.trim() ? `#### ${element.textContent.trim()}\n\n` : ""); break;
      case "H5": resultMd = (element.textContent.trim() ? `##### ${element.textContent.trim()}\n\n` : ""); break;
      case "H6": resultMd = (element.textContent.trim() ? `###### ${element.textContent.trim()}\n\n` : ""); break;
      case "UL": {
        let list = "";
        // Determine if it is a source-related ul
        const isSourceList = (
          (element.previousElementSibling && /source/i.test(element.previousElementSibling.textContent)) ||
          (element.parentElement && /source/i.test(element.parentElement.textContent)) ||
          element.classList.contains('source-list')
        );
        element.querySelectorAll(":scope > li").forEach((li) => {
          let liTxt = "";
          li.childNodes.forEach((c) => { try { liTxt += processNode(c); } catch (e) { console.error("Error processing child of LI:", c, e); liTxt += "[err]";}});
          if (isSourceList) {
            liTxt = liTxt.trim().replace(/\n+/g, ' '); // Merge source-related li into one line
          } else {
            liTxt = liTxt.trim().replace(/\n\n$/, "").replace(/^\n\n/, "");
          }
          if (liTxt) list += `* ${liTxt}\n`;
        });
        resultMd = list + (list ? "\n" : "");
        break;
      }
      case "OL": {
        let list = "";
        let i = 1;
        // Determine if it is a source-related ol
        const isSourceList = (
          (element.previousElementSibling && /source/i.test(element.previousElementSibling.textContent)) ||
          (element.parentElement && /source/i.test(element.parentElement.textContent)) ||
          element.classList.contains('source-list')
        );
        element.querySelectorAll(":scope > li").forEach((li) => {
          let liTxt = "";
          li.childNodes.forEach((c) => { try { liTxt += processNode(c); } catch (e) { console.error("Error processing child of LI:", c, e); liTxt += "[err]";}});
          if (isSourceList) {
            liTxt = liTxt.trim().replace(/\n+/g, ' ');
          } else {
            liTxt = liTxt.trim().replace(/\n\n$/, "").replace(/^\n\n/, "");
          }
          if (liTxt) {
            list += `${i}. ${liTxt}\n`;
            i++;
          }
        });
        resultMd = list + (list ? "\n" : "");
        break;
      }
      case "PRE": {
        const svgElement = element.querySelector('svg[id^="mermaid-"]');
        let mermaidOutput = null;

        if (svgElement) {
          const diagramTypeDesc = svgElement.getAttribute('aria-roledescription');
          const diagramClass = svgElement.getAttribute('class');

          console.log("Found SVG in PRE: desc=", diagramTypeDesc, "class=", diagramClass); // DEBUG
          if (diagramTypeDesc && diagramTypeDesc.includes('flowchart')) {
            console.log("Trying to convert flowchart..."); // DEBUG
            mermaidOutput = convertFlowchartSvgToMermaidText(svgElement);
          } else if (diagramTypeDesc && diagramTypeDesc.includes('class')) {
            console.log("Trying to convert class diagram..."); // DEBUG
            mermaidOutput = convertClassDiagramSvgToMermaidText(svgElement);
          } else if (diagramTypeDesc && diagramTypeDesc.includes('sequence')) {
            console.log("Trying to convert sequence diagram..."); // DEBUG
            mermaidOutput = convertSequenceDiagramSvgToMermaidText(svgElement);
          } else if (diagramTypeDesc && diagramTypeDesc.includes('stateDiagram')) {
            console.log("Trying to convert state diagram..."); // DEBUG
            mermaidOutput = convertStateDiagramSvgToMermaidText(svgElement);
          } else if (diagramClass && diagramClass.includes('flowchart')) {
              console.log("Trying to convert flowchart by class..."); // DEBUG
              mermaidOutput = convertFlowchartSvgToMermaidText(svgElement);
          } else if (diagramClass && (diagramClass.includes('classDiagram') || diagramClass.includes('class'))) {
              console.log("Trying to convert class diagram by class..."); // DEBUG
              mermaidOutput = convertClassDiagramSvgToMermaidText(svgElement);
          } else if (diagramClass && (diagramClass.includes('sequenceDiagram') || diagramClass.includes('sequence'))) {
              console.log("Trying to convert sequence diagram by class..."); // DEBUG
              mermaidOutput = convertSequenceDiagramSvgToMermaidText(svgElement);
          } else if (diagramClass && (diagramClass.includes('statediagram') || diagramClass.includes('stateDiagram'))) {
              console.log("Trying to convert state diagram by class..."); // DEBUG
              mermaidOutput = convertStateDiagramSvgToMermaidText(svgElement);
          }
          
          if (mermaidOutput) {
            console.log("Successfully converted SVG to mermaid:", mermaidOutput.substring(0, 100) + "..."); // DEBUG
          } else {
            console.log("Failed to convert SVG, using fallback"); // DEBUG
          }
        }

        if (mermaidOutput) {
          resultMd = `\n${mermaidOutput}\n\n`;
        } else {
          const code = element.querySelector("code");
          let lang = "";
          let txt = "";
          if (code) {
            txt = code.textContent;
            const cls = Array.from(code.classList).find((c) => c.startsWith("language-"));
            if (cls) lang = cls.replace("language-", "");
          } else {
             txt = element.textContent;
          }
          if (!lang) {
            const preCls = Array.from(element.classList).find((c) => c.startsWith("language-"));
            if (preCls) lang = preCls.replace("language-", "");
          }
          // Auto-detect language if still not found
          if (!lang && txt.trim()) {
            lang = detectCodeLanguage(txt);
          }
          resultMd = `\`\`\`${lang}\n${txt.trim()}\n\`\`\`\n\n`;
        }
        break;
      }
      case "A": {
        const href = element.getAttribute("href");
        let initialTextFromNodes = ""; // Collect raw text from children first
        element.childNodes.forEach(c => { 
          try { 
            initialTextFromNodes += processNode(c); 
          } catch (e) { 
            console.error("Error processing child of A:", c, e); 
            initialTextFromNodes += "[err]";
          }
        });
        let text = initialTextFromNodes.trim(); // This is the base text for further processing

        if (!text && element.querySelector('img')) { // Handle img alt text if link content is empty
            text = element.querySelector('img').alt || 'image';
        }
        // `text` is now the initial display text, possibly from content or image alt.
        // `initialTextFromNodes` keeps the original structure for context like "Sources: [...]".

        if (href && (href.startsWith('http') || href.startsWith('https') || href.startsWith('/') || href.startsWith('#') || href.startsWith('mailto:'))) {
          
          let finalLinkDisplayText = text; // Start with the current text, may be overwritten by line logic

          const lineInfoMatch = href.match(/#L(\d+)(?:-L(\d+))?$/);

          if (lineInfoMatch) {
                      const pathPart = href.substring(0, href.indexOf('#'));
            let filenameFromPath = pathPart.substring(pathPart.lastIndexOf('/') + 1) || "link"; // Default filename

            const startLine = lineInfoMatch[1];
            const endLine = lineInfoMatch[2]; // This is the number after -L, or undefined

            let displayFilename = filenameFromPath; // Start with filename from path

            const trimmedInitialText = initialTextFromNodes.trim(); // Trim for reliable prefix/suffix checks
            let textToParseForFilename = trimmedInitialText; 

            const isSourcesContext = trimmedInitialText.startsWith("Sources: [") && trimmedInitialText.endsWith("]");

            if (isSourcesContext) {
                const sourcesContentMatch = trimmedInitialText.match(/^Sources:\s+\[(.*)\]$/);
                if (sourcesContentMatch && sourcesContentMatch[1]) {
                    textToParseForFilename = sourcesContentMatch[1].trim(); // Content inside "Sources: [...]"
                }
            }

            // Extract filename hint from (potentially sources-stripped) textToParseForFilename
            // This regex targets the first part that looks like a filename.
            const filenameHintMatch = textToParseForFilename.match(/^[\w\/\.-]+(?:\.\w+)?/);
            if (filenameHintMatch && filenameHintMatch[0]) { // Use filenameHintMatch[0] for the matched string
                // Verify this extracted filename by checking if it's part of the href's path
                if (pathPart.includes(filenameHintMatch[0])) {
                    displayFilename = filenameHintMatch[0];
                }
            }
            
            let lineRefText;
            if (endLine && endLine !== startLine) { // Range like L10-L20
              lineRefText = `L${startLine}-L${endLine}`;
            } else { // Single line like L10, or L10-L10 treated as L10
              lineRefText = `L${startLine}`;
            }

            let constructedText = `${displayFilename} ${lineRefText}`;

            if (isSourcesContext) {
              finalLinkDisplayText = `Sources: [${constructedText}]`;
            } else {
              // If not a "Sources:" link, use the newly constructed clean text
              finalLinkDisplayText = constructedText;
            }
          }
          
          // Fallback: if finalLinkDisplayText is empty (e.g. original text was empty and no lineInfoMatch)
          // or if it became empty after processing, use href.
          text = finalLinkDisplayText.trim() || (href ? href : ""); // Ensure text is not empty if href exists
          
          resultMd = `[${text}](${href})`;
          if (window.getComputedStyle(element).display !== "inline") {
              resultMd += "\n\n";
          }
        } else { 
          // Non-http/s/... link, or no href. Fallback text if empty.
          text = text.trim() || (href ? href : ""); 
          resultMd = text; 
          if (window.getComputedStyle(element).display !== "inline" && text.trim()) {
              resultMd += "\n\n";
          }
        }
        break;
      }
      case "IMG":
        if (element.closest && element.closest('a')) return "";
        resultMd = (element.src ? `![${element.alt || ""}](${element.src})\n\n` : "");
        break;
      case "BLOCKQUOTE": {
        let qt = "";
        element.childNodes.forEach((c) => { try { qt += processNode(c); } catch (e) { console.error("Error processing child of BLOCKQUOTE:", c, e); qt += "[err]";}});
        const trimmedQt = qt.trim();
        if (trimmedQt) {
            resultMd = trimmedQt.split("\n").map((l) => `> ${l.trim() ? l : ''}`).filter(l => l.trim() !== '>').join("\n") + "\n\n";
        } else {
            resultMd = "";
        }
        break;
      }
      case "HR":
        resultMd = "\n---\n\n";
        break;
      case "STRONG":
      case "B": {
        let st = "";
        element.childNodes.forEach((c) => { try { st += processNode(c); } catch (e) { console.error("Error processing child of STRONG/B:", c, e); st += "[err]";}});
        return `**${st.trim()}**`; // Return directly
      }
      case "EM":
      case "I": {
        let em = "";
        element.childNodes.forEach((c) => { try { em += processNode(c); } catch (e) { console.error("Error processing child of EM/I:", c, e); em += "[err]";}});
        return `*${em.trim()}*`; // Return directly
      }
      case "CODE": {
          if (element.parentNode && element.parentNode.nodeName === 'PRE') {
              return element.textContent;
          }
          return `\`${element.textContent.trim()}\``; // Return directly
      }
      case "BR":
        if (element.parentNode && ['P', 'DIV', 'LI'].includes(element.parentNode.nodeName) ) { // Added LI
            const nextSibling = element.nextSibling;
            // Add markdown hard break only if BR is followed by text or is at the end of a line within a block
            if (!nextSibling || (nextSibling.nodeType === Node.TEXT_NODE && nextSibling.textContent.trim() !== '') || nextSibling.nodeType === Node.ELEMENT_NODE) {
                 return "  \n"; // Return directly
            }
        }
        return ""; // Return directly (or empty if not a hard break)
      case "TABLE": {
          let tableMd = "";
          const headerRows = Array.from(element.querySelectorAll(':scope > thead > tr, :scope > tr:first-child'));
          const bodyRows = Array.from(element.querySelectorAll(':scope > tbody > tr'));
          const allRows = Array.from(element.rows); // Fallback

          let rowsToProcessForHeader = headerRows;
          if (headerRows.length === 0 && allRows.length > 0) { // Infer header if THEAD is missing
              rowsToProcessForHeader = [allRows[0]];
          }

          if (rowsToProcessForHeader.length > 0) {
              const headerRowElement = rowsToProcessForHeader[0];
              let headerContent = "|"; let separator = "|";
              Array.from(headerRowElement.cells).forEach(cell => {
                  let cellText = ""; cell.childNodes.forEach(c => { try { cellText += processNode(c); } catch (e) { console.error("Error processing child of TH/TD (Header):", c, e); cellText += "[err]";}});
                  headerContent += ` ${cellText.trim().replace(/\|/g, "\\|")} |`; separator += ` --- |`;
              });
              tableMd += `${headerContent}\n${separator}\n`;
          }

          let rowsToProcessForBody = bodyRows;
          if (bodyRows.length === 0 && allRows.length > (headerRows.length > 0 ? 1 : 0) ) { // If no TBODY, take remaining rows
              rowsToProcessForBody = headerRows.length > 0 ? allRows.slice(1) : allRows;
          }


          rowsToProcessForBody.forEach(row => {
              // Ensure we don't re-process a header row if using allRows fallback logic above and header was found
              if (rowsToProcessForHeader.length > 0 && rowsToProcessForHeader.includes(row)) return;

              let rowContent = "|";
              Array.from(row.cells).forEach(cell => {
                  let cellText = ""; cell.childNodes.forEach(c => { try { cellText += processNode(c); } catch (e) { console.error("Error processing child of TH/TD (Body):", c, e); cellText += "[err]";}});
                  rowContent += ` ${cellText.trim().replace(/\|/g, "\\|").replace(/\n+/g, ' <br> ')} |`;
              });
              tableMd += `${rowContent}\n`;
          });
          resultMd = tableMd + (tableMd ? "\n" : "");
          break;
      }
      case "THEAD": case "TBODY": case "TFOOT": case "TR": case "TH": case "TD":
          return ""; // Handled by TABLE case, return empty string if processed directly

      case "DETAILS": {
          let summaryText = "Details"; const summaryElem = element.querySelector('summary');
          if (summaryElem) { let tempSummary = ""; summaryElem.childNodes.forEach(c => { try { tempSummary += processNode(c); } catch (e) { console.error("Error processing child of SUMMARY:", c, e); tempSummary += "[err]";}}); summaryText = tempSummary.trim() || "Details"; }
          let detailsContent = "";
          Array.from(element.childNodes).forEach(child => { if (child.nodeName !== "SUMMARY") { try { detailsContent += processNode(child); } catch (e) { console.error("Error processing child of DETAILS:", c, e); detailsContent += "[err]";}}});
          resultMd = `> **${summaryText}**\n${detailsContent.trim().split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
          break;
      }
      case "SUMMARY": return ""; // Handled by DETAILS

      case "DIV":
      case "SPAN":
      case "SECTION":
      case "ARTICLE":
      case "MAIN":
      default: {
        let txt = "";
        element.childNodes.forEach((c) => { try { txt += processNode(c); } catch (e) { console.error("Error processing child of DEFAULT case:", c, element.nodeName, e); txt += "[err]";}});
        
        const d = window.getComputedStyle(element);
        const isBlock = ["block", "flex", "grid", "list-item", "table", 
                         "table-row-group", "table-header-group", "table-footer-group"].includes(d.display);

        if (isBlock && txt.trim()) {
          // Ensure that text from children which already ends in \n\n isn't given more \n\n
          if (txt.endsWith('\n\n')) {
              resultMd = txt;
          } else if (txt.endsWith('\n')) { // if it ends with one \n, add one more for spacing
              resultMd = txt + '\n';
          } else { // if it has no trailing newlines, add two.
              resultMd = txt.trimEnd() + "\n\n";
          }
        } else { // Inline element or empty block element
          return txt; // Return directly
        }
      }
    }
  } catch (error) {
      console.error("Unhandled error in processNode for element:", element.nodeName, element, error);
      return `\n[ERROR_PROCESSING_ELEMENT: ${element.nodeName}]\n\n`; // Return an error placeholder
  }
  // console.log("processNode END for:", element.nodeName, "Output:", resultMd.substring(0,50)); // DEBUG
  return resultMd;
}

// Function to auto-detect programming language from code content
function detectCodeLanguage(codeText) {
  if (!codeText || codeText.trim().length < 10) return '';
  
  const code = codeText.trim();
  const firstLine = code.split('\n')[0].trim();
  const lines = code.split('\n');
  
  // JavaScript/TypeScript patterns
  if (code.includes('function ') || code.includes('const ') || code.includes('let ') || 
      code.includes('var ') || code.includes('=>') || code.includes('console.log') ||
      code.includes('require(') || code.includes('import ') || code.includes('export ')) {
    if (code.includes(': ') && (code.includes('interface ') || code.includes('type ') || 
        code.includes('enum ') || code.includes('implements '))) {
      return 'typescript';
    }
    return 'javascript';
  }
  
  // Python patterns
  if (code.includes('def ') || code.includes('import ') || code.includes('from ') ||
      code.includes('print(') || code.includes('if __name__') || code.includes('class ') ||
      firstLine.startsWith('#!') && firstLine.includes('python')) {
    return 'python';
  }
  
  // Java patterns
  if (code.includes('public class ') || code.includes('private ') || code.includes('public static void main') ||
      code.includes('System.out.println') || code.includes('import java.')) {
    return 'java';
  }
  
  // C# patterns
  if (code.includes('using System') || code.includes('namespace ') || code.includes('public class ') ||
      code.includes('Console.WriteLine') || code.includes('[Attribute]')) {
    return 'csharp';
  }
  
  // C/C++ patterns
  if (code.includes('#include') || code.includes('int main') || code.includes('printf(') ||
      code.includes('cout <<') || code.includes('std::')) {
    return code.includes('std::') || code.includes('cout') ? 'cpp' : 'c';
  }
  
  // Go patterns
  if (code.includes('package ') || code.includes('func ') || code.includes('import (') ||
      code.includes('fmt.Printf') || code.includes('go ')) {
    return 'go';
  }
  
  // Rust patterns
  if (code.includes('fn ') || code.includes('let mut') || code.includes('println!') ||
      code.includes('use std::') || code.includes('impl ')) {
    return 'rust';
  }
  
  // PHP patterns
  if (code.includes('<?php') || code.includes('$') && (code.includes('echo ') || code.includes('print '))) {
    return 'php';
  }
  
  // Ruby patterns
  if (code.includes('def ') && (code.includes('end') || code.includes('puts ') || code.includes('require '))) {
    return 'ruby';
  }
  
  // Shell/Bash patterns
  if (firstLine.startsWith('#!') && (firstLine.includes('bash') || firstLine.includes('sh')) ||
      code.includes('#!/bin/') || code.includes('echo ') && code.includes('$')) {
    return 'bash';
  }
  
  // SQL patterns
  if (code.match(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i)) {
    return 'sql';
  }
  
  // CSS patterns
  if (code.includes('{') && code.includes('}') && code.includes(':') && 
      (code.includes('color:') || code.includes('margin:') || code.includes('padding:') || code.includes('#'))) {
    return 'css';
  }
  
  // HTML patterns
  if (code.includes('<') && code.includes('>') && 
      (code.includes('<!DOCTYPE') || code.includes('<html') || code.includes('<div') || code.includes('<p'))) {
    return 'html';
  }
  
  // XML patterns
  if (code.includes('<?xml') || (code.includes('<') && code.includes('>') && code.includes('</'))) {
    return 'xml';
  }
  
  // JSON patterns
  if (code.startsWith('{') && code.endsWith('}') || code.startsWith('[') && code.endsWith(']')) {
    try {
      JSON.parse(code);
      return 'json';
    } catch (e) {
      // Not valid JSON
    }
  }
  
  // YAML patterns
  if (lines.some(line => line.match(/^\s*\w+:\s*/) && !line.includes('{') && !line.includes(';'))) {
    return 'yaml';
  }
  
  // Markdown patterns
  if (code.includes('# ') || code.includes('## ') || code.includes('```') || code.includes('[') && code.includes('](')) {
    return 'markdown';
  }
  
  // Docker patterns
  if (firstLine.startsWith('FROM ') || code.includes('RUN ') || code.includes('COPY ') || code.includes('WORKDIR ')) {
    return 'dockerfile';
  }
  
  // Default fallback
  return '';
}

// Notify the background script that the content script is ready
chrome.runtime.sendMessage({ action: "contentScriptReady" });
