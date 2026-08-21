import React, { useState, useEffect, useCallback, useRef } from 'react';
import { marked } from 'marked';
import { parseRTF } from '@jonahschulte/rtf-toolkit';

// Extract plain text from an RTF document: text nodes carry their content,
// paragraphs become newlines
const rtfToPlainText = (rtf) => {
  const walk = (nodes) =>
    (nodes || [])
      .map((n) => {
        if (n.type === 'text') return n.content;
        if (n.type === 'paragraph') return walk(n.content) + '\n';
        return walk(n.content);
      })
      .join('');
  return walk(parseRTF(rtf).content).trim();
};

const APP_KEY = process.env.REACT_APP_DROPBOX_APP_KEY;

const FOLDER_PRESETS = {
  'Videos': '/videos',
  'Chess Reports': '/chess/reports',
  'Literature': '/literature/papers',
};

const REDIRECT_URI = window.location.origin;

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif']);

// Parse a timestamp text block into chapters: "MM:SS Title" or "H:MM:SS Title"
// JSON-encode an object for the Dropbox-API-Arg header, escaping non-ASCII chars
const dropboxApiArg = (obj) =>
  JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, (c) =>
    `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`
  );

const parseChapters = (text) => {
  const re = /^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)/;
  return text.split('\n').reduce((acc, line) => {
    const m = line.trim().match(re);
    if (!m) return acc;
    const timeSecs = m[3] !== undefined
      ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
      : parseInt(m[1]) * 60 + parseInt(m[2]);
    acc.push({ timeSecs, label: m[4].trim() });
    return acc;
  }, []);
};

