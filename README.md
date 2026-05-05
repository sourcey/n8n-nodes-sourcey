# n8n-nodes-sourcey

Use Sourcey-generated documentation inside n8n workflows.

This community node reads the public artefacts emitted by a Sourcey static
docs site:

- `search-index.json` for search candidates
- `llms-full.txt` for full-page hydration
- `sitemap.xml` for ingestion

It does not need credentials for public docs and does not run `sourcey build`
inside n8n.

## Installation

Install `n8n-nodes-sourcey` from the n8n community nodes panel, or install it
manually in a self-hosted n8n instance.

## Operations

### Retrieve Context

Returns one item with:

- `context`: packed documentation context ready for an AI Agent prompt
- `citations`: source URLs and titles
- `documents`: hydrated source documents
- `confidence`: `none`, `low`, `medium`, or `high`
- `status`: `ok`, `weak_results`, or `no_results`

Use this for Chat Trigger -> Sourcey -> AI Agent -> Respond workflows.

### Search

Returns one item per ranked result from `search-index.json`. Each item includes
title, URL, excerpt, tab, category, score, and metadata.

Use this for branching, result selection, and support routing.

### Fetch Page

Fetches one page by path or URL. It prefers `llms-full.txt` and falls back to
HTML text extraction when the LLM artefact is missing.

### Load All

Returns one item per page or chunk for ingestion workflows. Use this with
embeddings and vector-store nodes.

## Docs Building

Build docs in CI, then use this node against the deployed site.

The recommended workflow is:

1. n8n receives a GitHub webhook, schedule, release event, or manual trigger.
2. n8n dispatches a GitHub Actions workflow using `sourcey/build-docs`.
3. GitHub Actions builds and deploys the static Sourcey site.
4. n8n waits for the deployment URL.
5. n8n runs Sourcey Retrieve Context, Search, Fetch Page, or Load All.

This keeps build work in CI and keeps the n8n node fast, dependency-free, and
verification-friendly.

## Example Workflows

Import the JSON files in `workflows/`:

- `ask-docs-chatbot.json`
- `vector-store-ingestion.json`
- `support-question-router.json`
- `build-and-index-sourcey-docs.json`

The workflows avoid Code and Function nodes. If an example needs custom
JavaScript glue, the Sourcey node API should be improved instead.

## Credentials

None in Phase 1. The node consumes public Sourcey docs sites.

## Compatibility

This package is generated from the official `n8n-node` scaffold and uses the
programmatic node style. It keeps runtime dependencies empty for verified
community-node eligibility.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run a local n8n instance with the node loaded:

```bash
npm run dev
```

## Resources

- [Sourcey](https://sourcey.com)
- [Sourcey on GitHub](https://github.com/sourcey/sourcey)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
