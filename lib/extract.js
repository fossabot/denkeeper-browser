/**
 * Browser-side extraction scripts.
 *
 * Each exported function returns a string of JavaScript that can be passed to
 * Playwright's browser_evaluate tool.  The script runs inside the page context
 * where `document` is the live DOM.
 */

// ---------------------------------------------------------------------------
// Readability extraction
// ---------------------------------------------------------------------------

/**
 * Build the JS payload that injects Readability (if needed) and extracts the
 * article content as Markdown.
 *
 * @param {string} readabilitySrc  - The full source of Readability.js
 * @param {object} opts
 * @param {string} [opts.selector] - CSS selector to scope extraction
 * @param {string} [opts.mode]     - "readability" | "all" | "auto"
 * @param {boolean} [opts.includeForms] - include form field descriptions
 * @param {number} [opts.maxLength] - max chars before truncation
 * @returns {string} JS expression that evaluates to a JSON result string
 */
export function buildExtractScript(readabilitySrc, opts = {}) {
  const selector = opts.selector || '';
  const mode = opts.mode || 'auto';
  const includeForms = opts.includeForms !== false;
  const maxLength = opts.maxLength || 16000;

  // The entire extraction runs inside a single IIFE that returns a JSON string.
  // We embed the Readability source literally so it defines the class in scope.
  return `(() => {
    // ── Readability class definition (injected) ─────────────────────
    ${readabilitySrc}

    // ── DOM → Markdown converter ────────────────────────────────────
    function domToMarkdown(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\\s+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      // Skip hidden elements
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      if (node.getAttribute('aria-hidden') === 'true') return '';

      // Block-level handling
      const childMd = () => Array.from(node.childNodes).map(domToMarkdown).join('');

      switch (tag) {
        case 'h1': return '\\n# ' + childMd().trim() + '\\n\\n';
        case 'h2': return '\\n## ' + childMd().trim() + '\\n\\n';
        case 'h3': return '\\n### ' + childMd().trim() + '\\n\\n';
        case 'h4': return '\\n#### ' + childMd().trim() + '\\n\\n';
        case 'h5': return '\\n##### ' + childMd().trim() + '\\n\\n';
        case 'h6': return '\\n###### ' + childMd().trim() + '\\n\\n';
        case 'p': return '\\n' + childMd().trim() + '\\n\\n';
        case 'br': return '\\n';
        case 'hr': return '\\n---\\n\\n';
        case 'blockquote': return '\\n> ' + childMd().trim().replace(/\\n/g, '\\n> ') + '\\n\\n';
        case 'pre':
        case 'code': {
          const text = node.textContent;
          if (tag === 'pre' || node.parentElement?.tagName.toLowerCase() === 'pre') {
            return '\\n\`\`\`\\n' + text + '\\n\`\`\`\\n\\n';
          }
          return '\`' + text + '\`';
        }
        case 'a': {
          const href = node.getAttribute('href') || '';
          const text = childMd().trim();
          if (!text) return '';
          if (href && !href.startsWith('javascript:')) return '[' + text + '](' + href + ')';
          return text;
        }
        case 'img': {
          const alt = node.getAttribute('alt') || '';
          return alt ? '[image: ' + alt + ']' : '';
        }
        case 'strong':
        case 'b': return '**' + childMd().trim() + '**';
        case 'em':
        case 'i': return '*' + childMd().trim() + '*';
        case 'ul':
        case 'ol': {
          let idx = 0;
          let result = '\\n';
          for (const li of node.children) {
            if (li.tagName.toLowerCase() === 'li') {
              idx++;
              const prefix = tag === 'ol' ? idx + '. ' : '- ';
              result += prefix + domToMarkdown(li).trim() + '\\n';
            }
          }
          return result + '\\n';
        }
        case 'li': return childMd();
        case 'table': {
          const rows = node.querySelectorAll('tr');
          if (rows.length === 0) return childMd();
          let md = '\\n';
          let headerDone = false;
          for (const row of rows) {
            const cells = row.querySelectorAll('th, td');
            const cellTexts = Array.from(cells).map(c => c.textContent.trim().replace(/\\|/g, '\\\\|'));
            md += '| ' + cellTexts.join(' | ') + ' |\\n';
            if (!headerDone) {
              md += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\\n';
              headerDone = true;
            }
          }
          return md + '\\n';
        }
        case 'script':
        case 'style':
        case 'noscript':
        case 'svg':
          return '';
        default:
          return childMd();
      }
    }

    // ── Form extraction ─────────────────────────────────────────────
    function extractForms(root) {
      const forms = [];
      const formEls = root.querySelectorAll('form');
      const targets = formEls.length > 0 ? formEls : [root];

      for (const formEl of targets) {
        const fields = [];
        const inputs = formEl.querySelectorAll('input, textarea, select');

        for (const input of inputs) {
          if (input.type === 'hidden') continue;
          const label = findLabel(input);
          const field = {
            label: label || input.name || input.id || '',
            type: input.tagName.toLowerCase() === 'select' ? 'select'
                : input.tagName.toLowerCase() === 'textarea' ? 'textarea'
                : (input.type || 'text'),
            value: input.value || '',
          };
          if (input.placeholder) field.placeholder = input.placeholder;
          if (input.tagName.toLowerCase() === 'select') {
            field.options = Array.from(input.options).map(o => ({
              text: o.text,
              value: o.value,
              selected: o.selected,
            }));
          }
          fields.push(field);
        }

        if (fields.length === 0) continue;

        const submitBtn = formEl.querySelector('button[type="submit"], input[type="submit"]');
        forms.push({
          name: formEl.name || formEl.id || '',
          fields,
          submit_button: submitBtn ? (submitBtn.textContent || submitBtn.value || 'Submit').trim() : '',
        });
      }
      return forms;
    }

    function findLabel(input) {
      // Try explicit label via for attribute
      if (input.id) {
        const label = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
        if (label) return label.textContent.trim();
      }
      // Try parent label
      const parentLabel = input.closest('label');
      if (parentLabel) {
        // Get label text without input's own text
        const clone = parentLabel.cloneNode(true);
        const inputsInClone = clone.querySelectorAll('input, textarea, select');
        inputsInClone.forEach(i => i.remove());
        const text = clone.textContent.trim();
        if (text) return text;
      }
      // Try aria-label
      if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
      // Try aria-labelledby
      const labelledBy = input.getAttribute('aria-labelledby');
      if (labelledBy) {
        const el = document.getElementById(labelledBy);
        if (el) return el.textContent.trim();
      }
      return '';
    }

    // ── All visible text extraction ─────────────────────────────────
    function extractAllText(root) {
      return domToMarkdown(root);
    }

    // ── Readability extraction ──────────────────────────────────────
    function extractReadability(root) {
      try {
        // Readability needs a document-like object. If scoped to a selector,
        // create a temporary document fragment.
        let doc;
        if (root === document.documentElement || root === document.body || root === document) {
          doc = document.cloneNode(true);
        } else {
          // Wrap in a minimal HTML document for Readability
          const html = '<html><head><title>' + (document.title || '') + '</title></head><body>' + root.outerHTML + '</body></html>';
          doc = new DOMParser().parseFromString(html, 'text/html');
        }

        const reader = new Readability(doc);
        const article = reader.parse();
        if (!article || !article.content) return null;

        // Parse the article HTML and convert to Markdown
        const temp = document.createElement('div');
        temp.innerHTML = article.content;
        const md = domToMarkdown(temp);

        return {
          title: article.title || document.title || '',
          content: md,
        };
      } catch (e) {
        return null;
      }
    }

    // ── Main extraction logic ───────────────────────────────────────
    const selector = ${JSON.stringify(selector)};
    const mode = ${JSON.stringify(mode)};
    const includeForms = ${JSON.stringify(includeForms)};
    const maxLength = ${JSON.stringify(maxLength)};

    const root = selector
      ? document.querySelector(selector) || document.body
      : document.body;

    let title = document.title || '';
    let content = '';

    if (mode === 'readability' || mode === 'auto') {
      const result = extractReadability(root);
      if (result && result.content.trim().length > 200) {
        title = result.title || title;
        content = result.content;
      } else if (mode === 'auto') {
        // Readability failed or too short, fall back to all text
        content = extractAllText(root);
      } else {
        // mode === 'readability' but failed
        content = result ? result.content : extractAllText(root);
      }
    } else {
      content = extractAllText(root);
    }

    // Clean up excessive whitespace
    content = content.replace(/\\n{3,}/g, '\\n\\n').trim();

    // Form extraction
    let forms = [];
    if (includeForms) {
      forms = extractForms(root);
    }

    // Truncation
    const totalLength = content.length;
    let truncated = false;
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + '\\n\\n[truncated]';
      truncated = true;
    }

    return JSON.stringify({
      title,
      content,
      forms: forms.length > 0 ? forms : undefined,
      url: location.href,
      truncated,
      total_length: totalLength,
    });
  })()`;
}

// ---------------------------------------------------------------------------
// HTML extraction (simpler tool)
// ---------------------------------------------------------------------------

/**
 * Build the JS payload for browser_extract_html.
 *
 * @param {string} selector - CSS selector
 * @param {boolean} outer   - outerHTML (true) or innerHTML (false)
 * @returns {string} JS expression
 */
export function buildHtmlExtractScript(selector, outer = true) {
  return `(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    if (els.length === 0) {
      return JSON.stringify({ html: '', count: 0, url: location.href });
    }
    const html = Array.from(els)
      .map(el => ${outer ? 'el.outerHTML' : 'el.innerHTML'})
      .join('\\n');
    return JSON.stringify({
      html,
      count: els.length,
      url: location.href,
    });
  })()`;
}
