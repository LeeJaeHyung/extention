# chibiz extention — 익스텐션 · 입금 에이전트

| 폴더 | 무엇 | 설치 PC |
|---|---|---|
| `chibiz-worldpay-extension/` | 1688 월드페이·외상 자동결제 크롬 익스텐션 0.7.0 | 결제 PC |
| `chibiz-deposit-collector-ext/` | 하나은행 빠른조회 입금 수집 크롬 익스텐션 0.1.0 | 수집 PC |
| `chibiz-deposit-agent/` | 입금 에이전트 (Java 17 · JavaFX 창 · 로컬 MySQL · 사이트 신청 큐 대조) | 수집 PC |

서버 쪽 규격: OP-chibiz `docs/deposit-claim-agent-spec.md`.

## 수집 PC (윈도우 10) 처음 설정

1. **JDK 17 이상** 설치 (예: Microsoft Build of OpenJDK 17/21, `java -version` 확인). Maven 은 필요 없음(`mvnw` 가 받음).
2. **MySQL** 설치, root 비밀번호 `1234567`(아래 config 와 같게). DB `chibiz_bank` 는 에이전트가 만듭니다.
3. 저장소 받기
   ```
   git clone https://github.com/LeeJaeHyung/extention.git C:\chibiz\extention
   ```
4. 에이전트 설정: `chibiz-deposit-agent\config.example.json` 을 복사해 `config.json` 으로 만들고 DB 비밀번호·사이트 키를 넣음 (config.json 은 git 에 올라가지 않음)
5. 빌드: `chibiz-deposit-agent\build.bat` 더블클릭 → `target\chibiz-deposit-agent.jar`
6. 실행: `chibiz-deposit-agent\start.bat` 더블클릭 → 창이 뜨고 상단에 `DB 연결됨 · HTTP 127.0.0.1:18080` 이 초록이면 됨
   - 시작프로그램 등록: `Win+R` → `shell:startup` 에 `start.bat` 바로가기
7. 크롬 `chrome://extensions` → 개발자 모드 → 압축해제된 확장 프로그램 로드 → `chibiz-deposit-collector-ext` 폴더
8. 하나은행 빠른조회 https://www.kebhana.com/flex/quick/quickService.do?subMenu=1 에서 계좌번호·비밀번호·사업자번호 입력 → 조회 → 오른쪽 아래 패널 **[실행]**

## 갱신
```
cd C:\chibiz\extention
git pull
chibiz-deposit-agent\build.bat     (에이전트가 바뀐 경우)
```
익스텐션이 바뀐 경우는 `chrome://extensions` 에서 새로고침(↻).

## 에이전트 창
- 상단 상태 칩: DB · HTTP · 대조(사이트 키 설정 여부)
- 타일: 오늘 입금 건수·금액, 마지막 수집 성공, 연속 실패, 신청 큐(대기·매칭), 마지막 폴링
- 탭: 입금 내역 · 실행 기록(10~15분 회차마다 성공/실패) · 신청 큐 · 매칭·콜백 · 로그
- 버튼: **새로고침**, **지금 대조**(폴링→대조→콜백 1회)
- 창을 닫으면 수집·대조가 멈춥니다(확인 창). 30일 연속 수집 시험 중에는 닫지 말고 절전만 끄세요.
- 확인용 주소: `http://127.0.0.1:18080/summary`, `/matches`, `/claims?status=PENDING`

## 동작 요약
```
크롬(빠른조회 탭) ─ 수집 익스텐션: 10~15분 임의 주기 · 어제~오늘 · 입금내역 · 응답 뒤 5초 · 페이지 끝까지
      └─ HTTP → 에이전트: bank_deposit(중복 제거) · collect_run
에이전트 ─ 1분: 사이트별 GET /deposit/claims/agent/pending → deposit_claim 병합
         ─ 10분(+새 입금 직후): 미승인 입금 × 대기 신청 전체 비교(이름 정규화 완전 일치 · 금액 ±오차 · 입금 ≥ 신청−3일)
         ─ 콜백 POST /deposit/claims/agent/{id}/matched (200/409 끝 · 그 외 재시도)
```

## MCP — 다른 PC 의 Claude 로 입금·승인 내역 조사

에이전트는 MCP 서버(Streamable HTTP, 읽기 전용 + 대조 1회)를 같이 띄웁니다. 사무실 다른 PC 의 Claude Code 에서:
```
claude mcp add --transport http chibiz-deposit http://<수집PC-IP>:18081/mcp --header "Authorization: Bearer <config.json 의 mcp.token>"
```
- 수집 PC 윈도우 방화벽에서 TCP 18081 인바운드 허용(사내망만). 토큰은 `config.json` 의 `mcp.token`(길고 임의로). 비우면 MCP 가 켜지지 않음.
- 도구: `summary` · `list_deposits`(기간·입금자명·금액·승인 여부) · `list_runs`(실패만) · `list_claims`(상태·사이트) · `list_matches` · `find_candidates`(신청이 왜 안 맞았는지 후보·탈락 사유) · `match_now`
- 예: "어제 들어온 미매칭 입금 보여줘", "CHIBIZ 신청 123 이 왜 안 맞았는지 봐줘", "수집이 언제부터 실패했어?"
