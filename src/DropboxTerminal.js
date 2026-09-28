import React, { useState, useEffect, useRef, useCallback } from 'react';

// Bash-style shell over the Dropbox API: cd / ls / mv / cp / rm / mkdir / open / find / tree / play.
// The current folder and command history persist in localStorage so the shell "stays" where you left it.
// Paths are Dropbox paths: "" is the root, everything else starts with "/".

const CWD_KEY = 'dropboxTerminal.cwd';
const HISTORY_KEY = 'dropboxTerminal.history';
const ALIAS_KEY = 'dropboxTerminal.aliases';
// Starting "~/.zshrc" — edit with alias / unalias, saved per browser.
const DEFAULT_ALIASES = {
  dir: 'ls',
  ll: 'ls -l',
  la: 'ls',
  l: 'ls',
  cat: 'open',
  opens: "open -a 'google chrome'",
  c: 'cd',
  '..': 'cd ..',
  trees: `echo 'tree -d -L 2 -I "node_modules"'`,
  // The old folder presets
  slideshow: 'gallery',
  videos: 'cd /videos',
  reports: 'cd /chess/reports',
  papers: 'cd /literature/papers',
};

const HELP = [
  'ls [-l] [path]        list folder (click an entry to cd/open it)',
  'cd [path]             change folder  ( ..  /  ~  a/b  "name with spaces" )',
  'pwd                   print current path',
  'open <name|#>         load a file into the viewer',
  'open -a chrome <name> open in a new browser tab; also: web <name>',
  'web                   open the current folder in Dropbox',
  'play [path]           play the audio files in a folder (default: here) in the music player',
  'gallery [path]        browse the images in a folder (← → keys, space = slideshow, esc closes); also: slideshow',
  'which <name|#>        print full path + link   ( which notes | pbcopy )',
  'mv <src...> <dest>    move into folder dest, or rename a single src',
  'cp <src> [dest]       copy a file or folder into a folder or as a new name',
  'rm <name...>          delete (Dropbox keeps deleted files recoverable for a while)',
  'mkdir <name>          create a folder',
  'touch <name>          create an empty file',
  'find <text>           search all of Dropbox by name (numbered)',
  'tree [-d] [-L N] [-I "a|b*"] [path]   folder tree (default depth 2, max 6)',
  'echo <text>           print text',
  'clear                 clear the screen (also Ctrl+L)',
  '',
  'alias                 list aliases (your ~/.zshrc)',
  "alias name='cmd'      add an alias, e.g. alias docs='cd /Documents'",
  'unalias <name>        remove an alias',
  '',
  'Pipes:  cmd | pbcopy    cmd | grep [-i|-v] text    cmd | head [-n N]    cmd | wc -l',
  '        e.g.  pwd | pbcopy     dir | grep -i chess | pbcopy',
  '',
  'Tab completes names, ↑/↓ walk history, # refers to the last find list.',
  'Anywhere a name goes you can paste a Dropbox link:  cd https://www.dropbox.com/home/videos',
];

const loadJSON = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

// JSON-encode an object for the Dropbox-API-Arg header, escaping non-ASCII chars
const dropboxApiArg = (obj) =>
  JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, (c) =>
    `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`
  );

// Split a command line into tokens, honouring "double", 'single' quotes and backslash escapes.
// Returns tokens plus the raw start index of the last token (for tab completion).
const tokenize = (line) => {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  let lastStart = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      if (!inToken) { inToken = true; lastStart = i; }
      quote = c;
    } else if (c === '\\' && i + 1 < line.length) {
      if (!inToken) { inToken = true; lastStart = i; }
      cur += line[++i];
    } else if (/\s/.test(c)) {
      if (inToken) { tokens.push(cur); cur = ''; inToken = false; }
    } else {
      if (!inToken) { inToken = true; lastStart = i; }
      cur += c;
    }
  }
  if (inToken) tokens.push(cur);
  const endsWithSpace = !inToken;
  return { tokens, lastStart: endsWithSpace ? line.length : lastStart, endsWithSpace };
};

// Split on | that isn't inside quotes or escaped.
const splitPipes = (line) => {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += c + line[++i]; continue; }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += c + line[++i];
      continue;
    } else if (c === '|') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
};

const quoteArg = (s) => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

const iconFor = (f) => (f.isFolder ? '📁' : '📄');

