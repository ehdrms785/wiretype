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
```

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
// vite.config.ts — 해당 prefix의 server.proxy 항목을 대체
import wiretypeRecorder from 'wiretype/vite';

export default defineConfig({
  plugins: [
    wiretypeRecorder({
      target: 'http://localhost:8080',
      prefixes: ['/api'],
      enabled: !!process.env.WIRETYPE,   // opt-in: WIRETYPE=1 npm run dev
    }),
  ],
});
```

평소처럼 개발하고 `npx wiretype gen`만 실행하면, MSW 핸들러가 실서버와 일치함이 보장됩니다.

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

enum 감지는 의도적으로 보수적입니다: 토큰형 문자열(`admin`, `in_progress`)이 4개 이상 샘플에서 실제로 *반복*될 때만 리터럴 유니온이 됩니다 — id나 제목이 enum으로 굳는 사고를 방지합니다.

## CLI

```
wiretype record  --target <url> [--port 5050] [--name session] [--dir .wiretype]
                 [--include <prefix...>] [--exclude <prefix...>]
wiretype gen     [--name session] [--dir .wiretype] [--out wiretype-generated]
                 [--targets ts,zod,msw,openapi]
wiretype list    [--dir .wiretype]
wiretype ui      [--dir .wiretype] [--port 5099]
```

`wiretype ui`는 zero-dependency 다크 테마 대시보드를 서빙합니다: 엔드포인트별 추론 타입 트리, 요청/응답 원본 탐색, 생성 코드 4종 미리보기 + 복사.

## 동작 원리

1. **녹화** — Node 내장 모듈만 쓰는 zero-dependency 리버스 프록시가 트래픽을 그대로 통과시키며 method/path/query/헤더(민감 헤더 redact)/JSON 바디를 캡처합니다. gzip/brotli 응답은 원본 그대로 전달하고 캡처용으로만 디코딩합니다.
2. **추론** — 경로를 패턴으로 정규화하고, 엔드포인트×상태코드별 JSON 바디를 shape AST로 병합합니다. 유니온·optional·nullable·포맷·enum이 병합 규칙에서 자연스럽게 도출됩니다.
3. **생성** — 같은 모델을 4개 이미터가 TypeScript/zod/MSW/OpenAPI로 렌더링합니다. 출력은 결정론적이고 `tsc --strict`로 컴파일됩니다.

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
