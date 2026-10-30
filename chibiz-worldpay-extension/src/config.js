/*
 * 차이비즈 월드페이 자동 결제 — 설정 한 곳 (티켓 T-20261015-04)
 *
 * 🔴 관리자 웹 출처(운영 도메인)는 여기가 아니라 manifest.json 의 content_scripts[0].matches 한 줄입니다
 *    (MV3 는 content script 출처를 manifest 에만 적을 수 있고, 넓은 권한 `scripting` 을 쓰지 않기로 했습니다).
 *    운영 관리자 도메인이 정해지면 그 줄에 `https://<도메인>/*` 를 더하세요.
 *
 * 🔴 여기 있는 시간 값은 전부 «추정한 값» 입니다 — 근거 있는 한도가 아닙니다. 끄거나 바꾸는 법은 README §안전장치.
 */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ChibizWorldpayConfig = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /** 🆕 서버 주소(아래 SERVER_BASE_URL 설명) — 이 한 줄만 바꿉니다 */
  const SERVER_BASE_URL = 'https://www.chibiz.co.kr/stage-api'

  return Object.freeze({
    /** 관리자 웹 ↔ 익스텐션 postMessage 표식 */
    MSG_SOURCE_ADMIN: 'chibiz-admin',
    MSG_SOURCE_EXT: 'chibiz-worldpay-ext',
    MSG_TYPE_JOB: 'WORLDPAY_JOB',
    MSG_TYPE_JOB_ACK: 'WORLDPAY_JOB_ACK',
    MSG_TYPE_PING: 'WORLDPAY_PING',
    MSG_TYPE_READY: 'WORLDPAY_READY',
    /** 관리자 웹 <html> 에 다는 «설치됨» 표식(값 = 익스텐션 버전) */
    INSTALLED_ATTR: 'data-chibiz-worldpay-ext',

    /** 🔴 결제 수단 중 기본으로 «누를 수 있는» 카드 — 다른 값으로 바꾸지 마세요(알리페이·跨境直采 금지) */
    WORLDPAY_CHANNEL: 'kjpayV2',
    /**
     * 🆕 0.6.0 외상(先采后付 «确认收货后付款 · 收货后下月8号自动付») 카드 — 사용자 지시 2026-10-23 «월드페이 최우선 · 실패·미지원이면 외상으로».
     * 🔴 서버 작업이 `payChannel: "CREDIT"` 으로 지정했을 때만 누릅니다. 관리자 웹 작업·월드페이 작업에서는 지금처럼 절대 안 누름.
     */
    CREDIT_CHANNEL: 'shegou',

    /** 작업 유효 시간(티켓 §4-2 · 10분) */
    JOB_TTL_MS: 10 * 60 * 1000,
    /** 관리자 PC 와 시계가 어긋날 수 있는 폭(작업 createdAt 이 미래로 이만큼까지는 받음) · 추정값 */
    CLOCK_SKEW_MS: 60 * 1000,
    /** 한 작업에 담을 수 있는 1688 주문 수(결제 링크 SDK 상한 30 · 외부 한도) */
    MAX_ORDERS_PER_JOB: 30,
    /** 결제 페이지가 그려지기를 기다리는 시간(처음 «加载中») · 추정값 */
    RENDER_TIMEOUT_MS: 30 * 1000,
    /** 월드페이 카드·CNY 탭을 누른 뒤 반영을 기다리는 시간 · 추정값 */
    SELECT_TIMEOUT_MS: 5 * 1000,
    /** 🆕 0.4.1 결제 버튼이 없거나 «계산 중» 일 때 다시 보며 기다리는 최대 시간 · 추정값 */
    PAY_BUTTON_WAIT_MS: 10 * 1000,
    /** 결제 버튼을 누르기 전 화면이 멈춰 있어야 하는 시간(금액 다시 그리기 대기) · 추정값 */
    SETTLE_MS: 800,
    /** 작업을 아직 못 받았을 때 다시 물어보는 횟수·간격(관리자 웹이 탭을 연 직후) · 추정값 */
    CLAIM_RETRY: 5,
    CLAIM_RETRY_DELAY_MS: 1000,

    /** 결제 페이지 선택자(티켓 §3 실측 · 해시 없는 클래스·data-* 만) */
    SELECTORS: Object.freeze({
      channelCard: '.channel-card[data-channel]',
      currencyTab: '.currency-tab',
      currencyActive: '.active',
      priceInfoItem: '.ext-price-info-item',
      payButton: 'q-button.pay-btn',
      /** 결제 버튼을 감싼 구역 — data-channel = 지금 고른 수단(묶음 실측) */
      operateZone: '.operate-zone[data-channel]',
      /** 조합결제(외상 섞임) 카드 — 🔴 절대 누르지 않음 */
      combCard: '.comb-channel-card',
    }),
    TEXT: Object.freeze({
      orderNoLabel: '订单编号',
      orderTotalLabel: '订单总金额',
      cny: '人民币',
      cnyCode: 'CNY',
      sessionExpired: 'Session过期',
      loginPrompt: '请登录',
      /** 🆕 0.7.1 이미 결제된 주문의 결제창(1688 이 안내/로그인 화면으로 보냄) — 🔴 실측 전 문구 목록 */
      alreadyPaid: ['订单已支付', '已完成支付', '订单已付款', '该订单已支付', '订单已完成', '已支付成功', '无需重复支付', '订单状态已改变', '订单不是待支付状态'],
      /** 월드페이를 고른 뒤 결제 버튼 글자(조합결제면 «组合付款») */
      payButtonText: '立即付款',
      /**
       * 🆕 0.6.3 외상(先采后付) 결제 버튼 — 실측 2026-10-23: 버튼이 «免密支付»(비밀번호 없이) · «普通支付»(일반) 두 개.
       * 🔴 «普通支付» 만 누름 — 비밀번호 단계를 거쳐야 월드페이와 같은 확인(비밀번호 자동 입력·틀림 감지)이 붙음. «免密支付» 는 절대 누르지 않음.
       */
      creditPayButtonText: '普通支付',
      creditNoPasswordText: '免密支付',
    }),

    /**
     * 🔴 비밀번호 창(티켓 §4-5 · 실측 2026-10-15) — 1688 결제 페이지 안에 박힌 **교차 출처 iframe**(`https://pcauth-site.alipay.com/home`).
     * 🆕 0.4.0(2026-10-22 사용자 지시): 시험 작업(TEST)에 1회용 표가 있고 «비밀번호 자동 입력» 이 켜져 있으면 서버에서 1회 받아 칸에 넣고
     * «下一步» 을 한 번 누릅니다. 그 밖은 0.3.0 처럼 «직접 입력해 주세요» 를 띄우고 사람이 «下一步» 을 누르는지·틀림 문구가 뜨는지만 읽어 보고합니다.
     * 🔴 iframe 주소의 쿼리(세션 값)는 읽지 않습니다. 입력칸의 값도 읽지 않습니다.
     * 🔴 manifest 의 세 번째 content script 매치(`https://pcauth-site.alipay.com/home*`)와 같은 출처여야 합니다.
     */
    PASSWORD_STEP: Object.freeze({
      titleText: '请输入支付宝密码',
      /** 🆕 0.4.4 실측(2026-10-22): 창 주소는 `https://pcauth-site.alipay.com/PASSWORD?…`(SPA · /home 아님) — 제목 글자도 판본마다 다를 수 있어 넓게 봄 */
      titleTexts: Object.freeze(['请输入支付宝密码', '支付宝密码', '支付密码', '请输入密码']),
      frameOrigin: 'https://pcauth-site.alipay.com',
      framePath: '/home',
      /** 이 창이 박혀 있어야 하는 상위 페이지 출처(알리페이를 직접 연 탭에서는 아무것도 안 함) */
      parentOrigin: 'https://air.1688.com',
      /** 사람이 누르는 «下一步» 을 알아보는 글자(읽기만) */
      nextButtonText: '下一步',
      /** 틀림 문구 — 예시 문구 · 실측 아님 */
      errorTexts: Object.freeze(['密码错误', '密码不正确', '密码输入错误']),
      /** 결제 버튼을 익스텐션이 누른 뒤 이 시간 안에 열린 창에만(티켓 §4-5 · 2분) */
      windowMs: 2 * 60 * 1000,
      /** 창 제목이 나타나기를 기다리는 시간 · 추정값 */
      titleWaitMs: 60 * 1000,
      /** 사람이 «下一步» 을 누르기를 기다리는 시간(지나면 «직접 입력 안 함» 으로 보고) · 추정값 */
      userSubmitWatchMs: 5 * 60 * 1000,
      /** «下一步» 뒤 틀림 문구를 지켜보는 시간 · 추정값 */
      errorWatchMs: 15 * 1000,
      /**
       * 🆕 0.4.0 자동 입력 — 비밀번호 칸 후보(위에서부터 처음 보이는 것 하나 · 🔴 실측 전 · 못 찾으면 사람이 직접).
       * 값 넣기 = 브라우저 기본 setter + input/change 이벤트(사람 입력과 같은 길). 보안 입력이 받지 않으면 우회하지 않고 칸을 비운 뒤 사람에게 넘깁니다.
       */
      inputSelectors: Object.freeze(['input[type=password]', 'input[maxlength="6"]']),
      /** 값을 넣은 뒤 «下一步» 이 켜지기를 기다리는 시간 · 추정값 */
      enableWaitMs: 3 * 1000,
    }),

    /**
     * 🆕 서버 주소 한 곳(0.3.0 · 2026-10-22 사용자 지시 — 다른 PC 에 설치) — ngrok 이 5188(회원 웹 vite)을 열고 백엔드 9999 는 `/dev-api` 로 프록시됩니다.
     * 시험 작업 받기(TESTPAY · 기본 꺼짐)와 서버 자동 결제(AUTOPAY · 기본 꺼짐)가 이 주소를 씁니다.
     * 🔴 주소를 바꾸면 manifest.json 의 host_permissions 도 같은 출처로 바꾸세요(서비스 워커 fetch 는 CORS 대신 이 권한으로 나감).
     * ngrok 무료 주소는 브라우저 요청에 경고 페이지를 끼울 수 있어 모든 요청에 {@link SERVER_HEADERS} 를 붙입니다.
     */
    SERVER_BASE_URL,
    SERVER_HEADERS: Object.freeze({ 'ngrok-skip-browser-warning': '1' }),

    /**
     * 🆕 0.5.0 결제 완료 감지(사용자 지시 2026-10-23 «결제 완료 됐는지 익스텐션에서 감지»).
     * 결제 버튼을 누른 탭에서 아래 글자가 보이면 «결제 완료 화면 감지» 로 서버에 보고합니다(code 끝 `:SUCCESS_SEEN`).
     * 🔴 실측 전 글자 목록 — 못 찾으면 «미감지 · 마지막 페이지 경로» 를 보고해 실제 완료 화면을 배웁니다. 정본 판정은 언제나 서버의 1688 조회.
     */
    SUCCESS_DETECT: Object.freeze({
      texts: Object.freeze(['支付成功', '付款成功', '交易成功', '成功付款', '支付完成', '付款完成', '已成功付款', '支付已完成']),
      /** 🆕 0.5.3 결제 실패 화면 글자(🔴 실측 전 · 잔액 부족·한도·실패) — 보이면 «결제 실패 화면 감지» 로 바로 보고 */
      failTexts: Object.freeze(['支付失败', '付款失败', '交易失败', '支付未成功', '余额不足', '额度不足', '超出限额', '支付超时', '支付异常']),
      /** 결제 버튼을 누른 뒤 이 시간 안의 신호만 받음 · 추정값 */
      windowMs: 15 * 60 * 1000,
      /** 한 화면에서 글자를 지켜보는 시간 · 추정값 */
      watchMs: 3 * 60 * 1000,
      /**
       * 🆕 0.6.6(운영 · 2026-10-26 J 지시) 결제 완료를 감지하면 결과 보고가 확정된 뒤 그 탭을 닫음.
       * 🔴 같은 창에 다른 탭이 하나 이상 있을 때만 닫음 — 탭이 1개는 무조건 남아야 함(창이 닫히면 확장이 작업을 못 받음).
       */
      closeTabAfterSuccess: true,
      /** 보고 확정 뒤 완료 화면을 보여 주는 시간 · 추정값 */
      closeTabDelayMs: 3 * 1000,
      /** 보고 확정을 기다리는 최대 시간(결과 페이지 주문별 결과 대기 8초 + 여유) · 추정값 */
      closeTabWaitReportMs: 20 * 1000,
    }),

    /** 기본 설정(팝업에서 바꿈 · chrome.storage.local) */
    DEFAULT_SETTINGS: Object.freeze({
      /** «결제 버튼 자동 클릭» — 사용자 결정: 기본 켜짐 */
      autoClick: true,
      /** 시험 모드(dry-run) — 결제 버튼 직전까지만 · 에이전트·tester 검증은 이것만 */
      dryRun: false,
      /** 🆕 «서버 작업 자동 실행»(T-20261015-05) — 기본 꺼짐 · 꺼져 있으면 claim 을 부르지 않음 */
      serverAutoRun: false,
      /** 🆕 0.3.0 «시험 작업 받기»(관리자 «월드페이 결제 시험» · 다른 PC) — 기본 꺼짐 · 꺼져 있으면 시험 claim 을 부르지 않음 */
      testJobRun: false,
      /** 🆕 0.4.0 «비밀번호 자동 입력»(사용자 지시 2026-10-22) — 시험 작업(TEST)에 1회용 표가 있을 때만 · 끄면 사람이 직접 */
      passwordAutoFill: true,
      /** 🆕 0.5.1 «서버 자동 결제» 통로의 비밀번호 자동 입력(통로별 따로 · 서버 자동 결제 자체가 기본 꺼짐) */
      serverPasswordAutoFill: true,
    }),

    /**
     * 🆕 0.3.0 시험 작업(관리자 «월드페이 결제 시험» · 계약 admin-worldpay-test.md) — 관리자가 이 PC 가 아닌 곳(관리자 웹)에서
     * 작업을 만들면, 이 익스텐션이 서버에서 받아 결제 페이지를 엽니다. 흐름·결과 다섯 종류는 서버 자동 결제(AUTOPAY)와 같고
     * **주소·키·켜기 스위치·멈춤 상태는 따로**입니다(섞지 않음).
     * 🔴 키는 서버 설정과 같은 값 — 지금은 dev 값. 운영 키는 여기 넣지 말고 배포 때 바꿉니다.
     */
    TESTPAY: Object.freeze({
      SERVER_BASE_URL,
      /** 🔴 dev 키(계약 admin-worldpay-test.md §1-1 · application-dev.yml `worldpay-test.extension-key`) — 운영 키는 여기 넣지 않음 */
      EXTENSION_KEY: 'dev-wptest-M8k_qcMAd0PHNzNVKAhTdFc6qVtzgKgrmKFCehwWrqs',
      KEY_HEADER: 'X-WORLDPAY-TEST-KEY',
      CLAIM_PATH: '/order/worldpay-test/ext/claim',
      RESULT_PATH: (jobId) => `/order/worldpay-test/ext/jobs/${encodeURIComponent(jobId)}/result`,
      /** 🆕 0.4.0 결제 비밀번호 1회 받기(계약 §5-3 · 키 헤더 + claim 때 받은 1회용 표) */
      REVEAL_PATH: '/order/worldpay-test/ext/payment-password/reveal',
      /** 🆕 0.5.1 이 통로의 «비밀번호 자동 입력» 설정 이름 */
      PASSWORD_SETTING: 'passwordAutoFill',
      /** 알람 주기(분) — 크롬 알람 최소 30초 · 추정값 */
      CLAIM_PERIOD_MIN: 0.5,
      /** 알람 한 번 안에서 다시 묻는 간격·횟수(30초 안을 5초마다 · 지시 «5~10초») · 추정값 */
      POLL_INTERVAL_MS: 5 * 1000,
      POLLS_PER_ALARM: 5,
      /** 서버 요청 시한 · 추정값 */
      FETCH_TIMEOUT_MS: 10 * 1000,
      /** 결제 버튼을 누른 뒤 비밀번호 창 결과를 기다리는 시간(창 2분 + 직접 입력 5분 + 여유) · 추정값 */
      AFTER_CLICK_WAIT_MS: 8 * 60 * 1000,
      /** 사람이 «下一步» 을 누른 뒤 틀림 문구를 기다렸다가 보고하는 여유 · 추정값 */
      /** 🆕 0.5.0 — 결제 완료 화면 감지를 기다리도록 25초 → 60초(감지되면 그 즉시 보고) · 추정값 */
      AFTER_PASSWORD_WAIT_MS: 60 * 1000,
    }),

    /**
     * 🆕 서버 주도 자동 결제(T-20261015-05 · 계약 supplier-auto-pay.md).
     * 🔴 서버 주소를 바꾸면 manifest.json 의 host_permissions 도 같은 출처로 바꾸세요(서비스 워커 fetch 는 CORS 대신 이 권한으로 나감).
     * 🔴 키는 서버 `supplier.auto-pay.extension-key` 와 같은 값 — 지금은 dev 값(application-dev.yml). 운영 키는 여기 넣지 말고 배포 때 바꿉니다.
     */
    AUTOPAY: Object.freeze({
      /** 위 SERVER_BASE_URL 과 같음(한 곳에서 바꿈) */
      SERVER_BASE_URL,
      EXTENSION_KEY: 'opautopay-e7fd4cca94442fc78133ca5a105f95426482b7dbbf0fecac',
      KEY_HEADER: 'X-AUTOPAY-KEY',
      CLAIM_PATH: '/supplier/auto-pay/jobs/claim',
      RESULT_PATH: (jobId) => `/supplier/auto-pay/jobs/${encodeURIComponent(jobId)}/result`,
      /** 🆕 0.5.1 자동 결제 비밀번호 1회 받기(계약 supplier-auto-pay §5 · X-5 · 본문 {revealToken, claimToken}) */
      REVEAL_PATH: '/supplier/auto-pay/jobs/payment-password/reveal',
      PASSWORD_SETTING: 'serverPasswordAutoFill',
      /** claim 주기(분) — 🆕 0.5.1 계약 X-4 «30초 claim 기본»(크롬 알람 최소 30초) */
      CLAIM_PERIOD_MIN: 0.5,
      /** 서버 요청 시한 · 추정값 */
      FETCH_TIMEOUT_MS: 10 * 1000,
      /**
       * 결제 버튼을 누른 뒤 비밀번호 창 결과를 기다리는 시간(창 2분 + 틀림 감시 15초 + 여유) — 지나면 PAID_SUBMITTED(CLICKED) 로 보고 · 추정값.
       * 서버는 PAID_SUBMITTED 를 받아도 1688 조회로만 «결제됨» 을 정합니다.
       */
      AFTER_CLICK_WAIT_MS: 2 * 60 * 1000 + 30 * 1000,
      /** 비밀번호 «下一步» 뒤 틀림 문구를 기다렸다가 보고하는 여유(틀림 감시 15초 + 10초) · 추정값 */
      /** 🆕 0.5.0 — 결제 완료 화면 감지를 기다리도록 25초 → 60초(감지되면 그 즉시 보고) · 추정값 */
      AFTER_PASSWORD_WAIT_MS: 60 * 1000,
    }),
  })
})