const formatTime = (secs) => {
  if (!secs || isNaN(secs) || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// PKCE helpers using crypto.subtle
const generateCodeVerifier = () => {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const generateCodeChallenge = async (verifier) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

function DropboxSearch() {
  const [accessToken, setAccessToken] = useState(null);
  const [status, setStatus] = useState('');

  // Tree view state
  const [treePath, setTreePath] = useState('');
  const [treeDepth, setTreeDepth] = useState(2);
  const [treeExclude, setTreeExclude] = useState('');
  const [treeFoldersOnly, setTreeFoldersOnly] = useState(false);
  const [treeLines, setTreeLines] = useState([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeSummary, setTreeSummary] = useState('');
  const [lastMovePath, setLastMovePath] = useState('');

  // File view/edit modal state
  const [modalFile, setModalFile] = useState(null);
  const [modalContent, setModalContent] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalError, setModalError] = useState('');
  const [modalBinary, setModalBinary] = useState(false);
  const [modalEditMode, setModalEditMode] = useState(false);
  const [modalShowMd, setModalShowMd] = useState(false);
  const [modalCopied, setModalCopied] = useState(false);

  // Two-pane split: tree list (left pane) + file viewer (right pane) when a file is open
  const [paneRatio, setPaneRatio] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem('paneSplitRatio'));
      return saved > 0.1 && saved < 0.9 ? saved : 0.4;
    } catch {
      return 0.4;
    }
  });
  const [dividerDragging, setDividerDragging] = useState(false);
  const panesContainerRef = useRef(null);

  // Line navigation in the file pane: 0-based highlighted line + its input text
  const [lineNavCurLine, setLineNavCurLine] = useState(-1);
  const [lineInputValue, setLineInputValue] = useState('');

  // Music player state
  const [musicModal, setMusicModal] = useState(null); // { folderPath, folderName }
  const [musicTracks, setMusicTracks] = useState([]);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicError, setMusicError] = useState('');
  const [musicCurrentIdx, setMusicCurrentIdx] = useState(0);
  const [musicCurrentUrl, setMusicCurrentUrl] = useState('');
  const [musicIsPlaying, setMusicIsPlaying] = useState(false);
  const [musicCurrentTime, setMusicCurrentTime] = useState(0);
  const [musicDuration, setMusicDuration] = useState(0);
  const [musicVolume, setMusicVolume] = useState(80);
  const [musicUrlLoading, setMusicUrlLoading] = useState(false);
  const [musicChapters, setMusicChapters] = useState([]); // parsed chapters for current track

  // Refs for audio element and stale-closure-safe access to state
  const musicAudioRef = useRef(null);
  const musicTracksRef = useRef([]);
  const musicCurrentIdxRef = useRef(0);
  const fetchAndPlayRef = useRef(null);
  const musicTxtMapRef = useRef({}); // baseName → pathDisplay for companion .txt files
  const chapterListRef = useRef(null);
  const modalPreRef = useRef(null);
  const lineNavCurLineRef = useRef(-1);

  musicTracksRef.current = musicTracks;
  musicCurrentIdxRef.current = musicCurrentIdx;

  // Handle OAuth redirect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      const verifier = sessionStorage.getItem('dropbox_code_verifier');
      if (verifier) {
        const body = new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: APP_KEY,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        });

        fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.access_token) {
              setAccessToken(data.access_token);
              setStatus('Signed in');
              sessionStorage.removeItem('dropbox_code_verifier');
              window.history.replaceState({}, document.title, REDIRECT_URI);
            } else {
              setStatus('Auth failed: ' + (data.error_description || data.error || 'Unknown error'));
            }
          })
          .catch((err) => setStatus('Auth error: ' + err.message));
      }
    }
  }, []);

  const handleSignIn = async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem('dropbox_code_verifier', verifier);

    const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&token_access_type=online`;
    window.location.href = authUrl;
  };

  const handleSignOut = async () => {
    if (accessToken) {
      try {
        await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        // Ignore revoke errors
      }
      setAccessToken(null);
      setTreeLines([]);
      setTreeSummary('');
      setTreePath('');
      setStatus('Signed out');
    }
  };

  const listFolder = useCallback(async (path) => {
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: path || '' }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error_summary || `HTTP ${response.status}`);
    }

    const data = await response.json();
    let entries = data.entries || [];

    // Handle pagination
    let hasMore = data.has_more;
    let cursor = data.cursor;
    while (hasMore) {
      const contResp = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cursor }),
      });
      if (!contResp.ok) break;
      const contData = await contResp.json();
      entries = entries.concat(contData.entries || []);
      hasMore = contData.has_more;
      cursor = contData.cursor;
    }

    return entries.map((entry) => ({
      name: entry.name,
      pathDisplay: entry.path_display,
      isFolder: entry['.tag'] === 'folder',
    }));
  }, [accessToken]);

  const loadTree = useCallback(async (rootPath, maxDepth) => {
    if (!accessToken) return;

    setTreeLoading(true);
    setTreeLines([]);
    setTreeSummary('');

    try {
      // Build tree recursively
      const buildNode = async (path, currentDepth) => {
        setStatus(`Loading tree... (depth ${currentDepth}/${maxDepth})`);
        const entries = await listFolder(path);

        // Sort: folders first, then alphabetically
        entries.sort((a, b) => {
          if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        const nodes = [];
        for (const entry of entries) {
          const node = {
            name: entry.name,
            pathDisplay: entry.pathDisplay,
            isFolder: entry.isFolder,
            children: [],
          };

          if (entry.isFolder && currentDepth < maxDepth) {
            try {
              node.children = await buildNode(entry.pathDisplay, currentDepth + 1);
            } catch {
              // If a subfolder fails, just show it without children
            }
          }

          nodes.push(node);
        }

        return nodes;
      };

      const tree = await buildNode(rootPath || '', 1);

      // Flatten tree into renderable lines
      const lines = [];
      let dirCount = 0;
      let fileCount = 0;

      const flatten = (nodes, prefix) => {
        nodes.forEach((node, index) => {
          const isLast = index === nodes.length - 1;
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
          const icon = node.isFolder ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
          const dropboxUrl = `https://www.dropbox.com/home${node.pathDisplay}`;

          if (node.isFolder) dirCount++;
          else fileCount++;

          lines.push({
            prefix: prefix + connector,
            icon,
            name: node.name,
            pathDisplay: node.pathDisplay,
            isFolder: node.isFolder,
            url: dropboxUrl,
          });

          if (node.children.length > 0) {
            const childPrefix = prefix + (isLast ? '    ' : '\u2502   ');
            flatten(node.children, childPrefix);
          }
        });
      };

      flatten(tree, '');

      setTreeLines(lines);
      setTreeSummary(`${dirCount} directories, ${fileCount} files`);
      setStatus(`Tree loaded: ${dirCount} directories, ${fileCount} files`);
    } catch (error) {
      setStatus('Error loading tree: ' + error.message);
    } finally {
      setTreeLoading(false);
    }
  }, [accessToken, listFolder]);

  const handlePathKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleLoadTree();
    }
  };

  // Open a file in the full-screen view/edit modal
  const openFileModal = useCallback(async (line) => {
    setModalFile({ name: line.name, pathDisplay: line.pathDisplay });
    setModalContent('');
    setModalError('');
    setModalBinary(false);
    setModalEditMode(false);
    setModalShowMd(false);
    setModalCopied(false);
    setModalLoading(true);
    try {
      const res = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path: line.pathDisplay }),
        },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setModalError(err.error_summary || `HTTP ${res.status}`);
      } else {
        const text = await res.text();
        // Heuristic: null bytes mean binary content, don't show an editor
        if (text.includes('\0')) {
          setModalBinary(true);
        } else if (line.name.toLowerCase().endsWith('.rtf')) {
          // Render .rtf as plain text (falls back to raw source if parsing fails)
          try {
            setModalContent(rtfToPlainText(text));
          } catch {
            setModalContent(text);
          }
        } else {
          setModalContent(text);
        }
      }
    } catch (err) {
      setModalError(err.message);
    } finally {
      setModalLoading(false);
    }
  }, [accessToken]);

  // Path input submit: if the path points to a specific file, grab that file
  // directly in the view/edit modal; otherwise load it as a folder tree.
  const handleLoadTree = useCallback(async () => {
    const path = treePath.trim().replace(/\/+$/, '');
    if (path && accessToken) {
      try {
        const res = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ path }),
        });
        if (res.ok) {
          const meta = await res.json();
          if (meta['.tag'] === 'file') {
            openFileModal({ name: meta.name, pathDisplay: meta.path_display });
            return;
          }
        }
      } catch {
        // Metadata lookup failed — fall through to tree load
      }
    }
    loadTree(path, treeDepth);
  }, [treePath, treeDepth, loadTree, accessToken, openFileModal]);

  // Copy the modal's file contents to the clipboard
  const copyModalContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(modalContent);
      setModalCopied(true);
      setTimeout(() => setModalCopied(false), 1500);
    } catch (err) {
      setModalError('Copy failed: ' + err.message);
    }
  }, [modalContent]);

  // Save edited content back to Dropbox (overwrite)
  const saveModalFile = useCallback(async () => {
    if (!modalFile || modalSaving) return;
    // .rtf files are shown as extracted plain text — save as a new <name>.txt
    // alongside the original instead of overwriting the .rtf
    const isRtf = modalFile.name.toLowerCase().endsWith('.rtf');
    const savePath = isRtf
      ? modalFile.pathDisplay.replace(/\.rtf$/i, '.txt')
      : modalFile.pathDisplay;
    setModalSaving(true);
    setModalError('');
    try {
      const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': dropboxApiArg({
            path: savePath,
            mode: 'overwrite',
            mute: false,
          }),
        },
        body: new Blob([modalContent]),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setModalError('Save failed: ' + (err.error_summary || `HTTP ${res.status}`));
      } else {
        setStatus(isRtf ? `Saved as: ${savePath}` : `Saved: ${savePath}`);
        if (isRtf) {
          // Point the pane at the new .txt and refresh the tree so it appears
          const txtName = savePath.substring(savePath.lastIndexOf('/') + 1);
          setModalFile({ name: txtName, pathDisplay: savePath });
          loadTree(treePath.trim().replace(/\/+$/, ''), treeDepth);
        }
        setModalEditMode(false);
      }
    } catch (err) {
      setModalError('Save error: ' + err.message);
    } finally {
      setModalSaving(false);
    }
  }, [accessToken, modalFile, modalContent, modalSaving, loadTree, treePath, treeDepth]);

  // Drag the center divider to resize the two panes; double-click resets the ratio
  const startDividerDrag = useCallback((e) => {
    e.preventDefault();
    const container = panesContainerRef.current;
    if (!container) return;
    setDividerDragging(true);
    document.body.style.userSelect = 'none';
    const rect = container.getBoundingClientRect();
    let ratio = 0.4;
    const onMove = (ev) => {
      ratio = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0.15), 0.85);
      setPaneRatio(ratio);
    };
    const onUp = () => {
      setDividerDragging(false);
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('paneSplitRatio', String(ratio)); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const resetPaneRatio = useCallback(() => {
    setPaneRatio(0.4);
    try { localStorage.removeItem('paneSplitRatio'); } catch { /* ignore */ }
  }, []);

  // Reset line cursor whenever the modal opens a new file
  useEffect(() => {
    lineNavCurLineRef.current = -1;
    setLineNavCurLine(-1);
  }, [modalFile]);

  // Keep the topbar line-number input in sync with ,/. and arrow-button navigation
  useEffect(() => {
    setLineInputValue(lineNavCurLine >= 0 ? String(lineNavCurLine + 1) : '');
  }, [lineNavCurLine]);

  // Highlight a 0-based line in the file-pane <pre>, scroll to it, optionally speak it
  const highlightModalLine = useCallback((target, speak) => {
    const preEl = modalPreRef.current;
    if (!preEl) return;
    const lines = preEl.textContent.split('\n');
    if (!lines.length) return;
    if (target < 0 || target >= lines.length) return;
    lineNavCurLineRef.current = target;
    setLineNavCurLine(target);

    let targetStart = 0;
    for (let i = 0; i < target; i++) targetStart += lines[i].length + 1;
    const targetEnd = targetStart + lines[target].length;

    // Build a DOM range spanning the target line
    function makeRange(root, startChar, endChar) {
      let pos = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
      function walk(n) {
        if (sNode && eNode) return;
        if (n.nodeType === 3) {
          const len = n.textContent.length;
          if (!sNode && pos + len > startChar) { sNode = n; sOff = startChar - pos; }
          if (!eNode && pos + len >= endChar) { eNode = n; eOff = endChar - pos; }
          pos += len;
        } else {
          for (let i = 0; i < n.childNodes.length; i++) { walk(n.childNodes[i]); if (sNode && eNode) return; }
        }
      }
      walk(root);
      if (!sNode) return null;
      if (!eNode) { eNode = sNode; eOff = sNode.textContent.length; }
      const r = document.createRange();
      r.setStart(sNode, sOff);
      r.setEnd(eNode, eOff);
      return r;
    }

    const newRange = makeRange(preEl, targetStart, targetEnd);
    if (!newRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(newRange);

    // Scroll into view without mutating the DOM (insertNode would corrupt the selection)
    const rect = newRange.getBoundingClientRect();
    const bodyEl = preEl.closest('.file-modal-body');
    if (bodyEl && rect) {
      const bodyRect = bodyEl.getBoundingClientRect();
      bodyEl.scrollBy({ top: rect.top - bodyRect.top - bodyEl.clientHeight / 2 + rect.height / 2, behavior: 'smooth' });
    }

    if (speak) {
      const text = lines[target].trim();
      if (text) {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = 'en-US';
        window.speechSynthesis.speak(utt);
      }
    }
  }, []);

  // Step lines in the file-pane <pre>, skipping blanks, optionally speaking via TTS
  const navigateModalLine = useCallback((direction, speak) => {
    const preEl = modalPreRef.current;
    if (!preEl) return;
    const lines = preEl.textContent.split('\n');
    if (!lines.length) return;

    const curLine = lineNavCurLineRef.current;
    // Skip blank lines — keep stepping until we land on a non-empty line
    let target = curLine;
    do { target += direction; } while (target >= 0 && target < lines.length && lines[target].trim() === '');
    if (target < 0 || target >= lines.length) return;
    highlightModalLine(target, speak);
  }, [highlightModalLine]);

  // Jump to a 1-based line number from the topbar input
  const jumpToModalLine = useCallback((lineNum) => {
    const target = Math.floor(Number(lineNum)) - 1;
    if (isNaN(target)) return;
    highlightModalLine(target, false);
  }, [highlightModalLine]);

  // Keyboard shortcuts when file modal is open
  useEffect(() => {
    if (!modalFile) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { setModalFile(null); return; }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !modalEditMode && !modalShowMd) {
        if (e.key === ',' || e.key === '.') {
          e.preventDefault();
          navigateModalLine(e.key === ',' ? -1 : 1, false);
        } else if (e.key === 'r') {
          const sel = window.getSelection();
          const text = sel ? sel.toString().trim() : '';
          if (text) {
            e.preventDefault();
            window.speechSynthesis.cancel();
            const utt = new SpeechSynthesisUtterance(text);
            utt.lang = 'en-US';
            window.speechSynthesis.speak(utt);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [modalFile, modalEditMode, modalShowMd, navigateModalLine]);

  // ─── Music player logic ────────────────────────────────────────────────────

  // Fetch a Dropbox temporary link and start playing that track
  const fetchAndPlay = useCallback(async (track, idx) => {
    setMusicCurrentIdx(idx);
    setMusicCurrentUrl('');
    setMusicUrlLoading(true);
    setMusicError('');
    setMusicChapters([]);
    try {
      const res = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: track.pathDisplay }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_summary || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setMusicCurrentUrl(data.link);

      // Load companion .txt chapters — try exact base name first, then YouTube ID fallback
      const base = track.name.replace(/\.[^.]+$/, '');
      const { exact, yt } = musicTxtMapRef.current;
      console.log('[chapters] track base:', base);
      console.log('[chapters] exact keys:', Object.keys(exact));
      console.log('[chapters] yt keys:', Object.keys(yt));
      let txtPath = exact[base];
      if (!txtPath) {
        const ytId = base.match(/\[([a-zA-Z0-9_-]{11})\]/);
        console.log('[chapters] ytId from track:', ytId?.[1]);
        if (ytId) txtPath = yt[ytId[1]];
      }
      console.log('[chapters] resolved txtPath:', txtPath);
      if (txtPath) {
        try {
          const txtRes = await fetch('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Dropbox-API-Arg': dropboxApiArg({ path: txtPath }),
            },
          });
          console.log('[chapters] download status:', txtRes.status);
          if (txtRes.ok) {
            const text = await txtRes.text();
            console.log('[chapters] raw text (first 200):', text.slice(0, 200));
            const parsed = parseChapters(text);
            console.log('[chapters] parsed chapters:', parsed);
            setMusicChapters(parsed);
          }
        } catch (e) {
          console.warn('[chapters] fetch error:', e);
        }
      }
    } catch (err) {
      setMusicError('Error loading track: ' + err.message);
    } finally {
      setMusicUrlLoading(false);
    }
  }, [accessToken]);

  // Always keep the ref pointing at the latest version (avoids stale closure in audio events)
  fetchAndPlayRef.current = fetchAndPlay;

  // Called from UI buttons / select to switch tracks
  const playMusicTrack = useCallback(async (idx) => {
    if (idx < 0 || idx >= musicTracks.length) return;
    await fetchAndPlay(musicTracks[idx], idx);
  }, [musicTracks, fetchAndPlay]);

  // When a new URL is ready, load it into the audio element and play
  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio || !musicCurrentUrl) return;
    audio.src = musicCurrentUrl;
    audio.volume = musicVolume / 100;
    audio.play().then(() => setMusicIsPlaying(true)).catch(() => {});
  }, [musicCurrentUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync volume changes
  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;
    audio.volume = musicVolume / 100;
  }, [musicVolume]);

  // Wire up audio element events once on mount
  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setMusicCurrentTime(audio.currentTime);
    const onDurationChange = () =>
      setMusicDuration(isNaN(audio.duration) ? 0 : audio.duration);
    const onEnded = () => {
      const nextIdx = musicCurrentIdxRef.current + 1;
      if (nextIdx < musicTracksRef.current.length) {
        fetchAndPlayRef.current(musicTracksRef.current[nextIdx], nextIdx);
      }
    };
    const onPlay = () => setMusicIsPlaying(true);
    const onPause = () => setMusicIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the music player for a folder: fetch audio files then start first track
  const openMusicPlayer = useCallback(async (folderPath, folderName) => {
    if (musicAudioRef.current) musicAudioRef.current.pause();

    setMusicModal({ folderPath, folderName });
    setMusicTracks([]);
    setMusicCurrentIdx(0);
    setMusicCurrentUrl('');
    setMusicIsPlaying(false);
    setMusicCurrentTime(0);
    setMusicDuration(0);
    setMusicError('');
    setMusicLoading(true);

    try {
      const entries = await listFolder(folderPath);

      // Build companion .txt maps:
      //   exact: baseName → pathDisplay (strict match)
      //   yt:    youtubeId → pathDisplay (fallback — matches any txt sharing the same [ID])
      const exact = {}, yt = {};
      entries.forEach((e) => {
        if (!e.isFolder && e.name.toLowerCase().endsWith('.txt')) {
          const base = e.name.slice(0, -4);
          exact[base] = e.pathDisplay;
          const m = base.match(/\[([a-zA-Z0-9_-]{11})\]/);
          if (m) yt[m[1]] = e.pathDisplay;
        }
      });
      musicTxtMapRef.current = { exact, yt };

      const audioFiles = entries
        .filter(
          (e) =>
            !e.isFolder &&
            AUDIO_EXTENSIONS.has(e.name.split('.').pop().toLowerCase())
        )
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true })
        );

      if (audioFiles.length === 0) {
        setMusicError('No audio files found in this folder.');
        setMusicLoading(false);
        return;
      }

      setMusicTracks(audioFiles);
      setMusicLoading(false);
      // fetchAndPlayRef always points at the latest fetchAndPlay
      await fetchAndPlayRef.current(audioFiles[0], 0);
    } catch (err) {
      setMusicError('Error loading folder: ' + err.message);
      setMusicLoading(false);
    }
  }, [listFolder]);

  const closeMusicPlayer = useCallback(() => {
    if (musicAudioRef.current) {
      musicAudioRef.current.pause();
      musicAudioRef.current.src = '';
    }
    setMusicModal(null);
    setMusicTracks([]);
    setMusicCurrentUrl('');
    setMusicIsPlaying(false);
    setMusicCurrentTime(0);
    setMusicDuration(0);
    setMusicChapters([]);
    musicTxtMapRef.current = { exact: {}, yt: {} };
  }, []);

  const toggleMusicPlay = useCallback(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;
    if (musicIsPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
  }, [musicIsPlaying]);

  // Escape key toggles play/pause in music player
  useEffect(() => {
    if (!musicModal) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') toggleMusicPlay();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [musicModal, toggleMusicPlay]);

  // Auto-scroll chapter list to keep active chapter visible
  useEffect(() => {
    const list = chapterListRef.current;
    if (!list || musicChapters.length === 0) return;
    const activeEl = list.querySelector('.music-chapter-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [musicChapters, musicCurrentTime]);

  const handleMusicSeek = useCallback(
    (e) => {
      const audio = musicAudioRef.current;
      if (!audio || !musicDuration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = Math.max(0, Math.min(1, pct)) * musicDuration;
    },
    [musicDuration]
  );

  // ──────────────────────────────────────────────────────────────────────────

  // Apply filters for display
  const excludeLower = treeExclude.trim().toLowerCase();
  const displayLines = treeLines.filter((line) => {
    // Folders-only filter
    if (treeFoldersOnly && !line.isFolder) return false;

    // Exclude filter: hide matching folder and its children
    if (excludeLower) {
      // Check if this line's path contains an excluded folder segment
      const segments = line.pathDisplay.toLowerCase().split('/');
      if (segments.some((seg) => seg === excludeLower)) return false;
    }

    return true;
  });

  // Recount for summary after filters
  const filteredDirCount = displayLines.filter((l) => l.isFolder).length;
  const filteredFileCount = displayLines.filter((l) => !l.isFolder).length;
  const displaySummary = (excludeLower || treeFoldersOnly)
    ? (treeFoldersOnly
      ? `${filteredDirCount} directories`
      : `${filteredDirCount} directories, ${filteredFileCount} files`)
    : treeSummary;

  if (!APP_KEY) {
    return (
      <div className="dropbox-search">
        <h2>Setup Required</h2>
        <p>Create a <code>.env.local</code> file with:</p>
        <pre>REACT_APP_DROPBOX_APP_KEY=your-app-key</pre>
        <p>Get an App Key from the <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">Dropbox App Console</a></p>
      </div>
    );
  }

  return (
    <div className="dropbox-search">
      {/* Hidden audio element — always in DOM so the ref is always valid */}
      <audio ref={musicAudioRef} style={{ display: 'none' }} />

      <div className="dropbox-header">
        <h1>Dropbox Search</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {accessToken ? (
            <button onClick={handleSignOut} className="sign-out-btn">
              Sign Out
            </button>
          ) : (
            <button onClick={handleSignIn} className="sign-in-btn">
              Sign in with Dropbox
            </button>
          )}
        </div>
      </div>

      {accessToken && (
        <div className="tree-container">
          <div className="tree-controls">
            <input
              type="text"
              className="tree-path-input"
              value={treePath}
              onChange={(e) => setTreePath(e.target.value)}
              onKeyPress={handlePathKeyPress}
              placeholder="Path (e.g. /videos)..."
              autoFocus
            />
            <select
              className="tree-preset-select"
              onChange={(e) => {
                const path = e.target.value;
                if (!path) return;
                setTreePath(path);
                loadTree(path.replace(/\/+$/, ''), treeDepth);
              }}
              value=""
            >
              <option value="">-- Presets --</option>
              {Object.entries(FOLDER_PRESETS).map(([label, path]) => (
                <option key={path} value={path}>{label}</option>
              ))}
            </select>
            <select
              className="tree-depth-select"
              value={treeDepth}
              onChange={(e) => setTreeDepth(Number(e.target.value))}
            >
              <option value={1}>Depth 1</option>
              <option value={2}>Depth 2</option>
              <option value={3}>Depth 3</option>
            </select>
            <input
              type="text"
              className="tree-exclude-input"
              value={treeExclude}
              onChange={(e) => setTreeExclude(e.target.value)}
              placeholder="Exclude folder..."
            />
            <label className="tree-folders-only">
              <input
                type="checkbox"
                checked={treeFoldersOnly}
                onChange={(e) => setTreeFoldersOnly(e.target.checked)}
              />
              Folders only
            </label>
            <button
              className="tree-load-btn"
              onClick={handleLoadTree}
              disabled={treeLoading}
            >
              {treeLoading ? 'Loading...' : 'Load Tree'}
            </button>
          </div>

          {status && <div className="status">{status}</div>}

          {displayLines.length > 0 && (
            <div className="tree-download-row">
              <button
                className="tree-action-btn tree-download-btn"
                onClick={() => {
                  const root = treePath || '/';
                  const textLines = [root];
                  displayLines.forEach((line) => {
                    textLines.push(line.prefix + line.name);
                  });
                  if (displaySummary) {
                    textLines.push('');
                    textLines.push(displaySummary);
                  }
                  const blob = new Blob([textLines.join('\n')], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const safeName = (treePath || 'root').replace(/\//g, '_').replace(/^_/, '');
                  a.download = `tree_${safeName}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download .txt
              </button>
              <button
                className="tree-action-btn tree-newfile-btn"
                onClick={async () => {
                  let filename = window.prompt('New file name:', 'untitled.txt');
                  if (!filename) return;
                  if (!filename.includes('.')) filename += '.txt';
                  const dir = treePath.trim().replace(/\/+$/, '') || '';
                  const fullPath = dir ? `${dir}/${filename}` : `/${filename}`;
                  try {
                    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
                      method: 'POST',
                      headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/octet-stream',
                        'Dropbox-API-Arg': JSON.stringify({
                          path: fullPath,
                          mode: 'add',
                          autorename: true,
                          mute: false,
                        }),
                      },
                      body: new Blob(['hello world']),
                    });
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}));
                      setStatus('Error creating file: ' + (err.error_summary || `HTTP ${res.status}`));
                    } else {
                      const data = await res.json();
                      setStatus(`Created: ${data.path_display}`);
                      loadTree(treePath.trim().replace(/\/+$/, ''), treeDepth);
                    }
                  } catch (err) {
                    setStatus('Error creating file: ' + err.message);
                  }
                }}
              >
                New File
              </button>
              <button
                className="tree-action-btn tree-play-btn"
                onClick={() => {
                  const folderName = treePath.split('/').filter(Boolean).pop() || treePath || 'root';
                  openMusicPlayer(treePath.trim().replace(/\/+$/, '') || '', folderName);
                }}
              >
                Play
              </button>
            </div>
          )}

          <div className="panes-container" ref={panesContainerRef}>
            <div
              className="tree-output"
              style={modalFile ? { flex: 'none', width: `${paneRatio * 100}%` } : undefined}
            >
            {treePath && (
              <div className="tree-root-line">
                {treePath.includes('/') && treePath !== '/' && (
                  <button
                    className="tree-up-btn"
                    onClick={() => {
                      const parent = treePath.substring(0, treePath.lastIndexOf('/')) || '';
                      setTreePath(parent);
                      loadTree(parent, treeDepth);
                    }}
                    title="Go up one directory"
                  >
                    &uarr; Up
                  </button>
                )}
                {treePath}
              </div>
            )}
            {displayLines.map((line, idx) => (
              <div
                key={idx}
                className={`tree-line${modalFile && modalFile.pathDisplay === line.pathDisplay ? ' active' : ''}${line.isFolder ? '' : ' tree-line-clickable'}`}
                onClick={line.isFolder ? undefined : () => openFileModal(line)}
              >
                <span className="tree-connector">{line.prefix}</span>
                <span className="tree-icon">{line.icon}</span>
                <span
                  className={line.isFolder ? 'tree-name-text' : 'tree-name-text tree-name-clickable'}
                  title={line.isFolder ? undefined : `View/edit ${line.pathDisplay}`}
                >
                  {line.name}
                </span>
                {line.isFolder && (
                  <>
                    <button
                      className="tree-action-btn tree-browse-btn"
                      onClick={() => {
                        setTreePath(line.pathDisplay);
                        loadTree(line.pathDisplay, treeDepth);
                      }}
                      title={`Browse ${line.pathDisplay}`}
                    >
                      Browse
                    </button>
                    <button
                      className="tree-action-btn tree-play-btn"
                      onClick={() => openMusicPlayer(line.pathDisplay, line.name)}
                      title={`Play music in ${line.pathDisplay}`}
                    >
                      Play
                    </button>
                  </>
                )}
                {line.isFolder ? (
                  <a
                    href={line.url}
                    target="_blank"
                    rel="noreferrer"
                    className="tree-action-btn tree-open-btn"
                    title={line.url}
                  >
                    Open
                  </a>
                ) : (
                  <button
                    className="tree-action-btn tree-open-btn"
                    onClick={(e) => { e.stopPropagation(); openFileModal(line); }}
                    title={`View/edit ${line.pathDisplay}`}
                  >
                    Open
                  </button>
                )}
                <button
                  className="tree-action-btn tree-rename-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const newName = window.prompt('Rename to:', line.name);
                    if (!newName || newName === line.name) return;
                    const parentDir = line.pathDisplay.substring(0, line.pathDisplay.lastIndexOf('/'));
                    const toPath = `${parentDir}/${newName}`;
                    try {
                      const res = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
                        method: 'POST',
                        headers: {
                          Authorization: `Bearer ${accessToken}`,
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ from_path: line.pathDisplay, to_path: toPath, autorename: false }),
                      });
                      if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        setStatus('Rename failed: ' + (err.error_summary || `HTTP ${res.status}`));
                      } else {
                        setStatus(`Renamed to: ${toPath}`);
                        loadTree(treePath.trim().replace(/\/+$/, ''), treeDepth);
                      }
                    } catch (err) {
                      setStatus('Rename error: ' + err.message);
                    }
                  }}
                  title="Rename"
                >
                  Rename
                </button>
                <button
                  className="tree-action-btn tree-move-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const destDir = window.prompt('Move to folder (or type "delete" to delete):', lastMovePath || '/');
                    if (!destDir) return;

                    // Typing "delete" deletes the file/folder instead of moving it
                    if (destDir.trim().toLowerCase() === 'delete') {
                      if (!window.confirm(`Delete ${line.pathDisplay}?`)) return;
                      try {
                        const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
                          method: 'POST',
                          headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({ path: line.pathDisplay }),
                        });
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}));
                          setStatus('Delete failed: ' + (err.error_summary || `HTTP ${res.status}`));
                        } else {
                          setStatus(`Deleted: ${line.pathDisplay}`);
                          // Close pane 2 if the deleted file is open there
                          if (modalFile && modalFile.pathDisplay === line.pathDisplay) setModalFile(null);
                          loadTree(treePath.trim().replace(/\/+$/, ''), treeDepth);
                        }
                      } catch (err) {
                        setStatus('Delete error: ' + err.message);
                      }
                      return;
                    }

                    const normalizedDest = destDir.trim().replace(/\/+$/, '');
                    const toPath = `${normalizedDest}/${line.name}`;
                    try {
                      const res = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
                        method: 'POST',
                        headers: {
                          Authorization: `Bearer ${accessToken}`,
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ from_path: line.pathDisplay, to_path: toPath, autorename: false }),
                      });
                      if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        setStatus('Move failed: ' + (err.error_summary || `HTTP ${res.status}`));
                      } else {
                        setLastMovePath(normalizedDest);
                        setStatus(`Moved to: ${toPath}`);
                        loadTree(treePath.trim().replace(/\/+$/, ''), treeDepth);
                      }
                    } catch (err) {
                      setStatus('Move error: ' + err.message);
                    }
                  }}
                  title="Move (or type &quot;delete&quot; to delete)"
                >
                  Move
                </button>
              </div>
            ))}
            {displayLines.length > 0 && displaySummary && (
              <div className="tree-summary">
                {'\n'}{displaySummary}
              </div>
            )}
            {!treeLoading && treeLines.length === 0 && !status && (
              <div className="tree-empty">
                Enter a path or select a preset, then click Load Tree.
              </div>
            )}
            </div>

            {modalFile && (
              <>
                <div
                  className={`pane-divider${dividerDragging ? ' dragging' : ''}`}
                  onMouseDown={startDividerDrag}
                  onDoubleClick={resetPaneRatio}
                  title="Drag to resize panes (double-click to reset)"
                />
                <div className="pane-right">
          <div className="file-modal-topbar">
            {!modalLoading && !modalError && !modalBinary && !modalEditMode && !modalShowMd ? (
              <span className="file-modal-linenav">
                Line
                <input
                  type="number"
                  className="file-modal-line-input"
                  value={lineInputValue}
                  min={1}
                  max={modalContent ? modalContent.split('\n').length : 1}
                  placeholder="–"
                  onChange={(e) => {
                    setLineInputValue(e.target.value);
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n)) jumpToModalLine(n);
                  }}
                  title="Jump to line"
                />
                <span className="file-modal-line-total">
                  / {modalContent ? modalContent.split('\n').length : 0}
                </span>
              </span>
            ) : (
              <span className="file-modal-linenav" />
            )}
            <div className="file-modal-actions">
              {!modalLoading && !modalBinary && !modalError && (
                <button
                  className="file-modal-copy-btn"
                  onClick={copyModalContent}
                  title="Copy file contents to clipboard"
                >
                  {modalCopied ? 'Copied!' : 'Copy'}
                </button>
              )}
              {!modalLoading && !modalBinary && !modalError && !modalEditMode && (
                <button
                  className="file-modal-txtmd-btn"
                  onClick={() => setModalShowMd((v) => !v)}
                  title="Toggle markdown/text view"
                  style={{
                    background: modalShowMd ? '#4caf50' : 'rgb(224,224,224)',
                    color: modalShowMd ? '#fff' : 'rgb(51,51,51)',
                  }}
                >
                  {modalShowMd ? 'MD>TXT' : 'TXT>MD'}
                </button>
              )}
              {!modalLoading && !modalBinary && !modalError && !modalEditMode && (
                <button
                  className="file-modal-edit-btn"
                  onClick={() => { setModalShowMd(false); setModalEditMode(true); }}
                >
                  Edit
                </button>
              )}
              {!modalLoading && !modalBinary && !modalError && modalEditMode && (
                <>
                  <button
                    className="file-modal-save-btn"
                    onClick={saveModalFile}
                    disabled={modalSaving}
                  >
                    {modalSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    className="file-modal-cancel-btn"
                    onClick={() => setModalEditMode(false)}
                  >
                    Cancel
                  </button>
                </>
              )}
              <a
                href={`https://www.dropbox.com/home${modalFile.pathDisplay}`}
                target="_blank"
                rel="noreferrer"
                className="file-modal-link-btn"
                title="Open in Dropbox"
              >
                Dropbox
              </a>
              <button
                className="file-modal-close-btn"
                onClick={() => setModalFile(null)}
                title="Close (Esc)"
              >
                &times;
              </button>
            </div>
          </div>
          <div className="file-modal-body">
            {modalLoading && <div className="file-modal-message">Loading...</div>}
            {modalError && <div className="file-modal-error">{modalError}</div>}
            {!modalLoading && !modalError && modalBinary && (
              <div className="file-modal-message">
                Binary file — preview not available. Use the Dropbox button to open it.
              </div>
            )}
            {!modalLoading && !modalError && !modalBinary && modalEditMode && (
              <textarea
                className="file-modal-textarea"
                value={modalContent}
                onChange={(e) => setModalContent(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            )}
            {!modalLoading && !modalError && !modalBinary && !modalEditMode && modalShowMd && (
              <div
                className="file-modal-markdown"
                dangerouslySetInnerHTML={{ __html: marked.parse(modalContent) }}
              />
            )}
            {!modalLoading && !modalError && !modalBinary && !modalEditMode && !modalShowMd && (
              <pre className="file-modal-pre" ref={modalPreRef}>{modalContent}</pre>
            )}
          </div>
          {/* Line navigation floating buttons — visible when viewing pre content */}
          {!modalLoading && !modalError && !modalBinary && !modalEditMode && !modalShowMd && (
            <>
              {/* Highlight-only ↑↓ — white border, left side */}
              <button style={{position:'absolute',left:'6px',top:'calc(50% - 30px)',transform:'translateY(-50%)',zIndex:5,width:'48px',height:'48px',background:'rgba(255,255,255,0.08)',borderRadius:'50%',border:'1.5px solid rgba(255,255,255,0.8)',opacity:0.15,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0,transition:'opacity 0.2s'}} onMouseDown={e=>{e.preventDefault();navigateModalLine(-1,false);}} onMouseEnter={e=>e.currentTarget.style.opacity='0.55'} onMouseLeave={e=>e.currentTarget.style.opacity='0.15'} title="Highlight prev line (,)">
                <svg width="48" height="48" viewBox="0 0 64 64"><path d="M8 44 L32 20 L56 44" stroke="rgba(255,255,255,0.9)" strokeWidth="8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <button style={{position:'absolute',left:'6px',top:'calc(50% + 30px)',transform:'translateY(-50%)',zIndex:5,width:'48px',height:'48px',background:'rgba(255,255,255,0.08)',borderRadius:'50%',border:'1.5px solid rgba(255,255,255,0.8)',opacity:0.15,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0,transition:'opacity 0.2s'}} onMouseDown={e=>{e.preventDefault();navigateModalLine(1,false);}} onMouseEnter={e=>e.currentTarget.style.opacity='0.55'} onMouseLeave={e=>e.currentTarget.style.opacity='0.15'} title="Highlight next line (.)">
                <svg width="48" height="48" viewBox="0 0 64 64"><path d="M8 20 L32 44 L56 20" stroke="rgba(255,255,255,0.9)" strokeWidth="8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {/* Highlight + TTS ↑↓ — amber border, right:6px */}
              <button style={{position:'absolute',right:'6px',top:'calc(50% - 30px)',transform:'translateY(-50%)',zIndex:5,width:'48px',height:'48px',background:'rgba(255,255,255,0.08)',borderRadius:'50%',border:'1.5px solid rgba(255,200,50,0.8)',opacity:0.15,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0,transition:'opacity 0.2s'}} onMouseDown={e=>{e.preventDefault();navigateModalLine(-1,true);}} onMouseEnter={e=>e.currentTarget.style.opacity='0.55'} onMouseLeave={e=>e.currentTarget.style.opacity='0.15'} title="Highlight prev line & speak (r)">
                <svg width="48" height="48" viewBox="0 0 64 64"><path d="M8 44 L32 20 L56 44" stroke="rgba(255,200,50,0.9)" strokeWidth="8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <button style={{position:'absolute',right:'6px',top:'calc(50% + 30px)',transform:'translateY(-50%)',zIndex:5,width:'48px',height:'48px',background:'rgba(255,255,255,0.08)',borderRadius:'50%',border:'1.5px solid rgba(255,200,50,0.8)',opacity:0.15,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0,transition:'opacity 0.2s'}} onMouseDown={e=>{e.preventDefault();navigateModalLine(1,true);}} onMouseEnter={e=>e.currentTarget.style.opacity='0.55'} onMouseLeave={e=>e.currentTarget.style.opacity='0.15'} title="Highlight next line & speak (r)">
                <svg width="48" height="48" viewBox="0 0 64 64"><path d="M8 20 L32 44 L56 20" stroke="rgba(255,200,50,0.9)" strokeWidth="8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </>
          )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Music Player Modal ── */}
      {musicModal && (() => {
        const currentTrackName = musicTracks[musicCurrentIdx]?.name || '';
        const ytMatch = currentTrackName.match(/\[([a-zA-Z0-9_-]{11})\]/);
        const youtubeId = ytMatch ? ytMatch[1] : null;
        return (
        <div className="music-modal">
          <div className="music-modal-header">
            <span className="music-modal-title" title={musicModal.folderPath}>
              ♪ {musicModal.folderName}
            </span>
            <button className="music-modal-close" onClick={closeMusicPlayer} title="Close player">
              &times;
            </button>
          </div>

          {musicLoading && (
            <div className="music-modal-msg">Loading tracks...</div>
          )}
          {musicError && (
            <div className="music-modal-error">{musicError}</div>
          )}

          {!musicLoading && musicTracks.length > 0 && (
            <>
              {/* Track selector dropdown */}
              <div className="music-select-row">
                <select
                  className="music-track-select"
                  value={musicCurrentIdx}
                  onChange={(e) => playMusicTrack(Number(e.target.value))}
                >
                  {musicTracks.map((t, i) => (
                    <option key={i} value={i}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* Progress bar */}
              <div className="music-progress-bar" onClick={handleMusicSeek}>
                <div
                  className="music-progress-fill"
                  style={{
                    width: musicDuration > 0
                      ? `${(musicCurrentTime / musicDuration) * 100}%`
                      : '0%',
                  }}
                />
              </div>
              <div className="music-time">
                {formatTime(musicCurrentTime)} / {formatTime(musicDuration)}
              </div>

              {/* Volume */}
              <div className="music-volume-row">
                <span>&#128264;</span>
                <input
                  type="range"
                  className="music-volume-slider"
                  min="0"
                  max="100"
                  value={musicVolume}
                  onChange={(e) => setMusicVolume(Number(e.target.value))}
                />
                <span>&#128266;</span>
              </div>

              {/* Transport controls */}
              <div className="music-controls">
                <button
                  className="music-btn"
                  onClick={() => playMusicTrack(musicCurrentIdx - 1)}
                  disabled={musicCurrentIdx <= 0}
                  title="Previous"
                >
                  ⏮
                </button>
                <button
                  className="music-btn music-play-btn"
                  onClick={toggleMusicPlay}
                  disabled={musicUrlLoading}
                  title="Play / Pause (esc)"
                >
                  {musicUrlLoading ? '...' : musicIsPlaying ? '⏸' : '▶'} <span style={{fontSize:'0.65em', opacity:0.7}}>(esc)</span>
                </button>
                <button
                  className="music-btn"
                  onClick={() => playMusicTrack(musicCurrentIdx + 1)}
                  disabled={musicCurrentIdx >= musicTracks.length - 1}
                  title="Next"
                >
                  ⏭
                </button>
                {youtubeId && (
                  <a
                    href={`https://www.youtube.com/watch?v=${youtubeId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="music-btn music-yt-btn"
                    title="Open on YouTube"
                  >
                    YT
                  </a>
                )}
              </div>

              {/* Track list */}
              <div className="music-track-list">
                {musicTracks.map((t, i) => (
                  <div
                    key={i}
                    className={`music-track-item${i === musicCurrentIdx ? ' active' : ''}`}
                    onClick={() => playMusicTrack(i)}
                    title={t.name}
                  >
                    {t.name}
                  </div>
                ))}
              </div>

              {/* Chapter list — always visible; populated from companion .txt */}
              {(() => {
                const activeChapterIdx = musicChapters.reduce((found, ch, i) =>
                  ch.timeSecs <= musicCurrentTime ? i : found, -1);
                return (
                  <div className="music-chapter-list" ref={chapterListRef}>
                    <div className="music-chapter-header">Tracklist</div>
                    {musicChapters.length === 0 ? (
                      <div className="music-chapter-empty">
                        {musicUrlLoading ? 'Looking for tracklist…' : 'No tracklist found — add a .txt with matching name or YouTube ID next to the audio file'}
                      </div>
                    ) : musicChapters.map((ch, i) => (
                      <div
                        key={i}
                        className={`music-chapter-item${i === activeChapterIdx ? ' active' : ''}`}
                        onClick={() => { musicAudioRef.current.currentTime = ch.timeSecs; }}
                      >
                        <span className="music-chapter-time">{formatTime(ch.timeSecs)}</span>
                        <span className="music-chapter-label">{ch.label}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}
        </div>
        );
      })()}
    </div>
  );
}

export default DropboxSearch;
