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

## 구조

```
backend/
  app.py      FastAPI. 지금은 /api/v1/nodes 하나뿐.
  store.py    그래프 로드 + 스키마 검증. Phase 2에서 ChromaDB로 교체.
  seed.py     data/graph.json 생성기 (결정론적 더미 좌표).
frontend/
  src/galaxy.js  Three.js 씬, 뷰 전환 보간, 노드 피킹.
  src/main.js    데이터 fetch, HUD, 인스펙터.
```

## API 계약

`GET /api/v1/nodes` → `{ "nodes": [...], "edges": [...] }`

노드는 반드시 `coordinates.semantic / .ontological / .temporal` 3종을 모두 갖는다
(`store.load()`가 검증하고, 빠지면 서버가 500으로 죽는다). 스키마 전체는
[CLAUDE.md](CLAUDE.md) 참고.

## 로드맵

- **Phase 1 — 완료.** 시드 데이터 + API + 3D 갤럭시 + 뷰 전환 + 인스펙터.
- **Phase 2 — 인제스트.** `sentence-transformers` 임베딩 → ChromaDB 저장 → UMAP 3D 투영으로
  semantic 좌표를 실제 계산. Python 3.12 필요(현재 시스템은 3.9).
- **Phase 3 — 멀티포맷.** PyMuPDF(PDF 텍스트), OpenCLIP(이미지), Watchdog(폴더 감시 자동 재인덱싱).

## 지금 잡을 만한 일 (기여 환영)

- 타입/도메인 필터 (HUD 체크박스로 노드 숨기기)
- 검색창 — 제목 검색 후 해당 노드로 카메라 이동
- 엣지 타입별 표시 토글
- 라벨 겹침 완화 (거리 기반 페이드)
- Phase 2 인제스트 파이프라인

## 규칙

- 유료 API 호출 금지 (백엔드 코드에 OpenAI/Anthropic 키 들어가면 리젝).
- `main`에 직접 푸시 금지. PR로.
- 의존성 추가는 PR 설명에 이유 한 줄. 몇 줄로 되는 건 그냥 직접 짠다.
