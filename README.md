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
| `REFIT_RATIO` | `0.2` | 이 비율 이상 바뀌면 전체 재투영 |
| `CLIP_MODEL` / `CLIP_WEIGHTS` | `xlm-roberta-base-ViT-B-32` / `laion5b_s13b_b90k` | 다국어 CLIP |

CLIP 모델은 다국어판을 쓴다. 영어 전용 `ViT-B-32`는 "숲 사진"에 밤 사진을 1위로 올렸다.
다국어판은 약 1.7GB로 더 크고 인코딩도 느리지만, 한국어로 쓴 메모와 질의를 읽는다.
모델 이름은 벡터 메타데이터에 함께 저장되므로, 모델을 바꾸면 파일이 그대로여도
캐시가 무효화되고 전부 다시 임베딩된다 (두 공간이 섞이는 사고를 막는다).

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

## 원문 열기

인스펙터의 `file` 줄을 누르면 macOS `open`으로 원본이 기본 앱에서 열린다
(.ARW는 미리보기, PDF는 PDF 뷰어, .md는 텍스트 편집기).

엔드포인트는 **경로가 아니라 노드 id를 받는다.** 로컬 서버가 호출자가 준 경로를 셸
명령에 넘기면 디스크의 아무 파일이나 열 수 있게 된다. id로 그래프에서 파일을 찾고,
해석된 실제 경로가 라이브러리 루트 안인지 확인하므로 라이브러리 안의 심볼릭 링크나
`..`도 밖으로 나가지 못한다. POST 전용이라 다른 페이지의 `<img>`나 링크로는 유발되지
않고, 셸 없이 실행한다.

## 카드에서 고치기

인덱스 카드에서 제목, 날짜, 중요도(★ 1~5), 도메인(Art / Science / Philosophy), 태그를
바로 고칠 수 있다. 제목은 파일 이름과 무관하다 — 노드 id는 여전히 파일 이름이므로
제목을 바꿔도 `[[링크]]`는 끊기지 않는다.
고치면 `PATCH /api/v1/nodes/{id}`가 **원본 파일의 front matter에 먼저 쓰고**, 그 파일로부터
그래프를 다시 만든다 — 그래프가 디스크의 메모와 다른 말을 하는 경로를 만들지 않기 위해서다.
재인제스트는 증분이라 고친 파일만 다시 임베딩되고 나머지 노드는 자리를 지킨다.

남의 연구 노트에 쓰는 일이므로: 본문과 우리가 모르는 front matter 키는 보존하고,
임시 파일에 쓴 뒤 원본 위로 rename 하며(중간에 끊겨도 노트가 잘리지 않는다),
요청 본문은 카드가 실제로 제공하는 범위로만 검증한다.

이미지와 PDF는 front matter를 품을 수 없어서 파일 이름 전체를 딴 사이드카에 들어간다
(`plate.jpg.md`). 확장자를 뗀 이름(`plate.md`)으로 하면 이미지와 같은 id를 가진
두 번째 노드가 되어버린다.

태그는 임베딩되는 텍스트에도 들어간다 — 문서가 무엇에 관한 것인지의 일부이지
붙여둔 딱지가 아니다.

## 필터

타입·도메인·태그 세 줄, 그리고 Temporal 뷰의 타임라인. 넷은 서로를 덮어쓰지 않는다 —
노드의 가시성은 한 곳에서 네 조건을 모두 확인해 결정한다.

타입과 도메인은 전부 켠 상태에서 꺼가며 좁히고, 마지막 하나를 끄면 빈 화면 대신
전체가 돌아온다. **태그는 반대로 전부 꺼진 상태에서 시작한다** — 라이브러리의 태그는
화면에 다 들어가지 않을 만큼 많고, "모든 태그"는 필터를 안 건 것과 같기 때문이다.
많이 쓰인 순으로 14개까지 보여주고, 고른 태그는 순위에서 밀려나도 남는다(그러지 않으면
필터는 켜져 있는데 끌 방법이 없어진다). 여러 개를 고르면 그중 **하나라도** 달린 노드가 남는다.

## 타임라인

시간축은 라이브러리의 실제 날짜 범위에 맞춰 늘어난다. 고정 축은 모두가 최근 1~2년
안에 있을 때만 통했다 — 연구 아카이브에 흔한 1968년 사진집 한 권이 9,500단위 밖으로
날아가면서 나머지 은하가 점으로 찌그러졌다. Play 한 번에 걸리는 시간도 범위와 무관하게
20초 언저리로 맞춘다(1968~2026은 695개월이라 한 달씩 가면 5분이 걸린다).

Temporal 뷰를 켜면 스크러버가 같이 나온다. 특정 연월까지 수집된 노드만 남고,
Play를 누르면 라이브러리가 실제로 자란 순서대로 은하가 펼쳐진다. 새로 들어오는 노드는
0에서 제 크기로 자라고, 숨겨진 노드로 가는 엣지는 접힌다. 타입 필터와 타임라인은
서로를 덮어쓰지 않는다 — 가시성은 한 곳에서 두 조건을 합쳐 결정한다.

## API 계약

`GET /api/v1/nodes` → `{ "nodes": [...], "edges": [...] }`
`GET /api/v1/search?q=…&limit=8` → `{ "query": …, "results": [...], "images": [...] }`
`GET /media/<path>` → library 안의 원본 파일 (썸네일용, 읽기 전용)
`POST /api/v1/open/{node_id}` → 해당 노드의 원본을 macOS 기본 앱으로 연다 (로컬 전용)
`PATCH /api/v1/nodes/{node_id}` → `{importance?, domain?, tags?}`를 front matter에 쓰고
재인제스트 후 갱신된 노드를 돌려준다
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
- **Phase 5 — 완료.** 다국어 CLIP, 타입 필터, 라벨 겹침 해소, 라이트 모드.
- **Phase 6 — 완료.** 원문 열기, Temporal 타임라인 스크러버.
- **Phase 7 — 완료.** 인스펙터 메타데이터 편집과 front matter 라이트백, 도메인 필터.
- **다음 후보.** 스캔 PDF OCR, 제목·날짜 편집, 태그로 필터하기.

## 디자인

흰 배경(#FFFFFF) 기반의 미니멀 아카이브 톤. 3D 캔버스 배경도 같은 흰색이고,
노드 색은 흰 바탕에서 잉크처럼 읽히도록 채도를 낮춘 5색을 쓴다. UI 문구는 영문이 기본이다.

라벨은 서로 겹치지 않는다 — 가깝고 중요한 것이 화면 자리를 먼저 차지하고,
부딪히는 라벨은 비켜선다. 멀어질수록 흐려지다 사라진다.

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
