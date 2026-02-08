import React, { useState, useEffect, useCallback } from 'react';

const APP_KEY = process.env.REACT_APP_DROPBOX_APP_KEY;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [outputMode, setOutputMode] = useState('div');
  const [fileContent, setFileContent] = useState('');
  const [currentFileName, setCurrentFileName] = useState('');
  const [currentFilePath, setCurrentFilePath] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [searchMode, setSearchMode] = useState('file');
  const [folderPath, setFolderPath] = useState('');
  const [folderFiles, setFolderFiles] = useState([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // Handle OAuth redirect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      const verifier = sessionStorage.getItem('dropbox_code_verifier');
      if (verifier) {
        // Exchange code for token
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
              // Clean URL
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
      setResults([]);
      setFileContent('');
      setCurrentFileName('');
      setCurrentFilePath('');
      setIsEditMode(false);
      setEditContent('');
      setFolderPath('');
      setFolderFiles([]);
      setStatus('Signed out');
    }
  };

  const searchFiles = useCallback(async () => {
    if (!searchQuery.trim() || !accessToken) return;

    setLoading(true);
    setStatus('Searching...');
    setFolderPath('');
    setFolderFiles([]);

    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: searchQuery,
          options: { max_results: 20 },
        }),
      });

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      const matches = (data.matches || []).map((m) => {
        const metadata = m.metadata?.metadata || m.metadata;
        return {
          id: metadata.id,
          name: metadata.name,
          path: metadata.path_lower || metadata.path_display,
          isFolder: metadata['.tag'] === 'folder',
        };
      });

      setResults(matches);
      setStatus(`Found ${matches.length} files`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, accessToken]);

  const loadFolder = useCallback(async (path) => {
    setFolderLoading(true);
    setStatus(`Loading folder...`);

    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path }),
      });

      if (!response.ok) throw new Error('Failed to list folder');

      const data = await response.json();
      const entries = (data.entries || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        path: entry.path_lower || entry.path_display,
        isFolder: entry['.tag'] === 'folder',
      }));

      // Sort: folders first, then files, alphabetical within each
      entries.sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      setFolderPath(path);
      setFolderFiles(entries);
      setStatus(`Loaded ${entries.length} items from ${path}`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setFolderLoading(false);
    }
  }, [accessToken]);

  const searchFolders = useCallback(async () => {
    if (!searchQuery.trim() || !accessToken) return;

    setLoading(true);
    setStatus('Searching for folders...');
    setFolderPath('');
    setFolderFiles([]);

    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: searchQuery,
          options: {
            max_results: 20,
            file_categories: [{ '.tag': 'folder' }],
          },
        }),
      });

      if (!response.ok) throw new Error('Folder search failed');

      const data = await response.json();
      const folders = (data.matches || [])
        .map((m) => m.metadata?.metadata || m.metadata)
        .filter((m) => m['.tag'] === 'folder')
        .map((m) => ({
          id: m.id,
          name: m.name,
          path: m.path_lower || m.path_display,
          isFolder: true,
        }));

      setResults(folders);
      setStatus(`Found ${folders.length} folders`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, accessToken]);

  const handleSearch = useCallback(() => {
    if (searchMode === 'file') {
      searchFiles();
    } else {
      searchFolders();
    }
  }, [searchMode, searchFiles, searchFolders]);

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSidebarItemClick = async (filePath, fileName, isFolder) => {
    if (isFolder) {
      await loadFolder(filePath);
      return;
    }
    await handleFileClick(filePath, fileName);
  };

  const handleFileClick = async (filePath, fileName) => {
    setStatus(`Fetching ${fileName}...`);

    try {
      const response = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path: filePath }),
        },
      });

      if (!response.ok) throw new Error('Download failed');

      const content = await response.text();

      if (outputMode === 'clipboard') {
        await navigator.clipboard.writeText(content);
        setStatus(`Copied "${fileName}" to clipboard`);
      } else {
        setFileContent(content);
        setCurrentFileName(fileName);
        setCurrentFilePath(filePath);
        setRenameValue(fileName);
        setIsEditMode(false);
        setEditContent('');
        setStatus(`Loaded "${fileName}"`);
      }
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  };

  const handleBackToResults = () => {
    setFolderPath('');
    setFolderFiles([]);
  };

  const createNewFileFromClipboard = async () => {
    if (!folderPath || !accessToken) return;

    try {
      const clipboardText = await navigator.clipboard.readText();
      const now = new Date();
      const hours = now.getHours();
      const h12 = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${h12}.${pad(now.getMinutes())}.${pad(now.getSeconds())} ${ampm}`;
      const fileName = `Screenshot ${dateStr}.md`;
      const targetPath = `${folderPath}/${fileName}`;

      setStatus(`Creating "${fileName}"...`);

      const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({
            path: targetPath,
            mode: 'add',
            autorename: true,
            mute: true,
          }),
          'Content-Type': 'application/octet-stream',
        },
        body: clipboardText,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_summary || `HTTP ${response.status}`);
      }

      setStatus(`Created "${fileName}"`);
      await loadFolder(folderPath);
    } catch (error) {
      setStatus('Error creating file: ' + error.message);
    }
  };

  const toggleEditMode = () => {
    if (!isEditMode) {
      setEditContent(fileContent);
      setIsEditMode(true);
    } else {
      setFileContent(editContent);
      setIsEditMode(false);
    }
  };

  const saveFileToDropbox = async () => {
    if (!currentFilePath || !accessToken) return;

    setSaving(true);
    setStatus(`Saving "${currentFileName}"...`);

    try {
      const contentToSave = isEditMode ? editContent : fileContent;

      const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({
            path: currentFilePath,
            mode: 'overwrite',
            mute: true,
          }),
          'Content-Type': 'application/octet-stream',
        },
        body: contentToSave,
      });

      if (response.ok) {
        setFileContent(contentToSave);
        setIsEditMode(false);
        setStatus(`Saved "${currentFileName}" successfully!`);
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_summary || `HTTP ${response.status}`);
      }
    } catch (error) {
      setStatus('Error saving: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const renameFile = async () => {
    if (!renameValue.trim() || renameValue === currentFileName || !currentFilePath || !accessToken) return;
    const parentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
    const newPath = `${parentDir}/${renameValue}`;

    setStatus(`Renaming to "${renameValue}"...`);
    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_path: currentFilePath,
          to_path: newPath,
          autorename: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_summary || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const meta = data.metadata;
      setCurrentFileName(meta.name);
      setCurrentFilePath(meta.path_lower || meta.path_display);
      setRenameValue(meta.name);
      setStatus(`Renamed to "${meta.name}"`);
      if (folderPath) await loadFolder(folderPath);
    } catch (error) {
      setStatus('Error renaming: ' + error.message);
    }
  };

  const deleteFile = async () => {
    if (!currentFilePath || !accessToken) return;
    const code = window.prompt(`Type 1234 to delete "${currentFileName}"`);
    if (code !== '1234') {
      if (code !== null) setStatus('Delete cancelled — incorrect code');
      return;
    }

    setStatus(`Deleting "${currentFileName}"...`);
    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: currentFilePath }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_summary || `HTTP ${response.status}`);
      }

      const deletedName = currentFileName;
      setFileContent('');
      setCurrentFileName('');
      setCurrentFilePath('');
      setRenameValue('');
      setIsEditMode(false);
      setEditContent('');
      setStatus(`Deleted "${deletedName}"`);
      if (folderPath) await loadFolder(folderPath);
    } catch (error) {
      setStatus('Error deleting: ' + error.message);
    }
  };

  // Determine what to show in the sidebar list
  const sidebarItems = folderPath ? folderFiles : results;
  const showBackLink = !!folderPath;

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

      {accessToken && (
        <div className="dropbox-layout">
          <div className="dropbox-sidebar">
            <div className="sidebar-search">
              <div className="search-box">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder={searchMode === 'file' ? 'Search files...' : 'Search folders...'}
                  autoFocus
                />
                <button onClick={handleSearch} disabled={loading || folderLoading}>
                  {loading || folderLoading ? '...' : 'Search'}
                </button>
              </div>
              <div className="search-mode-toggle">
                <label>
                  <input
                    type="radio"
                    name="searchMode"
                    value="file"
                    checked={searchMode === 'file'}
                    onChange={(e) => setSearchMode(e.target.value)}
                  />
                  Files
                </label>
                <label>
                  <input
                    type="radio"
                    name="searchMode"
                    value="folder"
                    checked={searchMode === 'folder'}
                    onChange={(e) => setSearchMode(e.target.value)}
                  />
                  Folders
                </label>
              </div>
            </div>

            {showBackLink && (
              <div className="sidebar-nav">
                <div className="sidebar-nav-row">
                  <button className="back-link" onClick={handleBackToResults}>
                    &larr; Back to results
                  </button>
                  <button className="new-file-btn" onClick={createNewFileFromClipboard}>
                    + New File
                  </button>
                </div>
                <div className="folder-path">{folderPath}</div>
              </div>
            )}

            <div className="sidebar-results">
              {sidebarItems.map((file) => (
                <div
                  key={file.id}
                  className="result-item"
                  onClick={() => handleSidebarItemClick(file.path, file.name, file.isFolder)}
                >
                  <span className="file-icon">
                    {file.isFolder ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}
                  </span>
                  <span className="file-name">{file.name}</span>
                  {file.isFolder && !folderPath && (
                    <span className="file-path">{file.path}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="dropbox-main">
            {status && <div className="status">{status}</div>}

            <div className="toggle-group">
              <div className="output-mode-selector">
                <label>
                  <input
                    type="radio"
                    name="outputMode"
                    value="clipboard"
                    checked={outputMode === 'clipboard'}
                    onChange={(e) => setOutputMode(e.target.value)}
                  />
                  Copy to Clipboard
                </label>
                <label>
                  <input
                    type="radio"
                    name="outputMode"
                    value="div"
                    checked={outputMode === 'div'}
                    onChange={(e) => setOutputMode(e.target.value)}
                  />
                  View/Edit
                </label>
              </div>
            </div>

            {outputMode === 'div' && fileContent && (
              <div className="file-content-display">
                <div className="content-header">
                  <div className="rename-row">
                    <input
                      className="rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') renameFile(); }}
                    />
                    <button className="rename-btn" onClick={renameFile}>Rename</button>
                  </div>
                  <div className="content-actions">
                    <button
                      className="copy-btn"
                      onClick={async () => {
                        const contentToCopy = isEditMode ? editContent : fileContent;
                        await navigator.clipboard.writeText(contentToCopy);
                        setStatus(`Copied "${currentFileName}" to clipboard`);
                      }}
                    >
                      Copy
                    </button>
                    <button
                      className="paste-btn"
                      onClick={async () => {
                        const text = await navigator.clipboard.readText();
                        setEditContent(text);
                        setFileContent(text);
                        setIsEditMode(true);
                        setStatus(`Pasted clipboard into "${currentFileName}"`);
                      }}
                    >
                      Paste
                    </button>
                    <button
                      className="edit-btn"
                      onClick={toggleEditMode}
                    >
                      {isEditMode ? 'View' : 'Edit'}
                    </button>
                    {isEditMode && (
                      <button
                        className="save-btn"
                        onClick={saveFileToDropbox}
                        disabled={saving}
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    )}
                    <button
                      className="clear-btn"
                      onClick={() => {
                        setFileContent('');
                        setCurrentFileName('');
                        setCurrentFilePath('');
                        setIsEditMode(false);
                        setEditContent('');
                      }}
                    >
                      Clear
                    </button>
                    <button className="delete-btn" onClick={deleteFile}>
                      Delete
                    </button>
                  </div>
                </div>
                {isEditMode ? (
                  <textarea
                    className="edit-textarea"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                ) : (
                  <pre>{fileContent}</pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DropboxSearch;
