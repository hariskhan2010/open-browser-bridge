// Injected into pages (isolated world) on demand. Idempotent: defines globalThis.__obb once.
// Holds the ref map (ref_N -> WeakRef<Element>) so refs stay stable across calls.

(() => {
  if (globalThis.__obb) return;

  const refs = new Map();       // 'ref_N' -> WeakRef(el)
  const elToRef = new WeakMap(); // el -> 'ref_N'
  let counter = 0;

  function refFor(el) {
    let r = elToRef.get(el);
    if (r && refs.get(r)?.deref() === el) return r;
    r = 'ref_' + ++counter;
    refs.set(r, new WeakRef(el));
    elToRef.set(el, r);
    return r;
  }

  function getEl(ref) {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) {
      refs.delete(ref);
      throw new Error(`Element ${ref} not found — it may have been removed or the page changed. Call read_page or find again to get fresh refs.`);
    }
    return el;
  }

  // ---------------- roles & names ----------------
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
    range: 'slider', number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    text: 'textbox', password: 'textbox', file: 'button', color: 'button', date: 'textbox', 'datetime-local': 'textbox',
    month: 'textbox', time: 'textbox', week: 'textbox', hidden: null,
  };
  const TAG_ROLES = {
    A: el => (el.hasAttribute('href') ? 'link' : 'generic'), BUTTON: 'button', SELECT: el => (el.multiple || el.size > 1 ? 'listbox' : 'combobox'),
    TEXTAREA: 'textbox', OPTION: 'option', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form',
    SECTION: el => (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic'),
    ARTICLE: 'article', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    THEAD: 'rowgroup', TBODY: 'rowgroup', IMG: el => (el.getAttribute('alt') === '' ? 'presentation' : 'img'), P: 'paragraph',
    DIALOG: 'dialog', DETAILS: 'group', SUMMARY: 'button', LABEL: 'label', FIELDSET: 'group', LEGEND: 'legend',
    PROGRESS: 'progressbar', METER: 'meter', IFRAME: 'iframe', VIDEO: 'video', AUDIO: 'audio', SVG: 'img', HR: 'separator',
    BLOCKQUOTE: 'blockquote', CODE: 'code', PRE: 'code', STRONG: 'strong', EM: 'emphasis', DL: 'list', DT: 'term', DD: 'definition',
    FIGURE: 'figure', CAPTION: 'caption', SEARCH: 'search',
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'BR', 'WBR', 'PATH', 'DEFS', 'G', 'USE', 'SYMBOL', 'CLIPPATH', 'LINEARGRADIENT']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t in INPUT_ROLES ? INPUT_ROLES[t] : 'textbox';
    }
    if (el.isContentEditable && (el.parentElement === null || !el.parentElement.isContentEditable)) return 'textbox';
    const r = TAG_ROLES[el.tagName.toUpperCase()];
    if (typeof r === 'function') return r(el);
    return r || 'generic';
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.tagName === 'INPUT' && el.type !== 'hidden') return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number(ti) >= 0;
  }

  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function labelText(el) {
    if (el.labels && el.labels.length) return clean([...el.labels].map(l => l.innerText || l.textContent).join(' '));
    return '';
  }

  function nameOf(el, role) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = clean(labelledby.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' '));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const l = labelText(el);
      if (l) return l;
      if (['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || el.type);
      if (el.type === 'image') return clean(el.alt || 'Submit');
      return clean(el.getAttribute('title') || '');
    }
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (el.tagName === 'svg' || el.tagName === 'SVG') return clean(el.querySelector('title')?.textContent || '');
    const nameFromContent = ['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'cell', 'columnheader', 'listitem', 'treeitem', 'checkbox', 'radio', 'switch', 'label', 'legend', 'caption', 'term', 'paragraph', 'code', 'strong', 'emphasis', 'summary'];
    if (nameFromContent.includes(role)) {
      const t = clean(el.innerText !== undefined ? el.innerText : el.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute('title') || '');
  }

  function directText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return clean(t);
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  }

  function attrs(el, role) {
    const out = [];
    const tag = el.tagName;
    if (role === 'link' && el.getAttribute('href')) out.push(`href="${clip(el.getAttribute('href'), 100)}"`);
    if (tag === 'INPUT') {
      const t = el.type;
      if (!['text', 'submit', 'button'].includes(t)) out.push(`type="${t}"`);
      if (el.placeholder) out.push(`placeholder="${clip(clean(el.placeholder), 60)}"`);
      if (['checkbox', 'radio'].includes(t)) out.push(el.checked ? 'checked' : 'unchecked');
      else if (t === 'password') { if (el.value) out.push('value="••••"'); }
      else if (t !== 'file' && el.value && !['submit', 'button', 'reset'].includes(t)) out.push(`value="${clip(el.value, 80)}"`);
      if (t === 'file') { if (el.accept) out.push(`accept="${el.accept}"`); if (el.multiple) out.push('multiple'); }
    }
    if (tag === 'TEXTAREA') {
      if (el.placeholder) out.push(`placeholder="${clip(clean(el.placeholder), 60)}"`);
      if (el.value) out.push(`value="${clip(clean(el.value), 80)}"`);
    }
    if (tag === 'SELECT') {
      const sel = [...el.selectedOptions].map(o => clean(o.text)).join(', ');
      if (sel) out.push(`value="${clip(sel, 60)}"`);
    }
    if (tag === 'OPTION' && el.selected) out.push('selected');
    if (role === 'heading') out.push(`level=${tag.match(/^H(\d)$/)?.[1] || el.getAttribute('aria-level') || 2}`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.required) out.push('required');
    const exp = el.getAttribute('aria-expanded');
    if (exp) out.push(exp === 'true' ? 'expanded' : 'collapsed');
    const chk = el.getAttribute('aria-checked');
    if (chk && tag !== 'INPUT') out.push(chk === 'true' ? 'checked' : chk === 'mixed' ? 'mixed' : 'unchecked');
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    if (el.isContentEditable && role === 'textbox' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      const t = clean(el.innerText);
      if (t) out.push(`value="${clip(t, 80)}"`);
    }
    if (tag === 'IFRAME' && el.src) out.push(`src="${clip(el.src, 80)}"`);
    return out;
  }

  function children(el) {
    const kids = [];
    if (el.shadowRoot) kids.push(...el.shadowRoot.children);
    if (el.tagName === 'SLOT') kids.push(...el.assignedElements());
    kids.push(...el.children);
    return kids;
  }

  // ---------------- read_page ----------------
  function readPage({ filter = 'all', depth = 15, ref_id, max_chars = 50000 } = {}) {
    const interactiveOnly = filter === 'interactive';
    const lines = [];
    const root = ref_id ? getEl(ref_id) : document.body || document.documentElement;

    function walk(el, level, d) {
      if (d > depth || SKIP_TAGS.has(el.tagName.toUpperCase())) return;
      if (el.getAttribute('aria-hidden') === 'true' && !interactiveOnly) return;
      const role = roleOf(el);
      let emit = false;
      let line = '';
      if (role !== null && role !== 'presentation' && role !== 'none') {
        if (interactiveOnly) {
          const isFile = el.tagName === 'INPUT' && el.type === 'file';
          emit = isInteractive(el, role) && (isFile || isVisible(el));
        } else {
          const text = role === 'generic' ? directText(el) : '';
          emit = role !== 'generic' || !!text || el === root;
          if (emit) {
            const name = role === 'generic' ? text : nameOf(el, role);
            line = `${role}${name ? ` "${clip(name.replace(/"/g, '\\"'))}"` : ''}`;
          }
        }
        if (emit && interactiveOnly) {
          const name = nameOf(el, role);
          line = `${role}${name ? ` "${clip(name.replace(/"/g, '\\"'))}"` : ''}`;
        }
      }
      if (emit) {
        const a = attrs(el, role);
        lines.push(`${'  '.repeat(level)}- ${line} [${refFor(el)}]${a.length ? ' ' + a.join(' ') : ''}`);
      }
      // Names of leaf-ish elements already include their text; don't repeat it.
      if (emit && !interactiveOnly && ['button', 'link', 'heading', 'option', 'img'].includes(role) && !el.querySelector('input,select,textarea,button,a[href]')) return;
      const nextLevel = emit && !interactiveOnly ? level + 1 : level;
      for (const c of children(el)) walk(c, nextLevel, d + 1);
    }
    walk(root, 0, 0);

    let out = lines.join('\n');
    if (!out) out = interactiveOnly ? '(no interactive elements found)' : '(page has no readable elements)';
    const full = out.length;
    if (full > max_chars) {
      let cut = out.lastIndexOf('\n', max_chars);
      if (cut <= 0) cut = max_chars;
      out = out.slice(0, cut) + `\n\n[Output truncated at ${cut} of ${full} characters. Pass a larger max_chars, a smaller depth, filter:"interactive", or a ref_id to focus on part of the page.]`;
    }
    return {
      tree: out,
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
    };
  }

  // ---------------- find ----------------
  const SYNONYMS = {
    button: ['button', 'btn', 'submit'], link: ['link', 'anchor', 'href'], search: ['search', 'searchbox', 'query', 'find', 'q'],
    input: ['textbox', 'searchbox', 'input', 'field', 'box', 'combobox'], field: ['textbox', 'searchbox', 'input', 'combobox'],
    box: ['textbox', 'searchbox', 'checkbox', 'combobox'], bar: ['textbox', 'searchbox', 'navigation'],
    checkbox: ['checkbox', 'switch'], dropdown: ['combobox', 'listbox', 'select'], select: ['combobox', 'listbox'],
    menu: ['menu', 'menuitem', 'navigation', 'combobox'], tab: ['tab'], image: ['img'], picture: ['img'], heading: ['heading'],
    title: ['heading'], login: ['login', 'log in', 'sign in', 'signin'], signin: ['sign in', 'login', 'log in'],
    cart: ['cart', 'basket', 'bag'], close: ['close', 'dismiss', '×', 'x'], upload: ['file', 'upload', 'attach'],
    email: ['email', 'e-mail', 'mail'], password: ['password', 'passcode'], next: ['next', 'continue', '›', '→'],
  };
  const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'with', 'and', 'or', 'that', 'this', 'is', 'element', 'containing', 'contains', 'labeled', 'called', 'named', 'which']);

  function tokens(s) {
    return clean(s).toLowerCase().split(/[^\p{L}\p{N}×›→@.-]+/u).filter(t => t && !STOP.has(t));
  }

  function find({ query }) {
    const q = tokens(query);
    if (!q.length) throw new Error('Query is empty.');
    const scored = [];
    const all = [];
    (function collect(el) {
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
      all.push(el);
      for (const c of children(el)) collect(c);
    })(document.body || document.documentElement);

    for (const el of all) {
      const role = roleOf(el);
      if (!role || role === 'presentation' || role === 'none') continue;
      const interactive = isInteractive(el, role);
      const isFile = el.tagName === 'INPUT' && el.type === 'file';
      const ownText = role === 'generic' ? directText(el) : '';
      if (role === 'generic' && !ownText && !interactive) continue;
      if (!isFile && !isVisible(el)) continue;
      const displayName = role === 'generic' ? ownText : nameOf(el, role);
      const name = displayName.toLowerCase();
      const hay = [
        name, el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('aria-label'), el.id,
        el.getAttribute('name'), el.getAttribute('type'), el.getAttribute('alt'), el.getAttribute('href'), typeof el.className === 'string' ? el.className : '',
      ].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const t of q) {
        const alts = [t, ...(SYNONYMS[t] || [])];
        let best = 0;
        for (const a of alts) {
          if (role === a) best = Math.max(best, 3);
          if (name === a) best = Math.max(best, 6);
          else if (name.includes(a)) best = Math.max(best, a.length > 2 ? 4 : 1);
          else if (hay.includes(a)) best = Math.max(best, 2);
        }
        score += best;
      }
      if (!score) continue;
      if (interactive) score += 1.5;
      if (name && name.length < 60) score += 0.5;
      // Prefer the innermost match: penalise containers whose text is mostly children's.
      if (!interactive && role !== 'heading' && displayName.length > 200) score -= 2;
      scored.push({ el, role, name: displayName, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.length ? scored[0].score : 0;
    const good = scored.filter(s => s.score >= Math.max(1.5, top * 0.5));
    const results = good.slice(0, 20).map(s => {
      const r = s.el.getBoundingClientRect();
      const a = attrs(s.el, s.role);
      return `- ${s.role}${s.name ? ` "${clip(s.name, 100)}"` : ''} [${refFor(s.el)}]${a.length ? ' ' + a.join(' ') : ''}${isVisible(s.el) && r.bottom > 0 && r.top < innerHeight ? '' : ' (offscreen)'}`;
    });
    return { results, more: good.length > 20 ? good.length - 20 : 0 };
  }

  // ---------------- geometry ----------------
  function rect({ ref, scroll = true }) {
    const el = getEl(ref);
    let r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (scroll && !inView) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    if (!r.width && !r.height) throw new Error(`Element ${ref} has no visible size (it may be hidden). Try another ref or use coordinates from a screenshot.`);
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    return { x, y, width: r.width, height: r.height, role: roleOf(el), name: clip(nameOf(el, roleOf(el)), 80) };
  }

  function scrollTo({ ref }) {
    const el = getEl(ref);
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { role: roleOf(el), name: clip(nameOf(el, roleOf(el)), 80) };
  }

  // ---------------- form_input ----------------
  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function fire(el, ...types) {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
  }

  function formInput({ ref, value }) {
    const el = getEl(ref);
    const role = roleOf(el);
    if (el.disabled) throw new Error(`Element ${ref} is disabled.`);
    el.focus?.();
    if (el instanceof HTMLSelectElement) {
      const want = String(value);
      const opt = [...el.options].find(o => o.value === want) || [...el.options].find(o => clean(o.text) === clean(want)) ||
        [...el.options].find(o => clean(o.text).toLowerCase().includes(clean(want).toLowerCase()));
      if (!opt) throw new Error(`No option matching "${want}". Options: ${[...el.options].map(o => `"${clean(o.text)}" (value "${o.value}")`).slice(0, 30).join(', ')}`);
      el.value = opt.value;
      opt.selected = true;
      fire(el, 'input', 'change');
      return `Selected option "${clean(opt.text)}" in ${role} [${ref}]`;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = value === true || value === 'true' || value === 1 || value === 'on' || value === 'checked';
      if (el.checked !== want) el.click(); // click fires input/change and framework handlers
      if (el.checked !== want) { el.checked = want; fire(el, 'input', 'change'); }
      return `${want ? 'Checked' : 'Unchecked'} ${el.type} [${ref}]`;
    }
    if (el instanceof HTMLInputElement && el.type === 'file') throw new Error('Use the file_upload tool for file inputs.');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNative(el, String(value));
      fire(el, 'input', 'change');
      return `Set ${role} [${ref}] to "${el.type === 'password' ? '••••' : clip(String(value), 80)}"`;
    }
    if (el.isContentEditable) {
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(value) }));
      return `Set editable ${role} [${ref}] text`;
    }
    const ariaRole = el.getAttribute('role');
    if (ariaRole === 'checkbox' || ariaRole === 'switch') {
      const want = value === true || value === 'true';
      if ((el.getAttribute('aria-checked') === 'true') !== want) el.click();
      return `${want ? 'Checked' : 'Unchecked'} ${ariaRole} [${ref}]`;
    }
    throw new Error(`Element ${ref} (${role}) is not a form field. Use computer clicks/typing instead.`);
  }

  // ---------------- get_page_text ----------------
  function pageText() {
    const candidates = [...document.querySelectorAll('article, main, [role="main"], #content, .content, .post, .article')];
    let best = null, bestLen = 0;
    for (const c of candidates) {
      const len = (c.innerText || '').length;
      if (len > bestLen) { best = c; bestLen = len; }
    }
    const bodyLen = (document.body?.innerText || '').length;
    const source = best && bestLen > bodyLen * 0.3 ? best : document.body;
    const text = (source?.innerText || document.documentElement.textContent || '')
      .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter((l, i, arr) => l || (i > 0 && arr[i - 1])).join('\n').trim();
    return { title: document.title, url: location.href, text, source: source === document.body ? 'body' : (best.tagName.toLowerCase() + (best.id ? '#' + best.id : '')) };
  }

  // ---------------- files ----------------
  function b64ToFile({ name, mimeType, data }) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mimeType || 'application/octet-stream', lastModified: Date.now() });
  }

  function setFiles({ ref, files }) {
    const el = getEl(ref);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(b64ToFile(f));
    if (el instanceof HTMLInputElement && el.type === 'file') {
      if (!el.multiple && files.length > 1) throw new Error(`File input [${ref}] accepts only one file.`);
      el.files = dt.files;
      fire(el, 'input', 'change');
      return `Uploaded ${files.length} file(s) to file input [${ref}]: ${files.map(f => f.name).join(', ')}`;
    }
    // Not a file input: treat it as a drop target.
    dropOn(el, dt, el.getBoundingClientRect());
    return `Dropped ${files.length} file(s) onto ${roleOf(el)} [${ref}]: ${files.map(f => f.name).join(', ')}`;
  }

  function dropOn(el, dt, r, x, y) {
    const cx = x ?? r.left + r.width / 2, cy = y ?? r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: cx, clientY: cy };
    el.dispatchEvent(new DragEvent('dragenter', opts));
    el.dispatchEvent(new DragEvent('dragover', opts));
    el.dispatchEvent(new DragEvent('drop', opts));
  }

  function dropFilesAt({ x, y, files }) {
    const el = document.elementFromPoint(x, y);
    if (!el) throw new Error(`No element at (${Math.round(x)}, ${Math.round(y)}).`);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(b64ToFile(f));
    dropOn(el, dt, el.getBoundingClientRect(), x, y);
    return `Dropped ${files.length} file(s) onto ${roleOf(el)} "${clip(nameOf(el, roleOf(el)), 60)}" at the given coordinate`;
  }

  globalThis.__obb = { readPage, find, rect, scrollTo, formInput, pageText, setFiles, dropFilesAt };
})();
