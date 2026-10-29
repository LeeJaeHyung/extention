/*
 * 🆕 0.5.0 결제 완료 감지 — 1688 결제·결과 페이지(air.1688.com · trade.1688.com, 최상위 프레임).
 *
 * - 페이지가 열리면 경로(쿼리 없음)를 background 에 알림 → 결제 버튼을 누른 탭이면 «마지막 페이지» 로 기억(완료 화면을 못 봤을 때 보고).
 * - 화면 글에서 결제 완료 글자(SUCCESS_DETECT.texts)가 보이면 PAY_SUCCESS_SEEN — background 가 «그 탭에서 결제 버튼을 누른 지 15분 안» 일 때만 받음.
 * 🔴 읽기만 합니다(클릭·입력 없음). 화면 글은 완료 글자 하나만 보내고 다른 내용·주소 쿼리는 보내지 않습니다.
 */
;(function (root) {
  'use strict'
  if (window.top !== window) return
  if (root.__chibizWorldpayResultStarted) return
  root.__chibizWorldpayResultStarted = true

  const C = root.ChibizWorldpayConfig
  const Core = root.ChibizWorldpayCore

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res || null))
      } catch (e) {
        resolve(null)
      }
    })
  }

  send({ type: 'PAGE_AFTER_PAY', path: location.pathname })

  /** 우리 안내 띠(완료 글자를 담고 있음)를 뺀 화면 글 — 띠의 글자를 화면 글로 잘못 읽지 않게 */
  function pageTextWithoutBanner() {
    if (!document.body) return ''
    const banner = document.querySelector('[data-chibiz-worldpay-banner]')
    const all = document.body.innerText || ''
    const b = banner ? banner.innerText || '' : ''
    return (b ? all.replace(b, ' ') : all).slice(0, 5000)
  }

  /**
   * 🆕 0.5.5 결과 페이지(batch-pay-result 등)의 «共N笔订单» 을 한 번 눌러 팝업의 주문 줄을 읽음(실측 2026-10-23).
   * 줄: 订单号 {번호} · 支付成功/失败 · 跨境宝/先采后付 · ¥금액. 🔴 누르는 것은 이 링크 하나뿐(결제와 무관) · 못 읽으면 [] .
   */
  async function readResultOrders() {
    if (!/pay-result/.test(location.pathname)) return []
    const link = Array.from(document.querySelectorAll('a, span, div, button'))
      .find((el) => /^共\s*\d{1,3}\s*笔订单\s*>?$/.test(Core.normalizeText(el.textContent)) && el.children.length <= 2)
    if (!link) return []
    link.click()
    const deadline = Date.now() + 4000
    let rows = []
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      rows = parseOrderRows()
      if (rows.length) break
    }
    return rows.slice(0, 30)
  }

  /** 팝업 안 주문 줄 — «订单号 \d+» 를 가진 가장 작은 줄 덩어리마다 상태·수단·금액 */
  function parseOrderRows() {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('tr, li, div')) {
      const t = Core.normalizeText(el.innerText || el.textContent || '')
      const m = t.match(/订单号\s*(\d{10,25})/)
      if (!m || seen.has(m[1])) continue
      // 같은 번호를 가진 더 작은 덩어리가 있으면 그쪽을 씀(가장 안쪽 줄)
      if ([...el.children].some((c) => (c.innerText || '').includes(m[1]) && /支付|付款|[¥￥]/.test(c.innerText || ''))) continue
      seen.add(m[1])
      const status = /支付成功|付款成功/.test(t) ? 'SUCCESS' : /支付失败|付款失败|失败/.test(t) ? 'FAILED' : /待支付|未支付/.test(t) ? 'UNPAID' : 'UNKNOWN'
      const method = /跨境宝/.test(t) ? 'WORLDPAY' : /先采后付/.test(t) ? 'CREDIT' : /支付宝/.test(t) ? 'ALIPAY' : null
      const a = t.match(/[¥￥]\s*([\d,]+(?:\s*\.\s*\d{1,2})?)/)
      const fen = a ? Core.parseYuanToFen(a[1].replace(/[\s,]/g, '')) : null
      out.push({ orderNo: m[1], status, method, amountFen: Number.isSafeInteger(fen) ? fen : null })
    }
    return out
  }

  let done = false
  let lastTried = 0
  async function check() {
    if (done) return
    const now = Date.now()
    if (now - lastTried < 1000) return // 1초에 한 번만
    lastTried = now
    const body = pageTextWithoutBanner()
    const text = Core.findSuccessText(body)
    if (text) {
      // 🆕 0.5.3 완료 화면 요약(건수·금액·수단)도 함께 — background 가 작업과 대조
      // 🆕 0.5.5 결과 페이지면 주문별 결과를 이어서 보냄(ordersPending) — background 가 «우리가 결제 버튼을 누른 탭» 이라고 답할 때만 팝업을 엶
      const resultPage = /pay-result/.test(location.pathname)
      const res = await send({ type: 'PAY_SUCCESS_SEEN', text, summary: Core.parseSuccessSummary(body), ordersPending: resultPage })
      if (res && res.ok) {
        done = true // 결제 버튼을 누른 탭이 아니면 계속 지켜봄(나중에 누를 수 있음)
        if (resultPage) {
          const orders = await readResultOrders()
          await send({ type: 'PAY_RESULT_ORDERS', orders })
        }
      }
      return
    }
    const fail = Core.findFailText(body)
    if (fail) {
      const res = await send({ type: 'PAY_FAIL_SEEN', text: fail })
      if (res && res.ok) done = true
    }
  }

  const observer = new MutationObserver(() => {
    check()
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
  const poll = setInterval(check, 2000)
  setTimeout(() => {
    observer.disconnect()
    clearInterval(poll)
  }, C.SUCCESS_DETECT.windowMs)
  check()
})(globalThis)