const dropboxUrl = (path) => `https://www.dropbox.com/home${path.split('/').map(encodeURIComponent).join('/')}`;

const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const joinPath = (dir, name) => `${dir}/${name}`;

// Resolve `input` against `cwd` into an absolute Dropbox path ("" = root), handling . and ..
const normalize = (cwd, input) => {
  const absolute = input.startsWith('/') || input === '~' || input.startsWith('~/');
  const stack = absolute ? [] : cwd.split('/').filter(Boolean);
  input.replace(/^~/, '').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') stack.pop();
    else stack.push(part);
  });
  return stack.length ? '/' + stack.join('/') : '';
};

const pathString = (cwd) => cwd || '/';

const entryLabel = (f) => (f.display || f.name) + (f.isFolder ? '/' : '');

const DropboxTerminal = ({ accessToken, openFile, playMusic, showGallery, onClose, visible = true, modalOpen = false }) => {
  const [cwd, setCwd] = useState(() => loadJSON(CWD_KEY, ''));
  const [lines, setLines] = useState([{ type: 'out', text: 'Dropbox shell — type "help" for commands.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const historyRef = useRef(loadJSON(HISTORY_KEY, []));
  const historyIdxRef = useRef(-1);
  const cacheRef = useRef(new Map()); // lower-cased folder path -> entries
  const numberedRef = useRef([]); // last find list, for "open 3"
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => { saveJSON(CWD_KEY, cwd); }, [cwd]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);
  // Grab focus when shown, and again when the file modal closes (e.g. Escape) so typing resumes here.
  useEffect(() => {
    if (visible && !modalOpen) inputRef.current?.focus({ preventScroll: true });
  }, [visible, modalOpen]);

  // Saved aliases layer over the defaults (so new defaults appear); unalias stores null to hide a default.
  const [aliasState, setAliases] = useState(() => ({ ...DEFAULT_ALIASES, ...loadJSON(ALIAS_KEY, {}) }));
  useEffect(() => { saveJSON(ALIAS_KEY, aliasState); }, [aliasState]);
  const aliases = Object.fromEntries(Object.entries(aliasState).filter(([, v]) => v !== null));

  // While a pipeline runs, stdout goes into captureRef as { text, file? } items instead of the screen.
  const captureRef = useRef(null);

  const print = useCallback((type, text, extra) => {
    if (captureRef.current && type !== 'err' && type !== 'cmd') {
      if (type === 'grid') {
        extra.files.forEach((f) => captureRef.current.push({ text: '', file: f }));
      } else if (type === 'link') {
        captureRef.current.push({ text: extra.url });
      } else {
        captureRef.current.push({ text, file: extra?.file });
      }
      return;
    }
    setLines((prev) => [...prev, { type, text, ...extra }]);
  }, []);

  // Dropbox RPC call: POST https://api.dropboxapi.com/2/<endpoint> with a JSON body.
  const api = useCallback(async (endpoint, body) => {
    const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        const err = JSON.parse(text);
        msg = err.error_summary || (typeof err.error === 'string' ? err.error : msg);
      } catch {
        if (res.status === 401) msg = 'session expired — sign out and sign in again';
        else if (text) msg += ': ' + text.slice(0, 200);
      }
      throw new Error(msg);
    }
    return res.json();
  }, [accessToken]);

  const toEntry = (e) => ({
    name: e.name,
    path: e.path_display,
    pathDisplay: e.path_display,
    isFolder: e['.tag'] === 'folder',
    size: e.size,
    modified: e.server_modified,
  });

  const listFolder = useCallback(async (path, { fresh = false } = {}) => {
    const key = path.toLowerCase();
    if (!fresh && cacheRef.current.has(key)) return cacheRef.current.get(key);
    let data = await api('files/list_folder', { path });
    let entries = data.entries || [];
    while (data.has_more) {
      data = await api('files/list_folder/continue', { cursor: data.cursor });
      entries = entries.concat(data.entries || []);
    }
    const files = entries.map(toEntry).sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    cacheRef.current.set(key, files);
    return files;
  }, [api]);

  const invalidate = (...paths) => paths.forEach((p) => cacheRef.current.delete(p.toLowerCase()));

  // Resolve a path to { path, name, isFolder } using the exact casing Dropbox has on record.
  const resolve = useCallback(async (input) => {
    if (/^#\d+$/.test(input)) {
      const f = numberedRef.current[parseInt(input.slice(1), 10) - 1];
      if (!f) throw new Error(`${input}: no such entry in the last find list`);
      return f;
    }
    // A pasted Dropbox link (…/home/some/path) resolves straight to that path.
    const link = input.match(/^https?:\/\/(?:www\.)?dropbox\.com\/(?:home|work)([^?#]*)/);
    const p = link ? normalize('', decodeURIComponent(link[1])) : normalize(cwd, input);
    if (p === '') return { path: '', name: '/', isFolder: true };
    try {
      const meta = await api('files/get_metadata', { path: p });
      return { name: meta.name, pathDisplay: meta.path_display, path: meta.path_display, isFolder: meta['.tag'] === 'folder' };
    } catch (e) {
      if (/not_found/.test(e.message)) throw new Error(`${input}: No such file or folder`);
      throw e;
    }
  }, [cwd, api]);

  // For open/web: a bare number means "#N from the last list" unless something here is named that.
  const resolveTarget = async (arg) => {
    try {
      return await resolve(arg);
    } catch (e) {
      if (/^\d+$/.test(arg) && numberedRef.current.length) return resolve('#' + arg);
      throw e;
    }
  };

  const printListing = (entries, long) => {
    if (entries.length === 0) { print('out', '(empty)'); return; }
    if (long) {
      entries.forEach((f) => {
        const date = f.modified ? f.modified.slice(0, 16).replace('T', ' ') : '';
        const size = f.size !== undefined ? `${Math.max(1, Math.round(f.size / 1024))}K` : '-';
        print('entry', `${date.padEnd(16)}  ${size.padStart(7)}  `, { file: f });
      });
    } else {
      print('grid', '', { files: entries });
    }
  };

  const printNumbered = (files) => {
    numberedRef.current = files;
    if (files.length === 0) { print('out', '(no results)'); return; }
    files.forEach((f, i) => print('entry', `${String(i + 1).padStart(2)}  `, { file: f }));
  };

  const commands = {
    help: async () => HELP.forEach((l) => print('out', l)),
    clear: async () => setLines([]),
    pwd: async () => print('out', pathString(cwd)),

    ls: async (args) => {
      const long = args.includes('-l');
      const paths = args.filter((a) => a !== '-l');
      if (paths.length === 0) {
        printListing(await listFolder(cwd, { fresh: true }), long);
        return;
      }
      for (const p of paths) {
        const entry = await resolve(p);
        if (entry.isFolder) {
          if (paths.length > 1) print('out', `${p}:`);
          printListing(await listFolder(entry.path, { fresh: true }), long);
        } else {
          printListing([entry], long);
        }
      }
    },

    cd: async (args) => {
      const target = args[0];
      let next = '';
      if (target && target !== '~' && target !== '/') {
        const entry = await resolveTarget(target);
        if (!entry.isFolder) throw new Error(`cd: ${target}: Not a folder`);
        next = entry.path;
      }
      // List first so a bad folder errors out before we move there.
      const entries = await listFolder(next, { fresh: true });
      setCwd(next);
      // Auto-ls after every cd (like a zsh chpwd hook).
      printListing(entries, false);
    },

    open: async (args) => {
      // macOS style: open -a "Google Chrome" <name>  → new browser tab (any app name works)
      if (args[0] === '-a') return commands.web(args.slice(2));
      if (!args[0]) throw new Error('usage: open <name|#>   or   open -a chrome <name>');
      const entry = await resolveTarget(args[0]);
      if (entry.isFolder) return commands.cd([args[0]]);
      print('out', `Opening ${entry.name}...`);
      openFile({ name: entry.name, pathDisplay: entry.path });
    },

    web: async (args) => {
      // No name → the current folder in Dropbox.
      const entry = args[0] ? await resolveTarget(args[0]) : { path: cwd, name: baseName(cwd) || '/', isFolder: true };
      const url = dropboxUrl(entry.path);
      window.open(url, '_blank', 'noopener');
      print('link', `→ ${entry.name}  `, { url }); // clickable fallback if the popup was blocked
    },

    which: async (args) => {
      if (!args[0]) throw new Error('usage: which <name|#>');
      for (const a of args) {
        const entry = await resolveTarget(a);
        print('out', (entry.path || '/') + (entry.isFolder && entry.path ? '/' : ''));
        print('link', '', { url: dropboxUrl(entry.path) });
      }
    },

    // Play the audio in a folder with the music modal — the terminal version of the old Play button.
    play: async (args) => {
      let path = cwd;
      if (args[0]) {
        const entry = await resolveTarget(args[0]);
        if (!entry.isFolder) throw new Error(`play: ${args[0]}: Not a folder`);
        path = entry.path;
      }
      print('out', `♪ Playing ${pathString(path)} ...`);
      playMusic(path, baseName(path) || 'root');
    },

    // Browse the images in a folder with the gallery modal (← / → to move, space for a slideshow).
    gallery: async (args) => {
      let path = cwd;
      if (args[0]) {
        const entry = await resolveTarget(args[0]);
        if (!entry.isFolder) throw new Error(`gallery: ${args[0]}: Not a folder`);
        path = entry.path;
      }
      print('out', `🖼 Opening gallery for ${pathString(path)} ...`);
      showGallery(path, baseName(path) || 'root');
    },

    mkdir: async (args) => {
      if (!args[0]) throw new Error('usage: mkdir <name>');
      for (const name of args) {
        const path = normalize(cwd, name);
        await api('files/create_folder_v2', { path, autorename: false });
        invalidate(parentOf(path));
        print('out', `created ${name}/`);
      }
    },

    touch: async (args) => {
      if (!args[0]) throw new Error('usage: touch <name>');
      for (const name of args) {
        const path = normalize(cwd, name);
        const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': dropboxApiArg({ path, mode: 'add', autorename: true, mute: false }),
          },
          body: new Blob(['']),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error_summary || `HTTP ${res.status}`);
        }
        const data = await res.json();
        invalidate(parentOf(path));
        print('out', `created ${data.path_display}`);
      }
    },

    rm: async (args) => {
      const names = args.filter((a) => a !== '-r' && a !== '-rf' && a !== '-f');
      if (names.length === 0) throw new Error('usage: rm <name...>');
      for (const name of names) {
        const entry = await resolve(name);
        if (!entry.path) throw new Error('rm: refusing to delete the root folder');
        await api('files/delete_v2', { path: entry.path });
        invalidate(parentOf(entry.path), entry.path);
        print('out', `deleted ${entry.name}`);
      }
    },

    mv: async (args) => {
      if (args.length < 2) throw new Error('usage: mv <src...> <dest>');
      const destArg = args[args.length - 1];
      const sources = args.slice(0, -1);
      let destFolder = null;
      try {
        const entry = await resolve(destArg);
        if (entry.isFolder) destFolder = entry;
        else throw new Error(`mv: ${destArg} already exists`);
      } catch (e) {
        if (!/No such file/.test(e.message)) throw e;
      }

      if (destFolder) {
        for (const src of sources) {
          const entry = await resolve(src);
          await api('files/move_v2', { from_path: entry.path, to_path: joinPath(destFolder.path, entry.name), autorename: false });
          invalidate(parentOf(entry.path), destFolder.path);
          print('out', `${entry.name} → ${destFolder.name}/`);
        }
        return;
      }

      // Destination doesn't exist: rename (and possibly move) a single source.
      if (sources.length > 1) throw new Error(`mv: ${destArg}: No such folder`);
      const entry = await resolve(sources[0]);
      const toPath = normalize(cwd, destArg);
      await api('files/move_v2', { from_path: entry.path, to_path: toPath, autorename: false });
      invalidate(parentOf(entry.path), parentOf(toPath));
      print('out', `${entry.name} → ${toPath}`);
    },

    cp: async (args) => {
      if (!args[0]) throw new Error('usage: cp <src> [dest]');
      const entry = await resolve(args[0]);
      let toPath = joinPath(cwd, `Copy of ${entry.name}`);
      if (args[1]) {
        try {
          const dest = await resolve(args[1]);
          if (!dest.isFolder) throw new Error(`cp: ${args[1]} already exists`);
          toPath = joinPath(dest.path, entry.name);
        } catch (e) {
          if (!/No such file/.test(e.message)) throw e;
          toPath = normalize(cwd, args[1]);
        }
      }
      await api('files/copy_v2', { from_path: entry.path, to_path: toPath, autorename: false });
      invalidate(parentOf(toPath));
      print('out', `copied ${entry.name} → ${toPath}`);
    },

    // tree [-d] [-L N] [-I "pat|pat"] [path]  — like the Unix tree; depth defaults to 2 to keep API calls down.
    tree: async (args) => {
      let dirsOnly = false;
      let maxDepth = 2;
      let ignore = null;
      let target = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-d') dirsOnly = true;
        else if (a === '-L') maxDepth = parseInt(args[++i], 10);
        else if (a === '-I') ignore = args[++i];
        else if (/^-[dL]+\d*$/.test(a)) { // combined forms like -dL2
          if (a.includes('d')) dirsOnly = true;
          const n = a.match(/L(\d+)/)?.[1];
          if (n) maxDepth = parseInt(n, 10);
          else if (a.includes('L')) maxDepth = parseInt(args[++i], 10);
        } else target = a;
      }
      if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('tree: -L needs a number ≥ 1');
      if (maxDepth > 6) throw new Error('tree: -L is capped at 6 (each level is more Dropbox API calls)');
      // -I uses tree's glob syntax: * and ? wildcards, | between patterns.
      const ignoreRe = ignore
        ? new RegExp('^(?:' + ignore.split('|').map((p) =>
          p.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|') + ')$', 'i')
        : null;

      let root = { path: cwd, pathDisplay: cwd, name: baseName(cwd) || '/', isFolder: true };
      if (target) {
        root = await resolveTarget(target);
        if (!root.isFolder) throw new Error(`tree: ${target}: Not a folder`);
      }
      root = { ...root, display: root.path || '/' };

      // Fetch level by level, listing sibling folders in parallel.
      const keep = (e) => (!dirsOnly || e.isFolder) && !(ignoreRe && ignoreRe.test(e.name));
      const children = new Map();
      let frontier = [root.path];
      for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
        const lists = await Promise.all(frontier.map((p) => listFolder(p, { fresh: true }).catch(() => [])));
        const next = [];
        frontier.forEach((p, i) => {
          const kept = lists[i].filter(keep);
          children.set(p, kept);
          kept.forEach((e) => { if (e.isFolder) next.push(e.pathDisplay); });
        });
        frontier = next;
      }

      let dirs = 0;
      let files = 0;
      print('entry', '', { file: root });
      const walk = (path, prefix) => {
        const kids = children.get(path) || [];
        kids.forEach((e, i) => {
          const last = i === kids.length - 1;
          if (e.isFolder) dirs++; else files++;
          print('entry', prefix + (last ? '└── ' : '├── '), { file: e });
          walk(e.pathDisplay, prefix + (last ? '    ' : '│   '));
        });
      };
      walk(root.path, '');
      print('out', '');
      print('out', `${dirs} director${dirs === 1 ? 'y' : 'ies'}${dirsOnly ? '' : `, ${files} file${files === 1 ? '' : 's'}`}`);
    },

    find: async (args) => {
      const text = args.join(' ');
      if (!text) throw new Error('usage: find <text>');
      const data = await api('files/search_v2', {
        query: text,
        options: { max_results: 25, filename_only: true },
      });
      const files = (data.matches || [])
        .map((m) => m.metadata?.metadata)
        .filter(Boolean)
        .map((m) => ({ ...toEntry(m), display: m.path_display }));
      printNumbered(files);
    },
  };
  commands.echo = async (args) => print('out', args.join(' '));
  commands.alias = async (args) => {
    if (args.length === 0) {
      Object.entries(aliases).forEach(([k, v]) => print('out', `alias ${k}=${quoteArg(v)}`));
      return;
    }
    const def = args.join(' ');
    const eq = def.indexOf('=');
    if (eq <= 0) {
      if (aliases[def] === undefined) throw new Error(`alias: ${def}: not found`);
      print('out', `alias ${def}=${quoteArg(aliases[def])}`);
      return;
    }
    const name = def.slice(0, eq).trim();
    const value = def.slice(eq + 1).trim();
    if (!/^[\w.-]+$/.test(name)) throw new Error(`alias: invalid name: ${name}`);
    setAliases((prev) => ({ ...prev, [name]: value }));
  };
  commands.unalias = async (args) => {
    if (!args[0]) throw new Error('usage: unalias <name>');
    const missing = args.find((a) => aliases[a] === undefined);
    if (missing) throw new Error(`unalias: ${missing}: not found`);
    setAliases((prev) => {
      const next = { ...prev };
      args.forEach((a) => {
        if (DEFAULT_ALIASES[a] !== undefined) next[a] = null;
        else delete next[a];
      });
      return next;
    });
  };

  // Pipe targets: take captured items, return the items to pass along.
  const itemText = (it) => it.text + (it.file ? entryLabel(it.file) : '');
  const filters = {
    pbcopy: async (items) => {
      const text = items.map(itemText).join('\n');
      await navigator.clipboard.writeText(text);
      print('out', `(copied ${items.length} line${items.length === 1 ? '' : 's'} to clipboard)`, { dim: true });
      return [];
    },
    grep: async (items, args) => {
      const flags = args.filter((a) => /^-[iv]+$/.test(a)).join('');
      const pattern = args.filter((a) => !/^-[iv]+$/.test(a)).join(' ');
      if (!pattern) throw new Error('usage: grep [-i] [-v] <text>');
      const ci = flags.includes('i');
      const needle = ci ? pattern.toLowerCase() : pattern;
      return items.filter((it) => {
        const t = ci ? itemText(it).toLowerCase() : itemText(it);
        return t.includes(needle) !== flags.includes('v');
      });
    },
    head: async (items, args) => {
      const n = parseInt((args.find((a) => /^-?\d+$/.test(a)) || '10').replace('-', ''), 10);
      return items.slice(0, n);
    },
    tail: async (items, args) => {
      const n = parseInt((args.find((a) => /^-?\d+$/.test(a)) || '10').replace('-', ''), 10);
      return items.slice(-n);
    },
    wc: async (items) => [{ text: String(items.length) }],
  };

  // Expand aliases on the first word (repeatedly, with a guard against loops).
  const expand = (tokens) => {
    let out = tokens;
    const seen = new Set();
    while (out.length && aliases[out[0]] !== undefined && !seen.has(out[0])) {
      seen.add(out[0]);
      out = [...tokenize(aliases[out[0]]).tokens, ...out.slice(1)];
    }
    return out;
  };

  const run = async (line) => {
    const trimmed = line.trim();
    print('cmd', trimmed, { prompt: pathString(cwd) });
    if (!trimmed) return;
    historyRef.current = [...historyRef.current.filter((h) => h !== trimmed), trimmed].slice(-200);
    saveJSON(HISTORY_KEY, historyRef.current);
    historyIdxRef.current = -1;

    const stages = splitPipes(trimmed).map((s) => expand(tokenize(s).tokens));
    if (stages.some((s) => s.length === 0)) { print('err', 'syntax error near "|"'); return; }
    const [[cmd, ...args], ...pipeline] = stages;
    const fn = commands[cmd];
    if (!fn) { print('err', `${cmd}: command not found (try "help")`); return; }
    const badFilter = pipeline.find(([f]) => !filters[f]);
    if (badFilter) { print('err', `${badFilter[0]}: can't be used after | (use pbcopy, grep, head, tail, wc)`); return; }
    setBusy(true);
    try {
      if (pipeline.length === 0) {
        await fn(args);
      } else {
        let items = [];
        captureRef.current = items;
        try { await fn(args); } finally { captureRef.current = null; }
        for (const [f, ...fargs] of pipeline) items = await filters[f](items, fargs);
        items.forEach((it) => (it.file ? print('entry', it.text, { file: it.file }) : print('out', it.text)));
      }
    } catch (e) {
      print('err', e.message);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  // Like signing in to a fresh shell: list the saved folder once so the pane isn't blank.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    run('ls');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const complete = async () => {
    const { tokens, lastStart, endsWithSpace } = tokenize(input);
    if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
      const partial = tokens[0] || '';
      const matches = [...new Set([...Object.keys(commands), ...Object.keys(aliases)])].filter((c) => c.startsWith(partial));
      if (matches.length === 1) setInput(matches[0] + ' ');
      else if (matches.length > 1) print('out', matches.join('  '));
      return;
    }
    const partial = endsWithSpace ? '' : tokens[tokens.length - 1];
    const slash = partial.lastIndexOf('/');
    const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
    const namePart = partial.slice(slash + 1).toLowerCase();
    try {
      let dirPath = cwd;
      if (dirPart) {
        const entry = await resolve(dirPart === '/' ? '/' : dirPart.replace(/\/$/, ''));
        if (!entry.isFolder) return;
        dirPath = entry.path;
      }
      const matches = (await listFolder(dirPath)).filter((e) => e.name.toLowerCase().startsWith(namePart));
      if (matches.length === 0) return;
      const withSlash = (e) => dirPart + e.name + (e.isFolder ? '/' : '');
      if (matches.length === 1) {
        const done = withSlash(matches[0]);
        setInput(input.slice(0, lastStart) + quoteArg(done) + (done.endsWith('/') ? '' : ' '));
        return;
      }
      // Extend to the longest common prefix, then list the candidates.
      let prefix = matches[0].name;
      for (const m of matches) {
        while (!m.name.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
      }
      if (prefix.length > namePart.length) setInput(input.slice(0, lastStart) + quoteArg(dirPart + prefix));
      else print('grid', '', { files: matches });
    } catch {
      /* no completion */
    }
  };

  const handleKeyDown = (e) => {
    const hist = historyRef.current;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (busy) return;
      const line = input;
      setInput('');
      run(line);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hist.length === 0) return;
      const idx = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = idx;
      setInput(hist[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdxRef.current === -1) return;
      const idx = historyIdxRef.current + 1;
      if (idx >= hist.length) { historyIdxRef.current = -1; setInput(''); }
      else { historyIdxRef.current = idx; setInput(hist[idx]); }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      print('cmd', input + '^C', { prompt: pathString(cwd) });
      setInput('');
    }
  };

  // Clicking an entry: folders cd into it, files open in the viewer. Entries that aren't in the
  // current folder (tree output, find results) use their full path so nested clicks work.
  const clickEntry = (f) => {
    if (busy) return;
    const full = f.pathDisplay ?? f.path ?? '';
    const inCwd = parentOf(full).toLowerCase() === cwd.toLowerCase();
    run(`${f.isFolder ? 'cd' : 'open'} ${quoteArg(inCwd ? f.name : full || '/')}`);
  };

  const renderName = (f) => (
    <span
      className={`term-entry ${f.isFolder ? 'term-folder' : 'term-file'}`}
      onClick={() => clickEntry(f)}
      title={f.isFolder ? 'cd' : 'open'}
    >
      {iconFor(f)} {entryLabel(f)}
    </span>
  );

  return (
    <div className="term" onClick={(e) => { if (!window.getSelection()?.toString() && e.target === e.currentTarget) inputRef.current?.focus(); }}>
      <div className="term-header">
        <span>dropbox shell — {pathString(cwd)}</span>
        <div className="term-header-actions">
          <button
            className="copy-btn"
            onClick={async () => {
              const text = lines.map((l) => {
                if (l.type === 'cmd') return `${l.prompt} $ ${l.text}`;
                if (l.type === 'grid') return l.files.map(entryLabel).join('  ');
                if (l.type === 'entry') return l.text + entryLabel(l.file);
                if (l.type === 'link') return l.text + l.url;
                return l.text;
              }).join('\n');
              await navigator.clipboard.writeText(text);
              print('out', '(copied terminal output to clipboard)', { dim: true });
            }}
            title="Copy terminal output to clipboard"
          >
            Copy
          </button>
          {onClose && <button className="term-close" onClick={onClose} title="Close">×</button>}
        </div>
      </div>
      <div className="term-body" ref={scrollRef} onClick={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}>
        {lines.map((l, i) => {
          if (l.type === 'cmd') {
            return (
              <div key={i} className="term-line">
                <span className="term-prompt">{l.prompt} $</span> {l.text}
              </div>
            );
          }
          if (l.type === 'grid') {
            return (
              <div key={i} className="term-grid">
                {l.files.map((f) => <span key={f.pathDisplay}>{renderName(f)}</span>)}
              </div>
            );
          }
          if (l.type === 'link') {
            return (
              <div key={i} className="term-line">
                {l.text}<a className="term-link" href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a>
              </div>
            );
          }
          if (l.type === 'entry') {
            return <div key={i} className="term-line">{l.text}{renderName(l.file)}</div>;
          }
          return <div key={i} className={`term-line ${l.type === 'err' ? 'term-err' : ''} ${l.dim ? 'term-dim' : ''}`}>{l.text}</div>;
        })}
        <div className="term-input-row">
          <span className="term-prompt">{pathString(cwd)} $</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder={busy ? 'working…' : ''}
          />
        </div>
      </div>
    </div>
  );
};

export default DropboxTerminal;
