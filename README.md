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

`backend/data/library/` 아래에 타입별 폴더를 두고 자료를 넣는다.
`.md` `.txt` `.json` `.pdf` `.jpg` `.png`를 읽는다.
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

두 번째 실행부터는 **바뀐 파일만** 다시 계산한다. 파일의 mtime과 크기를 벡터 메타데이터에
같이 저장해두고, 그대로면 지난번 벡터를 재사용한다 (별도 캐시 파일 없음).

바뀐 노드는 임베딩 공간에서 가장 가까운 이웃 옆에 놓이고 **나머지는 한 픽셀도 움직이지
않는다**. UMAP 전체 재투영은 모든 노드를 옮기기 때문이다 — 실제로 입력이 1e-6만 달라져도
(벡터 저장소를 거치며 생기는 float32 오차면 충분하다) 레이아웃이 통째로 뒤집힌다.
그래서 전체 재투영은 (a) 처음이거나 (b) 라이브러리의 `REFIT_RATIO`(기본 20%) 이상이
바뀌었거나 (c) 직접 시킬 때만 돈다.

```bash
.venv/bin/python ingest.py --refit   # 전체 재투영
```

손으로 돌리기 싫으면 감시 프로세스를 띄운다. 파일을 저장하고 3초 조용하면 알아서 재인제스트한다.

```bash
cd backend && .venv/bin/python watch.py
```

**PDF**는 PyMuPDF로 앞 20쪽 텍스트를 뽑아 다른 문서와 똑같이 임베딩한다
(스캔본은 텍스트가 없어 비어서 들어간다 — OCR은 아직 없다).

**이미지**는 CLIP 이미지 인코더로, 문서는 CLIP 텍스트 인코더로 한 번 더 임베딩된다.
두 벡터(텍스트 모델 + CLIP)를 정규화해 가중 결합한 joint space에서 UMAP을 돌리므로,
사진은 비슷하게 생긴 사진 곁에, 그리고 결이 맞는 글 곁에 놓인다. 텍스트끼리의 거리는
여전히 텍스트 모델이 결정한다 — CLIP 텍스트 인코더는 77토큰에서 잘려 긴 글에 약하다.

CLIP은 이미지와 텍스트가 서로 다른 원뿔에 몰리는 modality gap이 있어서(아무 이미지나
다른 이미지와 0.9, 자기를 설명하는 글과는 0.2), 그대로 쓰면 사진이 통째로 섬이 된다.
그래서 각 모달리티를 자기 평균으로 센터링한 뒤 결합한다.

조절 손잡이:

| 환경변수 | 기본 | 뜻 |
|---|---|---|
| `CLIP_MIX` | `0.4` | joint space에서 CLIP의 지분. 0이면 텍스트만, 1이면 시각만 |
| `UMAP_NEIGHBORS` | 코퍼스/4 (4~15) | 작을수록 국소 군집이 살아난다 |

검색은 CLIP 원본 벡터를 별도 컬렉션에 두고 따로 질의해서 "dark night sky with stars"
같은 말로 사진을 찾는다. 두 점수는 척도가 다르므로 결과 목록에서 분리해 보여준다.

## 구조

```
backend/
  app.py      FastAPI. 지금은 /api/v1/nodes 하나뿐.
  store.py    그래프 로드 + 스키마 검증.
  coords.py   3개 뷰의 좌표 규칙. seed와 ingest가 공유한다.
  ingest.py   실제 파일 → 임베딩 → ChromaDB → UMAP → graph.json.
  seed.py     시드 코퍼스. graph.json(더미 좌표) + library/*.md를 같이 찍어낸다.
  watch.py    library 감시 → 조용해지면 재인제스트. 별도 프로세스.
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
`GET /api/v1/search?q=…&limit=8` → `{ "query": …, "results": [...], "images": [...] }`
`GET /media/<path>` → library 안의 원본 파일 (썸네일용, 읽기 전용)
(인덱스가 없으면 503 — `ingest.py`를 먼저 돌려라.)

노드는 반드시 `coordinates.semantic / .ontological / .temporal` 3종을 모두 갖는다
(`store.load()`가 검증하고, 빠지면 서버가 500으로 죽는다). 스키마 전체는
[CLAUDE.md](CLAUDE.md) 참고.

## 로드맵

- **Phase 1 — 완료.** 시드 데이터 + API + 3D 갤럭시 + 뷰 전환 + 인스펙터.
- **Phase 2 — 완료.** 마크다운 인제스트, 로컬 임베딩, ChromaDB, UMAP 3D 투영.
- **Phase 2.5 — 완료.** ChromaDB 의미 검색 + HUD 검색창, 결과 하이라이트.
- **Phase 3 — 완료.** PDF 텍스트(PyMuPDF), 이미지 CLIP 인덱스, Watchdog 자동 재인제스트.
- **Phase 4 — 완료.** 갤럭시 3D 썸네일, joint space 시각 군집, 증분 인제스트.
- **다음 후보.** 스캔 PDF OCR, 다국어 CLIP(지금 이미지 검색은 영어 질의만 제대로 된다),
  타입 필터(#2), 라벨 겹침(#3).

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
