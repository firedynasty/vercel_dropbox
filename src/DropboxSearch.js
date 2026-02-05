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
      setStatus('Signed out');
    }
  };

  const searchFiles = useCallback(async () => {
    if (!searchQuery.trim() || !accessToken) return;

    setLoading(true);
    setStatus('Searching...');

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

  const handleFileClick = async (filePath, fileName, isFolder) => {
    if (isFolder) return;

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
        setIsEditMode(false);
        setEditContent('');
        setStatus(`Loaded "${fileName}"`);
      }
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      searchFiles();
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
      <h1>Dropbox Search</h1>

      {!accessToken ? (
        <button onClick={handleSignIn} className="sign-in-btn">
          Sign in with Dropbox
        </button>
      ) : (
        <>
          <div className="search-area">
            <div className="search-box">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Search file name..."
                autoFocus
              />
              <button onClick={searchFiles} disabled={loading}>
                {loading ? '...' : 'Search'}
              </button>
              <button onClick={handleSignOut} className="sign-out-btn">
                Sign Out
              </button>
            </div>
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
          </div>

          <div className="results">
            {results.map((file) => (
              <div
                key={file.id}
                className="result-item"
                onClick={() => handleFileClick(file.path, file.name, file.isFolder)}
              >
                <span className="file-icon">
                  {file.isFolder ? '📁' : '📄'}
                </span>
                <span className="file-name">{file.name}</span>
              </div>
            ))}
          </div>

          {status && <div className="status">{status}</div>}

          {outputMode === 'div' && fileContent && (
            <div className="file-content-display">
              <div className="content-header">
                <span>{currentFileName}</span>
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
        </>
      )}
    </div>
  );
}

export default DropboxSearch;
