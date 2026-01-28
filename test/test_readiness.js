
// Mocking DOM environment
const Node = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3
};

const NodeFilter = {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3
};

class MockNode {
  constructor(nodeName, textContent = '') {
    this.nodeName = nodeName;
    this.tagName = nodeName;
    this.textContent = textContent;
    this.parentNode = null;
    this.childNodes = [];
    this.classList = {
      contains: (cls) => this.className.includes(cls)
    };
    this.className = "";
  }
  
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  
  get parentElement() {
    return this.parentNode;
  }
  
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  
  matches(selector) {
    if (selector === 'nav' || selector === 'aside' || selector === 'header' || selector === 'footer') {
      return this.tagName.toLowerCase() === selector;
    }
    if (selector.startsWith('.')) {
      return this.className.includes(selector.substring(1));
    }
    if (selector.includes('[class*="')) {
        const match = selector.match(/class\*="([^"]+)"/);
        if (match && this.className.includes(match[1])) return true;
    }
    return false;
  }

  querySelector(selector) {
      // Very basic Mock
      if (selector === 'nav, aside, .sidebar') {
           // naive deep search
           const find = (node) => {
               if (node.matches('nav') || node.matches('aside') || node.matches('.sidebar')) return node;
               for (const c of node.childNodes) {
                   const res = find(c);
                   if(res) return res;
               }
               return null;
           }
           return find(this);
      }
      return null;
  }

  querySelectorAll(selector) {
      // Basic flat search for children only, or deep if needed (simplified)
      const results = [];
      const traverse = (node) => {
          // split selector by comma
          const parts = selector.split(',').map(s => s.trim());
          for (const part of parts) {
               // extremely simplified matcher for p, h1, etc
               const tagMatch = part.match(/^[a-z0-9]+$/i);
               if (tagMatch && node.tagName && node.tagName.toLowerCase() === part.toLowerCase()) {
                   results.push(node);
                   break;
               }
          }
          for (const c of node.childNodes) traverse(c);
      };
      traverse(this);
      return results;
  }
}

const document = {
  body: new MockNode('BODY'),
  createTreeWalker: (root, whatToShow, filter) => {
    let stack = [root];
    return {
      currentNode: null,
      nextNode: function() {
        while(stack.length > 0) {
            const node = stack.pop();
            // DFS - push children in reverse
            for(let i = node.childNodes.length - 1; i >= 0; i--) {
                stack.push(node.childNodes[i]);
            }
            
            if (node !== root && node.nodeName === '#text') { // Simulate SHOW_TEXT
                this.currentNode = node;
                // Check filter
                if (filter && filter.acceptNode(node) === NodeFilter.FILTER_ACCEPT) {
                    return true;
                }
            }
        }
        return false;
      }
    };
  }
};

// --- CUT HERE: Paste contents of functions to test ---

function selectContentContainer() {
    // simplified for test: usually returns body if nothing else matches
    return document.body;
}

// PASTE START: The updated function
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

  const hasMermaid = false; // Mock simplified

  return {
    hasContainer: true,
    textLength,
    meaningfulCount,
    hasMermaid
  };
}
// PASTE END

// --- TEST CASES ---

function runTests() {
    console.log("Running Tests...");

    // Test 1: Body with Sidebar + Empty Main
    document.body = new MockNode('BODY');
    const sidebar = new MockNode('NAV');
    sidebar.className = "sidebar";
    sidebar.appendChild(new MockNode('#text', "Sidebar Link 1 Sidebar Link 2 Sidebar Link 3"));
    document.body.appendChild(sidebar);

    const main = new MockNode('MAIN');
    // Main is empty
    document.body.appendChild(main);

    let metrics = getContentReadinessMetrics();
    console.log("Test 1 (Sidebar only):", metrics);
    if (metrics.textLength > 0 || metrics.meaningfulCount > 0) {
        console.error("FAIL: Sidebar content counted!");
    } else {
        console.log("PASS: Sidebar content ignored.");
    }

    // Test 2: Mixed Content
    document.body = new MockNode('BODY');
    const sidebar2 = new MockNode('DIV');
    sidebar2.className = "sidebar-container";
    sidebar2.appendChild(new MockNode('#text', "Sidebar stuff"));
    document.body.appendChild(sidebar2);

    const article = new MockNode('ARTICLE');
    const p1 = new MockNode('P');
    p1.appendChild(new MockNode('#text', "This is the real content of the page."));
    article.appendChild(p1);
    document.body.appendChild(article);

    metrics = getContentReadinessMetrics();
    console.log("Test 2 (Sidebar + Content):", metrics);

    const expectedLen = "This is the real content of the page.".length;
    if (metrics.textLength === expectedLen && metrics.meaningfulCount === 1) {
        console.log("PASS: Correctly identified content.");
    } else {
        console.error(`FAIL: Expected length ${expectedLen}, got ${metrics.textLength}. Expected count 1, got ${metrics.meaningfulCount}`);
    }
}

runTests();
