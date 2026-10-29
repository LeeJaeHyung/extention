/*
 * 1688 결제 페이지(단건 cashier.html · 묶음 batch-cashier.html) — 티켓 §4-3.
 *
 * 1. 화면이 그려질 때까지 기다림 → 로그인 안 됨(«Session过期»)이면 경고만(작업은 남김)
 * 2. 화면 주문번호(묶음은 서버 모델) 집합으로 등록된 작업을 찾음 — 없으면 아무것도 안 함(우리 탭 아님)
 * 3. 월드페이(kjpayV2) 카드 선택 → 통화 CNY → 결제 버튼 수단·금액 확인
 * 4. 시험 모드면 «여기서 눌렀을 것» 만 · 자동 클릭 꺼짐이면 «결제 버튼을 누르세요» · 켜짐이면 작업 소각 뒤 결제 버튼 1회
 *
 * 🔴 누르기는 safeClick 한 곳 → core.js#isClickAllowed(월드페이 밖 결제 수단·조합결제 카드는 어떤 경우에도 거절).
 * 🔴 어떤 input·textarea 에도 값을 넣지 않습니다. 결제 버튼 뒤 화면(비밀번호·인증)은 건드리지 않습니다.
 */
;(function (root) {
  'use strict'
  if (window.top !== window) return
  if (root.__chibizWorldpayCashierStarted) return
  root.__chibizWorldpayCashierStarted = true

  const C = root.ChibizWorldpayConfig
  const Core = root.ChibizWorldpayCore
  const Page = root.ChibizWorldpayPage

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve(null)
          else resolve(res || null)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  /** fn() 이 참 값을 줄 때까지(화면 변화마다 · 250ms 마다) — 시한이 지나면 null */
  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      let observer = null
      let timer = null
      let poll = null
      const finish = (v) => {
        if (done) return
        done = true
        if (observer) observer.disconnect()
        clearTimeout(timer)
        clearInterval(poll)
        resolve(v)
      }
      const check = () => {
        try {
          const v = fn()
          if (v) finish(v)
        } catch (e) {
          // 다음 변화에서 다시
        }
      }
      observer = new MutationObserver(check)
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      poll = setInterval(check, 250)
      timer = setTimeout(() => finish(null), timeoutMs)
      check()
    })
  }

  // ── 띠(페이지 위 고정 · shadow DOM 이라 페이지 글 읽기에 섞이지 않음) ─────────

  let bannerHost = null
  const COLORS = {
    error: ['#fef2f2', '#dc2626', '#991b1b'],
    warn: ['#fffbeb', '#d97706', '#92400e'],
    ok: ['#f0fdf4', '#16a34a', '#166534'],
    info: ['#eff6ff', '#2563eb', '#1e40af'],
  }

  function banner(kind, title, lines) {
    if (!document.body) return
    if (!bannerHost) {
      bannerHost = document.createElement('div')
      bannerHost.setAttribute(Page.BANNER_ATTR, '')
      bannerHost.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none'
      bannerHost.attachShadow({ mode: 'open' })
      document.body.appendChild(bannerHost)
    }
    const [bg, line, ink] = COLORS[kind] || COLORS.info
    const sh = bannerHost.shadowRoot
    sh.textContent = ''
    const style = document.createElement('style')
    style.textContent = `
      .box{pointer-events:auto;margin:8px auto;max-width:880px;background:${bg};border:1px solid ${line};border-left:6px solid ${line};
        border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:12px 40px 12px 16px;position:relative;
        font:14px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:${ink}}
      .brand{font-size:12px;font-weight:700;opacity:.8;margin-bottom:2px}
      .title{font-weight:700;font-size:15px}
      ul{margin:6px 0 0;padding-left:18px} li{margin:1px 0;word-break:break-all}
      .x{position:absolute;top:6px;right:8px;border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:${ink}}`
    const box = document.createElement('div')
    box.className = 'box'
    box.setAttribute('role', kind === 'error' || kind === 'warn' ? 'alert' : 'status')
    const brand = document.createElement('div')
    brand.className = 'brand'
    brand.textContent = '차이비즈 월드페이 자동 결제' + (lastSettings && lastSettings.dryRun ? ' · 시험 모드' : '')
    const t = document.createElement('div')
    t.className = 'title'
    t.textContent = title
    box.append(brand, t)
    if (lines && lines.length) {
      const ul = document.createElement('ul')
      for (const l of lines) {
        const li = document.createElement('li')
        li.textContent = l
        ul.appendChild(li)
      }
      box.appendChild(ul)
    }
    const x = document.createElement('button')
    x.className = 'x'
    x.type = 'button'
    x.setAttribute('aria-label', '닫기')
    x.textContent = '×'
    x.addEventListener('click', () => bannerHost && bannerHost.remove())
    box.appendChild(x)
    sh.append(style, box)
  }

  // ── 🔴 누르기 — 이 함수 한 곳 ─────────────────────────────────────────────

  function safeClick(el, purpose, target) {
    const desc = Page.describeElement(el)
    if (!Core.isClickAllowed(desc, purpose, target)) return false
    el.click()
    return true
  }

  // ── 흐름 ──────────────────────────────────────────────────────────────────

  let lastSettings = null

  function ordersLine(ids) {
    return `주문 ${ids.length}건: ${ids.join(', ')}`
  }

  function stopLines(code, job, snap) {
    const lines = []
    if (job) lines.push(ordersLine(job.orderIds))
    if (code === 'AMOUNT_MISMATCH' && job) {
      const shown = snap && snap.model ? snap.model.totalPayFeeFen : snap && snap.domOrderTotalFens && snap.domOrderTotalFens[0]
      lines.push(`관리자 웹 1688 금액 ${Core.formatFen(job.expectedOrderTotalFen)} · 결제 페이지 주문 총액 ${Core.formatFen(shown)}`)
    }
    if (code === 'PAY_CHANNEL_MISMATCH' && snap) lines.push(`결제 버튼 수단: ${(snap.operateZoneChannels || []).join(', ') || '없음'}`)
    const notice = Core.worldpayNotice(snap)
    if (notice) lines.push(`참고(월드페이 카드 안내 · 막지 않음): ${notice}`)
    return lines
  }

  /** 로그인 안 됨·그려지지 않음 — 주문번호를 못 읽으므로 주소(단건)·살아 있는 작업으로만 «우리 탭» 을 가늠. 🔴 작업은 소각하지 않음. */
  async function peekAndWarn(code, snap) {
    const res = await send({ type: 'PEEK', code, urlOrderIds: (snap && snap.url && snap.url.orderIds) || [] })
    if (res && res.warn) banner(code === 'SESSION_EXPIRED' ? 'warn' : 'error', Core.STOP_MESSAGES[code], res.job ? [ordersLine(res.job.orderIds)] : [])
  }

  async function claim(snap) {
    const pageOrderNos = Core.pageOrderNos(snap)
    const urlOrderIds = snap.url.orderIds
    for (let i = 0; i < C.CLAIM_RETRY; i++) {
      const res = await send({ type: 'CLAIM', pageOrderNos, urlOrderIds })
      if (res && res.kind !== 'NONE') return res
      if (i < C.CLAIM_RETRY - 1) await sleep(C.CLAIM_RETRY_DELAY_MS)
    }
    return { kind: 'NONE' }
  }

  function selectedChannel(code) {
    const s = Page.readSnapshot()
    const wp = s.channels.find((c) => c.channel === code)
    return wp && wp.selected ? s : null
  }

  function cnyActive() {
    const s = Page.readSnapshot()
    return s.currency.present && Core.isCnyText(s.currency.activeText) ? s : null
  }

  async function run() {
    let snap = await waitFor(() => {
      const s = Page.readSnapshot()
      return s.sessionExpired || s.rendered ? s : null
    }, C.RENDER_TIMEOUT_MS)
    if (!snap) {
      const s = Page.readSnapshot()
      return peekAndWarn(s.loginPrompt ? 'SESSION_EXPIRED' : 'RENDER_TIMEOUT', s)
    }
    if (snap.sessionExpired) return peekAndWarn('SESSION_EXPIRED', snap)

    // 서버 모델 스크립트·주문번호가 그려질 시간을 조금 줌
    await sleep(C.SETTLE_MS)
    snap = Page.readSnapshot()

    const res = await claim(snap)
    if (res.kind === 'NONE') return // 관리자 웹이 연 탭이 아님 — 아무것도 안 함
    if (res.kind === 'PARTIAL') {
      banner('error', Core.STOP_MESSAGES.ORDER_MISMATCH, [
        `관리자 웹 작업 ${ordersLine(res.job.orderIds)}`,
        `이 페이지 ${ordersLine(Core.pageOrderNos(snap))}`,
      ])
      return send({ type: 'BADGE', kind: 'STOP' })
    }
    if (res.kind === 'OTHER_TAB') return banner('warn', Core.STOP_MESSAGES.OTHER_TAB, [ordersLine(res.job.orderIds)])
    if (res.kind === 'ALREADY_DONE') return banner('info', Core.STOP_MESSAGES.ALREADY_DONE, [ordersLine(res.job.orderIds)])
    if (res.kind !== 'MATCH') return

    const job = res.job
    lastSettings = res.settings || null
    banner('info', '차이비즈 작업으로 연 결제 페이지입니다 — 월드페이(跨境宝) 결제를 준비합니다…', [ordersLine(job.orderIds)])

    // 🔴 작업 하나를 실행 → 세부 결과({ stage, code, checks }). 서버 주도 자동 결제(T-20261015-05)도
    //    이 executeJobFlow 를 그대로 씁니다(작업 출처만 다름). 아래에서 띠·보고로 옮깁니다.
    const result = await executeJobFlow(job, lastSettings)
    reportResult(job, result)
  }

  /**
   * 🔴 결제 페이지에서 작업 하나를 실행하는 한 함수 — «작업을 받아 실행 → 세부 결과 반환».
   * job = { jobId, orderIds, expectedOrderTotalFen, (payUrl 은 탭을 여는 쪽이 씀) }.
   * @returns { stage: 'PAID'|'DRY_RUN'|'PREPARED'|'STOP', code?, checks } — core.js#classifyOutcome 로 다섯 종류로.
   */

  /** 🆕 0.7.0 멈춤 보고에 붙이는 화면 상태(200자 이내) — 통화 탭·선택 수단·버튼 */
  function stopDetail(s) {
    try {
      const cur = (s && s.currency) || {}
      const sel = ((s && s.channels) || []).filter((c) => c.selected).map((c) => c.channel).join(',')
      return ('cur=' + (cur.present ? ('present:' + String(cur.activeText || '').slice(0, 12) + (cur.hasCnyOption ? '+cny' : '')) : 'absent')
        + ' sel=' + (sel || '-') + ' zones=' + ((s && s.operateZoneChannels) || []).join(',') + ' btn=' + (s && s.payButton ? (s.payButton.present ? (s.payButton.disabled ? 'disabled' : 'ok') : 'none') : '?')).slice(0, 200)
    } catch (e) {
      return ''
    }
  }

  async function executeJobFlow(job, settings) {
    const tried = { channel: 0, currency: 0 }
    let snap = Page.readSnapshot()
    let ready = null
    // 🆕 0.4.1 — 월드페이·통화를 고른 직후 1688 이 금액을 다시 계산하는 동안 결제 버튼이 잠깐 없거나 «계산 중» 이라
    //    첫 장면에서 바로 멈추던 것을 고침: 버튼만 문제면 PAY_BUTTON_WAIT_MS 동안 다시 봄(그래도 그대로면 멈춤)
    const btnWaitUntil = Date.now() + C.PAY_BUTTON_WAIT_MS
    for (let step = 0; step < 8 && !ready; step++) {
      snap = Page.readSnapshot()
      const d = Core.decideNext(snap, job, tried)
      // 🆕 0.5.2 — 큰 묶음은 결제 수단 카드·서버 모델이 늦게 그려져 첫 장면에 월드페이가 «없음» 으로 보일 수 있음 → 같은 시한 안에서 다시 봄
      if (d.action === 'STOP' && (d.code === 'NO_WORLDPAY' || d.code === 'WORLDPAY_UNAVAILABLE') && Date.now() < btnWaitUntil) {
        await waitFor(() => {
          const s2 = Page.readSnapshot()
          const tc = Core.targetChannelOf(job)
          return (s2.channels || []).some((c) => c.channel === tc) && (!s2.model || !s2.model.channels.length || s2.model.channels.some((c) => c.channel === tc))
        }, Math.max(0, btnWaitUntil - Date.now()))
        step--
        continue
      }
      if (d.action === 'STOP' && (d.code === 'PAY_BUTTON_MISSING' || d.code === 'PAY_BUTTON_DISABLED') && Date.now() < btnWaitUntil) {
        await waitFor(() => {
          const s3 = Page.readSnapshot()
          const b = Core.targetChannelOf(job) === C.CREDIT_CHANNEL ? s3.creditPayButton : s3.payButton
          return b && b.present && !b.disabled
        }, Math.max(0, btnWaitUntil - Date.now()))
        step--
        continue
      }
      // 🆕 0.7.0 실측(2026-10-29, 주문 3316534215037002998): 1688 이 월드페이를 «이미 선택된» 상태로 열어 주면 CLICK_CHANNEL 의
      //    선택 대기·SETTLE 이 없어서, 결제 수단 카드만 그려진 첫 장면(rendered)에서 바로 통화 탭을 찾고 CURRENCY_UNKNOWN 으로 멈췄다.
      //    통화 영역(.currency-area)은 카드보다 늦게 그려지므로 같은 시한 안에서 나타날 때까지 다시 본다.
      if (d.action === 'STOP' && d.code === 'CURRENCY_UNKNOWN' && Date.now() < btnWaitUntil) {
        await waitFor(() => {
          const s4 = Page.readSnapshot()
          return s4.currency && s4.currency.present && (Core.isCnyText(s4.currency.activeText) || s4.currency.hasCnyOption)
        }, Math.max(0, btnWaitUntil - Date.now()))
        await sleep(C.SETTLE_MS)
        step--
        continue
      }
      if (d.action === 'STOP') return { stage: 'STOP', code: d.code, snap, detail: stopDetail(snap) }
      if (d.action === 'WAIT') {
        await waitFor(() => Page.readSnapshot().rendered, C.SELECT_TIMEOUT_MS)
        continue
      }
      if (d.action === 'CLICK_CHANNEL') {
        tried.channel++
        const tc = Core.targetChannelOf(job)
        if (!safeClick(Page.channelCard(tc), 'channel', tc)) return { stage: 'STOP', code: 'CLICK_REFUSED', snap }
        await waitFor(() => selectedChannel(tc), C.SELECT_TIMEOUT_MS)
        await sleep(C.SETTLE_MS)
        continue
      }
      if (d.action === 'CLICK_CNY') {
        tried.currency++
        if (!safeClick(Page.findCnyOption(), 'currency')) return { stage: 'STOP', code: 'CLICK_REFUSED', snap }
        await waitFor(cnyActive, C.SELECT_TIMEOUT_MS)
        await sleep(C.SETTLE_MS)
        continue
      }
      // READY — 화면이 멈춘 뒤 한 번 더
      await sleep(C.SETTLE_MS)
      const again = Page.readSnapshot()
      if (Core.decideNext(again, job, tried).action === 'READY') ready = again
    }
    if (!ready) return { stage: 'STOP', code: 'INTERNAL', snap }

    const checks = [
      ordersLine(job.orderIds) + ' — 등록된 작업과 같음',
      (Core.targetChannelOf(job) === C.CREDIT_CHANNEL
        ? `결제 수단: 외상(先采后付 · shegou) 선택됨 · 남은 한도 ${ready.creditLimitFen != null ? Core.formatFen(ready.creditLimitFen) : '읽지 못함'}`
        : '결제 수단: 월드페이(跨境宝 · kjpayV2) 선택됨') + ' · 결제 버튼 수단 ' + (ready.operateZoneChannels.join(', ') || '(칸 없음 · 단건)'),
      '통화: ' + (ready.currency.present ? ready.currency.activeText : '탭 없음(묶음)'),
      `주문 총액 ${Core.formatFen(job.expectedOrderTotalFen)} — 작업의 1688 금액과 같음`,
    ]
    const notice = Core.worldpayNotice(ready)
    if (notice) checks.push(`참고(월드페이 카드 안내 · 막지 않음): ${notice}`)

    const final = Core.finalAction(settings)
    if (final === 'DRY_RUN') return { stage: 'DRY_RUN', checks }
    if (final === 'PREPARE_ONLY') return { stage: 'PREPARED', checks }

    // 🔴 결제 버튼 1회 — 작업을 먼저 소각(성공해야만 누름) → 화면을 다시 확인 → 곧바로 누름
    const begin = await send({ type: 'BEGIN_PAY_CLICK', jobId: job.jobId })
    if (!begin || !begin.ok) return { stage: 'STOP', code: 'SETTINGS_CHANGED', checks }
    const last = Page.readSnapshot()
    if (Core.decideNext(last, job, tried).action !== 'READY') return { stage: 'STOP', code: 'CHANGED_BEFORE_CLICK', checks, snap: last }
    const payEl = Core.targetChannelOf(job) === C.CREDIT_CHANNEL ? Page.creditPayButton() : Page.payButton()
    if (!safeClick(payEl, 'pay', Core.targetChannelOf(job))) return { stage: 'STOP', code: 'CLICK_REFUSED', checks }
    return { stage: 'PAID', checks }
  }

  /** 세부 결과 → 띠 + background 보고(정규화된 outcome 포함 · 서버 주도 자동 결제와 공통). */
  /** 🆕 0.6.3 금액 진단 한 줄 — 订单总金额·确认收货后付款·모델 금액·작업 금액(分 → 元) */
  function describeAmounts(snap, job) {
    const f = (a) => (Array.isArray(a) && a.length ? a.map((x) => (x == null ? '?' : Core.formatFen(x))).join(',') : '없음')
    const model = snap.model && snap.model.channels && snap.model.channels.length ? Core.formatFen(snap.model.totalPayFeeFen) : '없음'
    return `订单总金额 ${f(snap.domOrderTotalFens)}/페이지 ${f(snap.pageOrderTotalFens)} · 收货后付款 ${f(snap.creditDueFens)} · 모델 ${model} · 작업 ${Core.formatFen(job.expectedOrderTotalFen)} · 수단 ${Core.targetChannelOf(job)}`.slice(0, 200)
  }

  function reportResult(job, r) {
    const outcome = Core.classifyOutcome(r)
    // 🆕 0.4.1 결제 버튼 문제면 화면 모양(버튼 후보의 태그·클래스·글자·비활성 표시)을 짧게 붙여 서버 보고·띠에 남김(개인정보 없음)
    const detail =
      r.stage !== 'STOP' ? null
        : /^PAY_BUTTON|^CHANGED_BEFORE_CLICK|^CLICK_REFUSED/.test(r.code || '') ? Page.describePayButtons()
        : /^NO_WORLDPAY|^WORLDPAY_|^PAY_CHANNEL_MISMATCH|^OPERATE_ZONE_UNKNOWN/.test(r.code || '') ? Page.describeChannels() // 🆕 0.5.2 결제 수단 진단
        : /^AMOUNT_/.test(r.code || '') && r.snap ? describeAmounts(r.snap, job) // 🆕 0.6.3 금액 진단(읽은 값들)
        : r.detail || null // 🆕 0.7.0 그 밖의 멈춤(CURRENCY_UNKNOWN 등)은 화면 상태 요약
    if (r.stage === 'PAID') {
      banner('ok', '결제 버튼(立即付款)을 눌렀습니다 — 이후 화면(비밀번호·인증)은 직접 진행하세요.', r.checks)
    } else if (r.stage === 'DRY_RUN') {
      banner('info', '시험 모드 — 여기서 결제 버튼(立即付款)을 눌렀을 것입니다. 누르지 않았습니다.', r.checks)
    } else if (r.stage === 'PREPARED') {
      banner('ok', '결제 준비 완료 — 결제 버튼(立即付款)을 직접 누르세요.', r.checks)
    } else if (r.code === 'SETTINGS_CHANGED') {
      banner('warn', '설정이 바뀌었거나 작업이 끝나 결제 버튼을 누르지 않았습니다 — 직접 결제하세요.', r.checks)
    } else {
      const lines = stopLines(r.code, job, r.snap)
      if (detail) lines.push('진단: ' + detail)
      banner(r.code === 'SESSION_EXPIRED' ? 'warn' : 'error', Core.STOP_MESSAGES[r.code] || Core.STOP_MESSAGES.INTERNAL, lines)
    }
    return send({ type: 'REPORT', jobId: job.jobId, stage: r.stage, code: r.code || null, outcome, detail })
  }

  // 비밀번호 창(알리페이 iframe) 결과를 결제 페이지 띠로 — background 가 보냅니다(티켓 §4-5 · 0.3.0 사람이 직접 입력).
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'PAY_FAIL_BANNER') {
        banner('error', `결제 실패 화면을 감지했습니다(${String(msg.text || '').slice(0, 20)}) — 서버가 1688 조회로 확인합니다. 다시 시도하려면 관리자 웹에서 작업을 새로 만드세요.`, [])
        return
      }
      if (msg && msg.type === 'PAY_SUCCESS_BANNER') {
        banner('ok', `결제 완료 화면을 감지했습니다(${String(msg.text || '').slice(0, 20)}) — 서버가 1688 조회로 최종 확인합니다.`, [])
        return
      }
      if (!msg || msg.type !== 'PASSWORD_BANNER') return
      if (msg.result === 'USER_SUBMITTED') banner('ok', '비밀번호를 직접 입력하고 «下一步» 을 누르셨습니다 — 이후 화면도 직접 진행하세요.', [])
      else if (msg.result === 'AUTO_SUBMITTED') banner('ok', '저장된 비밀번호를 자동 입력하고 «下一步» 을 눌렀습니다 — 이후 화면은 직접 확인하세요.', [])
      else if (msg.result === 'WRONG') banner('error', '비밀번호가 틀렸습니다 — 자동으로 다시 넣지 않습니다. 직접 입력하세요.', [])
      else if (msg.result === 'MANUAL_TIMEOUT') banner('warn', '비밀번호를 입력하지 않아 멈췄습니다 — 직접 입력해 결제를 마치세요.', [])
      else banner('warn', '비밀번호를 직접 입력해 주세요.', [Core.PASSWORD_MANUAL_REASONS[msg.reason] || Core.PASSWORD_MANUAL_REASONS.USER_INPUT].filter(Boolean))
    })
  } catch (e) {
    // 메시지 수신을 못 걸어도 결제 흐름에는 지장 없음
  }

  run().catch((e) => {
    console.warn('[chibiz-worldpay] 멈춤', e && e.message)
    banner('error', Core.STOP_MESSAGES.INTERNAL, [])
  })
})(globalThis)
