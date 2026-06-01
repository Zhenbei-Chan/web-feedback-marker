# GitHub Publishing Guide

## 1. Prepare Repository

Recommended repository settings:

- Repository name: `web-feedback-marker`
- Visibility: Public
- Description: `A local-first Chrome MV3 extension for webpage feedback annotation and PDF export.`
- License: MIT
- Default branch: `main`

Recommended topics:

- `chrome-extension`
- `manifest-v3`
- `annotation`
- `feedback`
- `pdf-export`
- `local-first`
- `privacy-first`

## 2. Files to Publish

Publish these files and directories:

- `assets/`
- `docs/`
- `src/`
- `.github/`
- `.gitignore`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `PRIVACY.md`
- `README.md`
- `SECURITY.md`
- `manifest.json`

Do not publish local private screenshots, temporary files, `.pem`, `.crx`, `.env`, or zip build outputs.

## 3. First Release

Suggested first public release:

- Tag: `v0.5.5`
- Title: `v0.5.5 - Local webpage feedback annotation MVP`

Suggested release notes:

```text
Initial public release of Web Feedback Marker.

Highlights:
- Chrome Manifest V3 extension.
- Text, region, and point feedback.
- Low-interruption in-page annotation markers.
- Local-only storage with chrome.storage.local.
- Local PDF export with screenshot evidence.
- No AI API, no cloud sync, no account system.
```

## 4. Release Zip

If you want to provide a downloadable zip for developer-mode installation:

1. Create a zip that contains the project files at the root level.
2. Exclude `.git/`, `.github/ISSUE_TEMPLATE/` is optional but safe to include.
3. Exclude `.pem`, `.crx`, `.env`, local screenshots, logs, and temporary files.
4. Users can unzip it and load the folder from `chrome://extensions/`.

## 5. Codex for Open Source Application

Before applying, make sure the GitHub repository has:

- Public visibility.
- Clear README.
- MIT license.
- Privacy policy.
- At least one GitHub release.
- Issues enabled.
- A short roadmap.
- Evidence that you are the maintainer.

Use `docs/CODEX_FOR_OSS_APPLICATION.md` as the application draft.

