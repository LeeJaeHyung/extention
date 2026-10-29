/*
 * 차이비즈 입금 수집 익스텐션 — 설정 한 곳 (2026-10-29 · 월드페이 자동 결제 익스텐션과는 별도)
 *
 * 하나은행 빠른조회 화면에서 관리자가 계좌번호·비밀번호·사업자번호를 넣고 조회한 뒤 [실행]을 누르면,
 * 이 설정대로 재조회해 표를 읽고 같은 PC 의 입금 에이전트(hana-deposit-agent)에 넘깁니다. 비밀번호는 다루지 않습니다.
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ChibizDepositConfig = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'
  return Object.freeze({
    BANK: Object.freeze({
      /** 같은 PC 의 입금 에이전트. 포트를 바꾸면 manifest.json 의 host_permissions 도 같이 */
      agentUrl: 'http://127.0.0.1:18080',
      /** 재조회 간격 — 매 회차 10~15분 사이 임의 값 · 조회기간은 어제~오늘 */
      intervalMinMs: 10 * 60 * 1000,
      intervalMaxMs: 15 * 60 * 1000,
      /** 조회 함수 호출 뒤 표가 다시 그려질 때까지 기다리는 한도 */
      requeryTimeoutMs: 30 * 1000,
      /** 응답이 돌아온 뒤 표를 읽기 전에 쉬는 시간(5초) */
      settleMs: 5 * 1000,
      /** 연속 실패가 이만큼이면 자동 중지 · 0 = 멈추지 않고 계속 시도(30일 연속 수집 시험용 · 실패도 collect_run 에 남음) */
      stopAfterFails: 0,
      /** 한 회차에 넘겨 보는 최대 페이지 수(60건/페이지) */
      maxPages: 10,
    }),
  })
})
