# Telegram 미니앱 홀덤 (Director Build)

운영 중에 놓치기 쉬운 실전 필수 요소까지 반영한 텍사스 홀덤 미니앱입니다.

## 반영된 핵심 업그레이드
- 블라인드/딜러 버튼 로테이션 + 헤즈업(2인) 규칙
- 베팅/콜/레이즈/올인/폴드
- 사이드팟 분배 + 버튼 기준 나머지칩 처리
- 턴 타임아웃 자동 폴드 + 턴 레이스 방지 토큰
- 액션 중복 제출 방지(`actionSeq`)
- 관전자 모드 + 착석(`sit_in`)
- 룸 잠금 옵션(신규는 관전)
- 결과 후 자동 다음 핸드 카운트다운
- 표준 에러코드/메시지
- 카드백 테마 선택 + 카드 UI 개선

## 다른 컴퓨터에서 실행
1. 저장소 클론
```bash
git clone <REPO_URL>
cd <REPO_DIR>
```

2. 의존성 설치
```bash
npm install
```

3. 실행
```bash
npm start
```

4. 접속
- `http://localhost:3000`

## 주요 소켓 이벤트
- `join_room { roomId?, name }`
- `sit_in { roomId }`
- `rebuy { roomId }`
- `start_hand { roomId }`
- `add_bot { roomId }`
- `action { roomId, action, actionSeq }`
- `update_settings { roomId, settings: { locked, autoStart, rebuyAmount } }`

## 다음 단계(원하면 바로 진행)
- Telegram `initData` 서버 검증(HMAC)
- 영속 저장(전적/핸드 히스토리)
- 재접속 시 동일 좌석 복귀
