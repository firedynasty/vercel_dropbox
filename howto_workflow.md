# Screenshots Workflow

## Adding new screenshots

1. Add image files to `~/documents/notes/vercel_screenshots/` in subfolders (e.g. `claude_notes/`, `claude_learning/`)

2. Run the sync and scan script from the project root:

```
python sync_screenshots.py
```

This will:
- Sync local images to `dropbox:/vercel_screenshots` (skips already-uploaded files)
- Scan Dropbox for all images recursively
- Get a share link for each image
- Write `public/screenshots.json`
- Print the deploy commands

3. Copy and run the printed commands:

```
rclone copy public/screenshots.json dropbox:/vercel
rclone link dropbox:/vercel/screenshots.json
```

4. Take the link from `rclone link` and update the Vercel env var:

```
vercel env rm DROPBOX_SCREENSHOTS_URL production -y
echo "<LINK>&raw=1" | vercel env add DROPBOX_SCREENSHOTS_URL production
```

Replace `<LINK>` with the actual link output.

## Useful flags

- `python sync_screenshots.py --dry-run` - preview what would sync/scan without making changes
- `python sync_screenshots.py --scan-only` - skip the sync step, just rescan Dropbox and regenerate links

## How it works

```
~/documents/notes/vercel_screenshots/
    claude_notes/claude1.png
    claude_learning/claude1.png
        |
        v  rclone sync
dropbox:/vercel_screenshots/
        |
        v  rclone link (for each image)
public/screenshots.json
        |
        v  rclone copy
dropbox:/vercel/screenshots.json
        |
        v  DROPBOX_SCREENSHOTS_URL env var
/api/screenshots  (Vercel serverless function)
        |
        v
Screenshots UI  (search by name, modal with left/right navigation)
```

## In the app

1. Click **Screenshots** button in the header
2. Type a name (e.g. `claude1`) to search
3. Click a result to open the modal
4. Use **left/right arrow keys** or buttons to navigate between matches
5. Press **Escape** to close
