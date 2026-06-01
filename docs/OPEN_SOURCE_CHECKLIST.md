# Open Source Checklist

## Before Publishing

- [x] Remove unrelated local scripts and notes.
- [x] Add MIT license.
- [x] Add privacy policy.
- [x] Add contribution guide.
- [x] Add security policy.
- [x] Add changelog.
- [x] Document Chrome developer-mode installation.
- [x] Document permissions and local-only data policy.
- [ ] Add product screenshots or a short demo GIF.
- [ ] Create a GitHub repository.
- [ ] Push the project to GitHub.
- [ ] Create the first GitHub release.

## Recommended Repository Settings

- Repository name: `web-feedback-marker`
- Description: `A local-first Chrome MV3 extension for webpage feedback annotation and PDF export.`
- Visibility: Public
- Topics:
  - `chrome-extension`
  - `manifest-v3`
  - `annotation`
  - `feedback`
  - `pdf-export`
  - `local-first`
  - `privacy-first`

## Release Package

For local installation, users can either clone the repository or download a release zip. The zip should include:

- `manifest.json`
- `src/`
- `assets/`
- `docs/`
- `README.md`
- `LICENSE`
- `PRIVACY.md`
- `CHANGELOG.md`

Do not include:

- `.git/`
- local screenshots with private content
- temporary test files
- `.pem`, `.crx`, `.env`
