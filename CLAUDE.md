# CLAUDE.md - Instructions for proxylibrary.com Development

## Project Overview
`proxylibrary.com` is a zero-cost local 3D knowledge engine and research archive for artist decoyproxy. 
It ingests multi-format research assets (.md, .pdf, .json, .jpg, .png) locally, computes 3D spatial coordinates across 3 view modes (Semantic, Ontological, Temporal), and renders them in a WebGL (Three.js) galaxy interface.

---

## Core Operational Rules
1. **Zero-SaaS Cost**: Do NOT use paid APIs (OpenAI, Anthropic API) in backend code. All embeddings, parsing, and vector calculations MUST run locally using Apple Silicon (MPS) accelerated open-source models.
2. **GitHub Repository Rules**: READ-ONLY for automatic deployments. Code changes must be reviewed via local commits or PRs.
3. **Mac Finder First**: Local files and markdown paths are the source of truth.

---

## Technical Stack
- **Backend**: Python 3.10+, FastAPI, ChromaDB (Local Embedded), OpenCLIP (`ViT-B-32`), Sentence-Transformers (`nomic-embed-text`), UMAP-learn, PyMuPDF, Watchdog.
- **Frontend**: Vite, JavaScript (ES6+), Three.js / `three-forcegraph`, CSS2D Object Renderer, HTML5 Drag & Drop.

---

## Data Schema & Entities

### 1. Node Types
- `Project`: Core anchor projects (e.g., UMWELT).
- `Concept`: Theoretical & aesthetic pillars (e.g., Non-human perception, Materiality of photography).
- `Source`: External research (Papers, URLs, Photobook references).
- `Fragment`: Internal raw thoughts (Notes, KakaoTalk dumps, AI chat logs).
- `Asset`: Production media (RAW photos, code scripts, video clips).

### 2. Edge Types (Connections)
- `[SPARK]`: Source ➔ Fragment (Triggered inspiration)
- `[RESEARCH]`: AI/Google ➔ Concept (Theoretical backing)
- `[ASSEMBLE]`: Nodes ➔ Project (Composition in workspace)

### 3. Coordinate Object Schema
Every node returned by `/api/v1/nodes` MUST include 3 coordinate sets:
```json
{
  "id": "SRC_2026_001",
  "title": "Non-Human Perception Paper",
  "type": "Source",
  "importance": 5,
  "domain": "Science",
  "coordinates": {
    "semantic": {"x": 12.4, "y": -4.2, "z": 81.0},
    "ontological": {"x": -50.0, "y": 80.0, "z": 100.0},
    "temporal": {"x": 3.1, "y": 15.2, "z": 240.5}
  }
}
