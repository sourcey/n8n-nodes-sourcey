# Changelog

## 0.1.2

- Re-published the Sourcey n8n node through GitHub Actions for npm provenance.

## 0.1.1

- Fixed Fetch Page hydration for normalized Sourcey search paths by falling
  back to `.html` and trailing-slash page URLs when `llms-full.txt` is absent.

## 0.1.0

- Initial Sourcey community node with Retrieve Context, Search, Fetch Page, and
  Load All operations.
- Added dependency-free Sourcey retrieval helpers for `search-index.json`,
  `llms-full.txt`, `sitemap.xml`, and HTML fallback hydration.
- Added importable workflow templates for docs chat, vector ingestion, support
  routing, and docs-build orchestration.
