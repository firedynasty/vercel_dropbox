import React, { useState, useEffect, useCallback } from 'react';
import { marked } from 'marked';

const APP_KEY = process.env.REACT_APP_DROPBOX_APP_KEY;

const FOLDER_PRESETS = {
  'Videos': '/videos',
  'Chess Reports': '/chess/reports',
  'Literature': '/literature/papers',
};

const REDIRECT_URI = window.location.origin;

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
    setModalSaving(true);
    setModalError('');
    try {
      const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            path: modalFile.pathDisplay,
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
        setStatus(`Saved: ${modalFile.pathDisplay}`);
        setModalEditMode(false);
      }
    } catch (err) {
      setModalError('Save error: ' + err.message);
    } finally {
      setModalSaving(false);
    }
  }, [accessToken, modalFile, modalContent, modalSaving]);

  // Escape key closes the modal
  useEffect(() => {
    if (!modalFile) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') setModalFile(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [modalFile]);

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
            </div>
          )}

          <div className="tree-output">
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
              <div key={idx} className="tree-line">
                <span className="tree-connector">{line.prefix}</span>
                <span className="tree-icon">{line.icon}</span>
                <span className="tree-name-text">{line.name}</span>
                {line.isFolder && (
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
                    onClick={() => openFileModal(line)}
                    title={`View/edit ${line.pathDisplay}`}
                  >
                    Open
                  </button>
                )}
                <button
                  className="tree-action-btn tree-rename-btn"
                  onClick={async () => {
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
                  onClick={async () => {
                    const destDir = window.prompt('Move to folder:', lastMovePath || '/');
                    if (!destDir) return;
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
                  title="Move"
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
        </div>
      )}

      {modalFile && (
        <div className="file-modal-overlay">
          <div className="file-modal-topbar">
            <span className="file-modal-title" title={modalFile.pathDisplay}>
              {modalFile.pathDisplay}
            </span>
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
              <pre className="file-modal-pre">{modalContent}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DropboxSearch;
