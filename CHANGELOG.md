# Changelog

## 0.1.3

- Read search candidates from `documents.json`, the index Sourcey 3.7.1 and
  later publish for agents, and each match from its own Markdown. Sourcey 3.8
  stopped writing `search-index.json`, so Retrieve Context and Search failed on
  every site built since; a site built before 3.7.1 still works through its
  `search-index.json`.
- Each operation and schema on a single-page API reference is a result of its
  own, with its method and path, and `llms-full.txt` is read only for a match
  without Markdown.
- A query word a title extends counts towards it, so "deploy" finds
  "Deploying".
- Lint runs again: ESLint goes back to 9, which n8n's lint rules need, and the
  retrieval helpers throw their own errors outside catch blocks, as n8n's
  rules ask.

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
