# Google Drive Integration Tutorial

This app uses Google OAuth to let users sign in with their existing Google account. No separate registration is needed - users authenticate directly with Google, and the app gets temporary permission to read their Drive files.

## How It Works

1. User clicks "Sign in with Google"
2. Google handles authentication (email/password or existing session)
3. User grants permission to read their Drive files
4. App receives an access token to make API calls on their behalf
5. User can search and copy file contents to clipboard

## Setup Instructions

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click the project dropdown at the top → **New Project**
3. Enter a project name and click **Create**

### 2. Enable the Google Drive API

1. Go to **APIs & Services** → **Library**
2. Search for "Google Drive API"
3. Click on it and press **Enable**

### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External** (allows any Google user to sign in)
3. Fill in required fields:
   - App name
   - User support email
   - Developer contact email
4. Click **Save and Continue**
5. On Scopes page, click **Add or Remove Scopes**
   - Add: `https://www.googleapis.com/auth/drive.readonly`
6. Save and continue through the remaining steps

### 4. Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Choose **Web application**
4. Add **Authorized JavaScript origins**:
   - `http://localhost:3000` (for local development)
   - `https://your-app.vercel.app` (your production URL)
5. Click **Create**
6. Copy the **Client ID** (you won't need the client secret for browser apps)

### 5. Configure the App

For local development, create a `.env.local` file:

```
REACT_APP_GOOGLE_CLIENT_ID=your-client-id-here
```

For Vercel deployment:
1. Go to your project in the Vercel dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Add `REACT_APP_GOOGLE_CLIENT_ID` with your client ID
4. Redeploy the app

## Testing & Publishing Your App

By default, your app is in "testing" mode. Users will see an error like:
> "Access blocked: your-app.vercel.app has not completed the Google verification process"

You have two options:

### Option 1: Add Test Users (Quick Fix for Personal Use)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → your project
2. Navigate to **APIs & Services** → **OAuth consent screen**
3. Scroll down to **Test users** section
4. Click **Add Users**
5. Enter the Gmail addresses of people who should have access
6. Click **Save**

These users can now sign in. Good for personal tools or testing with a small group.

### Option 2: Publish the App (Allow Anyone)

1. Go to **APIs & Services** → **OAuth consent screen**
2. Click **Publish App**
3. Your app moves from "Testing" to "In production"
4. Any Google user can now sign in

Note: If you're using sensitive scopes, Google may require verification before publishing.

## Seeing Who Logged In

Since users authenticate with Google, you can see their identity by requesting additional scopes. The current setup uses `drive.readonly` only, but you could add:

- `email` - to see the user's email address
- `profile` - to see their name and profile picture

The access token can be used to call the Google OAuth userinfo endpoint:

```
GET https://www.googleapis.com/oauth2/v2/userinfo
Authorization: Bearer {access_token}
```

This returns the user's Google profile without requiring you to manage any user database.

