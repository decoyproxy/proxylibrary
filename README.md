# proxylibrary.com

decoyproxy의 로컬 3D 지식 엔진. 연구 자료(.md/.pdf/.json/.jpg/.png)를 로컬에서 읽어
3개 뷰(Semantic / Ontological / Temporal)의 3D 좌표로 만들고 WebGL 갤럭시로 렌더링한다.

유료 API를 쓰지 않는다. 임베딩·파싱·벡터 계산은 전부 로컬(Apple Silicon MPS)에서 돈다.

## 실행

터미널 두 개.

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --reload --port 8000
```

```bash
cd frontend && npm install && npm run dev
```

→ http://localhost:5173

## 내 자료 넣기

`backend/data/library/` 아래에 타입별 폴더를 두고 마크다운을 넣는다.
(다른 폴더를 쓰려면 `LIBRARY_DIR=/path/to/내리서치폴더`.)

```
library/Concepts/CON_NONHUMAN.md
```
```markdown
---
title: Non-human perception
importance: 5
domain: Philosophy
date: 2025-08-14
---

- [[PRJ_UMWELT]]
```

파일 이름(확장자 제외)이 노드 id다. 본문의 `[[id]]`가 엣지가 되고, 엣지 타입은
가리키는 대상에서 결정된다 (→Project = ASSEMBLE, →Concept = RESEARCH, 그 외 SPARK).

그 다음:

```bash
cd backend && .venv/bin/python ingest.py
```

임베딩 → ChromaDB 저장 → UMAP 3D 투영까지 로컬에서 돌고 `data/graph.json`을 새로 쓴다.
첫 실행은 모델(약 1GB)을 받느라 느리다.

## 구조

```
backend/
  app.py      FastAPI. 지금은 /api/v1/nodes 하나뿐.
  store.py    그래프 로드 + 스키마 검증.
  coords.py   3개 뷰의 좌표 규칙. seed와 ingest가 공유한다.
  ingest.py   실제 파일 → 임베딩 → ChromaDB → UMAP → graph.json.
  seed.py     시드 코퍼스. graph.json(더미 좌표) + library/*.md를 같이 찍어낸다.
frontend/
  src/galaxy.js  Three.js 씬, 뷰 전환 보간, 노드 피킹.
  src/main.js    데이터 fetch, HUD, 인스펙터.
```

## 검색

HUD 검색창에 뜻을 적으면 된다. 제목 매칭이 아니라 ingest가 저장해둔 벡터를 질의하는
의미 검색이라, "동물이 지각하는 세계"로 검색하면 영어 문서인 *A Foray into the Worlds of
Animals and Humans*가 잡힌다. 결과는 갤럭시에서 밝게 남고 나머지는 흐려진다. Esc로 해제.

첫 검색은 임베딩 모델을 올리느라 몇 초 걸리고, 그 뒤로는 즉시 나온다.

## API 계약

`GET /api/v1/nodes` → `{ "nodes": [...], "edges": [...] }`
`GET /api/v1/search?q=…&limit=8` → `{ "query": …, "results": [{id, title, type, score}] }`
(인덱스가 없으면 503 — `ingest.py`를 먼저 돌려라.)

노드는 반드시 `coordinates.semantic / .ontological / .temporal` 3종을 모두 갖는다
(`store.load()`가 검증하고, 빠지면 서버가 500으로 죽는다). 스키마 전체는
[CLAUDE.md](CLAUDE.md) 참고.

## 로드맵

- **Phase 1 — 완료.** 시드 데이터 + API + 3D 갤럭시 + 뷰 전환 + 인스펙터.
- **Phase 2 — 완료.** 마크다운 인제스트, 로컬 임베딩, ChromaDB, UMAP 3D 투영.
- **Phase 2.5 — 완료.** ChromaDB 의미 검색 + HUD 검색창, 결과 하이라이트.
- **Phase 3 — 멀티포맷.** PyMuPDF(PDF 텍스트), OpenCLIP(이미지), Watchdog(폴더 감시 자동 재인덱싱).

### 스펙에서 벗어난 것 하나

CLAUDE.md는 임베딩 모델로 `nomic-embed-text`를 지정하지만, v1.5의 remote code가
`transformers` 5.x에서 깨진다(`get_extended_attention_mask` 없음). transformers를
과거 버전에 핀으로 묶으면 기여자 전원이 그 핀에 갇히므로 `intfloat/multilingual-e5-base`로
갔다 — remote code가 필요 없고, 한국어 노트에 더 잘 맞는다.
`EMBED_MODEL` 환경변수로 언제든 되돌릴 수 있다.

## 지금 잡을 만한 일 (기여 환영)

- 타입/도메인 필터 (HUD 체크박스로 노드 숨기기)
- 엣지 타입별 표시 토글
- 라벨 겹침 완화 (거리 기반 페이드)
- Phase 2 인제스트 파이프라인

## 규칙

- 유료 API 호출 금지 (백엔드 코드에 OpenAI/Anthropic 키 들어가면 리젝).
- `main`에 직접 푸시 금지. PR로.
- 의존성 추가는 PR 설명에 이유 한 줄. 몇 줄로 되는 건 그냥 직접 짠다.
