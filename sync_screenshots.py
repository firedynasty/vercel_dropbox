#!/usr/bin/env python3
"""Sync local screenshots to Dropbox and scan for image links.

1. rclone sync local vercel_screenshots -> dropbox:/vercel_screenshots
2. Recursively scan dropbox:/vercel_screenshots for images
3. Get shareable links for each image
4. Output screenshots.json

Usage:
  python sync_screenshots.py
  python sync_screenshots.py --dry-run
  python sync_screenshots.py --scan-only    # skip sync, just scan
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

LOCAL_DIR = os.path.expanduser('~/documents/notes/vercel_screenshots')
REMOTE_DIR = 'dropbox:/vercel_screenshots'

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg'}


def rclone(*args):
    result = subprocess.run(['rclone'] + list(args), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"rclone error: {result.stderr.strip()}", file=sys.stderr)
        return None
    return result.stdout.strip()


def list_files(remote_path):
    """List files recursively, sorted newest first."""
    output = rclone('lsjson', '-R', '--files-only', remote_path)
    if output is None:
        return []
    items = json.loads(output)
    items.sort(key=lambda x: x.get('ModTime', ''), reverse=True)
    return items


def get_link(remote_path):
    link = rclone('link', remote_path)
    if link:
        if 'dl=0' in link:
            link = link.replace('dl=0', 'raw=1')
        elif '?' in link:
            link += '&raw=1'
        else:
            link += '?raw=1'
    return link


def main():
    parser = argparse.ArgumentParser(description='Sync screenshots to Dropbox and scan for image links')
    parser.add_argument('--dry-run', action='store_true', help='List files without getting links')
    parser.add_argument('--scan-only', action='store_true', help='Skip sync, just scan Dropbox')
    args = parser.parse_args()

    # Step 1: Sync local -> Dropbox
    if not args.scan_only:
        if not os.path.isdir(LOCAL_DIR):
            print(f'Local directory not found: {LOCAL_DIR}')
            return 1

        print(f'Syncing {LOCAL_DIR} -> {REMOTE_DIR} ...')
        sync_args = ['sync', LOCAL_DIR, REMOTE_DIR, '-v', '--exclude', '.DS_Store']
        if args.dry_run:
            sync_args.append('--dry-run')
        result = subprocess.run(['rclone'] + sync_args, text=True)
        if result.returncode != 0:
            print('Sync failed.')
            return 1
        print('Sync complete.\n')

    # Step 2: Scan Dropbox for images
    print(f'Scanning {REMOTE_DIR} ...')
    all_files = list_files(REMOTE_DIR)
    image_files = [f for f in all_files if Path(f['Path']).suffix.lower() in IMAGE_EXTS]

    print(f'Found {len(image_files)} image(s) out of {len(all_files)} total files\n')

    if not image_files:
        print('No images found.')
        return 1

    if args.dry_run:
        for f in image_files:
            print(f"  {f['Path']}")
        print(f'\nTotal: {len(image_files)} images')
        return 0

    # Step 3: Get links for each image
    screenshots = []
    for idx, f in enumerate(image_files, 1):
        path = f['Path']
        parts = path.split('/')
        folder = parts[0] if len(parts) > 1 else ''
        name = parts[-1]

        print(f'  [{idx}/{len(image_files)}] {path} ...', end=' ', flush=True)
        link = get_link(f'{REMOTE_DIR}/{path}')
        if link:
            screenshots.append({
                'name': Path(name).stem,
                'file': name,
                'folder': folder,
                'path': path,
                'url': link,
            })
            print('ok')
        else:
            print('FAILED')

    # Step 4: Write screenshots.json
    output_path = Path(__file__).resolve().parent / 'public' / 'screenshots.json'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(screenshots, f, indent=2, ensure_ascii=False)

    print(f'\n-> Wrote {len(screenshots)} image(s) to {output_path}')

    # Step 5: Print deploy commands
    print(f'\n# Upload to Dropbox:')
    print(f'rclone copy public/screenshots.json dropbox:/vercel')
    print(f'rclone link dropbox:/vercel/screenshots.json')
    print(f'\n# Then update Vercel with the link (append &raw=1):')
    print(f'vercel env rm DROPBOX_SCREENSHOTS_URL production -y')
    print(f'echo "<LINK>&raw=1" | vercel env add DROPBOX_SCREENSHOTS_URL production')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
