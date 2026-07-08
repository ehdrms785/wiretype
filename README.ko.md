# wiretype

> **The docs lie. The wire doesn't.** — 문서는 거짓말해도, 와이어는 하지 않는다.

실제 API 트래픽을 녹화해서 **TypeScript 타입 · zod 스키마 · MSW mock · OpenAPI 3.1 스펙**을 자동 생성합니다 — 백엔드가 *실제로* 반환하는 것으로부터.

[![CI](https://github.com/ehdrms785/wiretype/actions/workflows/ci.yml/badge.svg)](https://github.com/ehdrms785/wiretype/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wiretype)](https://www.npmjs.com/package/wiretype)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[English](./README.md) | 한국어

---

프론트엔드 팀이라면 다 겪어본 고통입니다: 문서에는 `avatarUrl: string`인데 실제로는 `null`이 옵니다. 스펙은 `role`이 자유 문자열이라지만 실제 값은 항상 셋 중 하나입니다. MSW mock 데이터는 몇 달 전에 실서버와 어긋났는데, 데모가 깨질 때까지 아무도 몰랐습니다.

wiretype은 진실의 원천 — 와이어에 실제로 흐른 바이트 — 로 갑니다. dev API 앞에 녹화 프록시를 세우거나 Vite 플러그인을 dev 서버에 꽂고, 평소처럼 앱을 쓰면 됩니다:

```
wiretype-generated/
  types.ts      엔드포인트별 TypeScript 타입 (params / query / request / response)
  schemas.ts    zod 스키마 + z.infer 타입
  handlers.ts   실제 캡처 응답이 mock 데이터인 MSW v2 핸들러
  openapi.json  OpenAPI 3.1 스펙
  model.json    관측 원본 모델 — `wiretype diff`(드리프트 감지)의 입력
```

![wiretype demo — 녹화, 생성, 드리프트 감지](https://raw.githubusercontent.com/ehdrms785/wiretype/main/docs/assets/demo.gif)

## 30초 체험

```bash
npx wiretype demo
```

설정도, 세팅도 필요 없고, 아무것도 외부로 나가지 않습니다. 로컬 데모 API를 띄우고,
프록시로 실제 트래픽을 녹화해 5종 산출물을 생성한 뒤 — "6개월 후" 백엔드가 조용히
바뀌고, `wiretype diff`가 모든 breaking 변경을 잡아냅니다. 전체 루프를 명령 하나로.

## 빠른 시작

```bash
npm i -D wiretype
```

**방법 A — 독립 프록시 (무엇과도 호환):**

```bash
# 1. API 앞에 녹화 프록시 세우기
npx wiretype record --target http://localhost:8080 --port 5050

# 2. 앱이 :5050을 보게 하고 평소처럼 클릭 — 모든 요청이 녹화됨

# 3. 4종 산출물 생성
npx wiretype gen

# 4. 대시보드에서 녹화본/추론 타입/생성 코드 탐색
npx wiretype ui
```

**방법 B — Vite 플러그인 (워크플로우 변화 제로):**

```ts
// vite.config.ts — 기존 server.proxy는 그대로 두세요; wiretype은 녹화 중일
// 때만 해당 prefix 앞에 끼어들고, 평소에는 아무것도 하지 않습니다
import wiretypeRecorder from 'wiretype/vite';

export default defineConfig({
  plugins: [
    wiretypeRecorder({
      target: 'http://localhost:8080',
      prefixes: ['/api'],
    }),
  ],
});
```

```bash
vite --mode record   # 녹화 켜짐; 그냥 `vite`면 플러그인은 아무것도 안 함
```

> **`--mode record` 주의**: Vite mode를 바꾸면 로드되는 `.env.*` 파일도
> 바뀝니다 (`.env.development` 대신 `.env.record`). 앱이 `.env.development`에
> 의존한다면 mode를 건드리지 않는 env 스위치를 쓰세요:
>
> ```bash
> WIRETYPE=1 vite                      # macOS / Linux
> npx cross-env WIRETYPE=1 vite       # 크로스 플랫폼
> ```

플러그인은 항상 꽂아둬도 됩니다 — dev 서버가 `record` 모드로 실행되거나
`WIRETYPE` env가 설정됐을 때만 녹화하고, `enabled` 옵션으로 강제 지정할 수도
있습니다. 평소처럼 개발하고 `npx wiretype gen`만 실행하면 됩니다 — 저장소에
recording이 하나뿐이면 플래그도 필요 없습니다. 녹화본은 `.wiretype/`에
쌓이는데, wiretype이 그 안에 `.gitignore`를 만들어두므로 캡처된 실데이터가
git에 들어갈 일은 없습니다.

생성된 핸들러를 MSW에 꽂는 건 늘 하던 세 줄입니다:

```ts
// src/mocks/browser.ts
import { setupWorker } from 'msw/browser';
import { handlers } from '../../wiretype-generated/handlers';

export const worker = setupWorker(...handlers);
```

mock 데이터를 핸들러 코드에서 분리하고 싶다면 `wiretype gen --msw-fixtures`:
각 바디를 `fixtures/<operationId>.<status>.json`으로 쓰고, `handlers.ts`는
그 파일들을 import하는 얇은 코드가 됩니다 — 재녹화해도 핸들러 코드는 절대
건드리지 않습니다. (JSON import에 tsconfig `resolveJsonModule: true`가 필요할
수 있습니다.)

## 무엇이 추론되나

엔드포인트별로 관측된 모든 샘플을 병합하므로, 많이 클릭할수록 정확해집니다:

| 감지 항목 | 예시 |
|---|---|
| optional 필드 | 일부 샘플에서 키 부재 → `avatarUrl?: string` |
| nullable | `lastLoginAt: string \| null` |
| enum (보수적) | 반복되는 토큰형 문자열만 → `role: "admin" \| "editor" \| "viewer"` |
| 문자열 포맷 | uuid, date-time, date, email, uri → `z.string().uuid()`, `.datetime()`, ... |
| 정수 vs 실수 | `z.number().int()` |
| URL 정규화 | `/api/users/42`, `/api/users/7` → `GET /api/users/:userId` |
| 상태코드별 응답 | 200과 404가 별도 타입으로 (`GetUserResponse`, `GetUserResponse404`) |
| 쿼리 파라미터 | `?page=2&limit=10` → `{ page: number; limit: number }` |

enum 감지는 의도적으로 보수적입니다: 토큰형 문자열(`admin`, `in_progress`)이 4개 이상 샘플에서 실제로 *반복*될 때만 리터럴 유니온이 됩니다 — id나 제목이 enum으로 굳는 사고를 방지합니다. 문자열로 직렬화된 숫자 데이터(`"30"`, `"5"`)가 하나라도 있으면 그 필드는 enum 대상에서 제외됩니다 — `"Bad" | "30" | "20"`은 어휘가 아니라 숫자 문자열 필드니까요. 반면 `"050015"`(leading zero)나 `"TEMPLATE_REPORT"` 같은 코드 체계는 enum 후보로 유지됩니다.

## CLI

```
wiretype demo    [--dir .wiretype] [--out wiretype-demo]
wiretype record  [--target <url>] [--port 5050] [--name session] [--dir .wiretype]
                 [--include <prefix...>] [--exclude <prefix...>]
wiretype gen     [--name <recording>] [--dir .wiretype] [--out wiretype-generated]
                 [--targets ts,zod,msw,openapi,model] [--msw-fixtures]
wiretype claims  --map claims.map.json [--out claims.json] [--tsconfig <file>] [--strict]
wiretype diff    <a> <b> | --claims <a> --observed <b>
                 [--dir .wiretype] [--json] [--md] [--lang en|ko]
                 [--fail-on breaking|risky|info] [--ignore-unmatched]
wiretype list    [--dir .wiretype]
wiretype ui      [--dir .wiretype] [--port 5099]
```

반복되는 플래그는 설정 파일 하나로 — 작업 디렉토리의 `wiretype.config.mjs`
(또는 `.js` / `.json`)를 모든 커맨드와 Vite 플러그인이 공유합니다 (명시적
플래그/옵션이 항상 우선):

```js
// wiretype.config.mjs
import { defineConfig } from 'wiretype';

export default defineConfig({
  target: 'http://localhost:8080',
  prefixes: ['/api'],
  dir: '.wiretype',
  name: 'dev',
});
```

설정 파일이 있으면 Vite 플러그인은 `wiretypeRecorder()` 한 줄이면 됩니다.

`wiretype ui`는 zero-dependency 다크 테마 대시보드를 서빙합니다: 엔드포인트별 추론 타입 트리, 요청/응답 원본 탐색, 생성 코드 4종 미리보기 + 복사 — 그리고 **Drift 탭**. 브라우저에서 결정론 diff를 바로 돌립니다: baseline(이전 recording 또는 `claims.json`/`model.json` 파일)을 고르면 어떤 엔드포인트가 어떻게 달라졌는지 심각도별로, 샘플 수 신뢰도 마커와 함께 보여줍니다. 일상의 두 질문 — *"API가 내 MSW mock에서 얼마나 벗어났나?"*, *"내 TS/zod 타입이 거짓말하고 있진 않나?"* — 를 브라우저 안에서 끝냅니다.

## 동작 원리

1. **녹화** — Node 내장 모듈만 쓰는 zero-dependency 리버스 프록시가 트래픽을 그대로 통과시키며 method/path/query/헤더(민감 헤더 redact)/JSON 바디를 캡처합니다. gzip/brotli 응답은 원본 그대로 전달하고 캡처용으로만 디코딩합니다.
2. **추론** — 경로를 패턴으로 정규화하고, 엔드포인트×상태코드별 JSON 바디를 shape AST로 병합합니다. 유니온·optional·nullable·포맷·enum이 병합 규칙에서 자연스럽게 도출됩니다.
3. **생성** — 같은 모델을 4개 이미터가 TypeScript/zod/MSW/OpenAPI로 렌더링합니다. 출력은 결정론적이고 `tsc --strict`로 컴파일됩니다.

## 스키마 드리프트 감지

한 번 녹화하면 타입이 나오고, *두 번* 녹화하면 계약 테스트가 됩니다.
`wiretype diff`는 두 관측 모델(또는 커밋된 베이스라인)을 비교해서 모든 변경에
심각도를 매깁니다:

```
$ wiretype diff v1 v2
wiretype diff — a: v1 (1 endpoints) vs b: v2 (2 endpoints)
  1 breaking, 2 risky, 3 info · 1 compared, 0 only-in-a, 1 only-in-b

BREAKING (1)
breaking | field-removed       | GET /api/items/:itemId | [200] name   | string → -

RISKY (2)
risky    | format-changed      | GET /api/items/:itemId | [200] sku    | string (uuid) → string
risky    | enum-values-changed | GET /api/items/:itemId | [200] status | "active" | "archived" → "active" | "archived" | "draft"
...
```

의미: `a`는 소비자가 믿고 있는 것(이전 녹화, 베이스라인, 소스 코드에서 추출한
claim), `b`는 관측된 현실 — **breaking**은 `a` 기준으로 짠 코드가 `b`에서
깨진다는 뜻입니다. CI 게이트로:

```bash
wiretype gen --targets model --out baseline-check
wiretype diff baseline/model.json baseline-check/model.json --fail-on breaking

# PR 코멘트용 Markdown 리포트, 한국어로:
wiretype diff baseline/model.json baseline-check/model.json --md --lang ko
```

`--md`는 요약 + 심각도별 표로 구성된 Markdown 리포트를 출력하고, `--lang`은
제목/헤딩/라벨만 현지화합니다 — 엔드포인트, 경로, `before → after` 타입 같은
기계 필드는 번역하지 않습니다. `--json` 출력은 항상 영어 원본입니다.

전체 판정 규칙(nullable화, optional화, enum 확장, 포맷 소실, 상태코드 변화 등)은
결정론적이며 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)에 문서화되어 있습니다.

모든 finding에는 그것을 뒷받침하는 관측 샘플 수(`샘플 수(b)` 컬럼)가 붙습니다.
샘플 3개 미만이면 ⚠로 표시됩니다 — 얕은 추론을 사실처럼 내밀지 않고,
"와이어가 아직 충분히 말하지 않았다"고 wiretype이 먼저 알려줍니다.

## 코드를 와이어에 감사받기 — `wiretype claims`

드리프트 엔진은 **직접 작성한 타입**도 판정할 수 있습니다. 코드가 쓰는
export 타입을 claims map으로 가리키면, TypeScript 컴파일러가 그것을 claims
모델로 번역합니다 — 결정론적으로, 추측 없이:

```json
// claims.map.json
{
  "entries": [
    { "method": "GET", "pattern": "/api/users/:userId",
      "response": "src/apis/user/types.ts#UserDetail" }
  ]
}
```

```bash
npx wiretype claims --map claims.map.json --out claims.json
npx wiretype diff --claims claims.json --observed dev-session --ignore-unmatched
```

이제 `breaking`의 의미는 이렇습니다: **이 인터페이스는 실제 API에 대해
거짓말을 하고 있다.** 컴파일러가 충실하게 번역할 수 없는 것(미해결 제네릭,
`Date`, 함수, 재귀 타입)은 거부되어 not-auditable로 기록됩니다 — 조용히
추측하는 일은 없습니다. 제네릭 래퍼는 한 줄짜리 export shim으로 claim합니다:
`export type GetUserClaim = ApiResponse<UserDetail>`.

생성된 `types.ts`/`handlers.ts`는 검증·mock용 산출물입니다 — wiretype은
`GetApiUsersByUserIdResponse` 같은 생성 이름을 앱 코드에 쓰라고 요구하는
대신, *당신의* 타입을 감사하고 고칩니다.

## Claude 에이전트 플러그인

레포에 Claude Code / Cowork 플러그인([`claude-plugin/`](./claude-plugin))이
포함되어 있습니다. **api-drift-audit** 스킬은: 에이전트가 API 콜사이트를 찾아
그 타입들을 claims map으로 가리키고, `wiretype claims`가 TypeScript 컴파일러로
번역하며, 판정은 `wiretype diff`가 내립니다 — 그리고 breaking/risky 발견을
file:line에 매핑해서 타입 수정, MSW mock 갱신, zod 가드 추가까지 제안합니다.
에이전트는 탐색과 설명만; 번역과 판정은 둘 다 결정론입니다.

```bash
claude plugin marketplace add ehdrms785/wiretype
claude plugin install wiretype
```

스킬은 자연어로 발동하고("src/apis 실서버랑 타입 맞는지 감사해줘",
"MSW mock 실서버 응답으로 갱신해줘"), 슬래시 커맨드로도 명시적으로 부를 수 있습니다:

- `/wiretype-audit [폴더]` — 코드 타입/zod/mock을 실 트래픽과 대조 감사
- `/wiretype-msw` — MSW mock 데이터를 최신 녹화 응답과 리컨실

## 기존 도구와의 차이

- **openapi-typescript / orval** — *정확한* 스펙이 있어야 동작합니다. wiretype은 스펙이 아예 필요 없고, 오히려 스펙을 도출해줍니다 (문서와 실제 API가 어긋난 지점도 잡아냅니다).
- **quicktype** — JSON 샘플 1개를 타이핑합니다. wiretype은 엔드포인트별 *여러* 샘플을 병합하고(optional/nullable/enum이 여기서 나옵니다) HTTP를 이해합니다: 라우트, params, query, 상태코드.
- **HAR 기반 생성기** — HAR 내보내기는 일회성 수동 작업입니다. wiretype은 개발하는 동안 계속 녹화하고 명령 하나로 재생성합니다.

## 한계

- 추론은 관측 기반입니다. 본 적 없는 필드는 타입에 없습니다 — 많이 쓸수록 정확해집니다.
- REST/JSON 전용 — GraphQL 미지원.
- WebSocket은 녹화 없이 통과.
- 1MiB 초과 바디는 잘라서 저장하고 JSON 파싱 생략.

## 라이선스

[MIT](./LICENSE) © [daro](https://github.com/ehdrms785)
