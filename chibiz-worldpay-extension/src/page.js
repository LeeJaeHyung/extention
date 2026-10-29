/*
 * 결제 페이지 DOM 읽기 — 읽기만 합니다(누르기는 cashier-content.js#safeClick 한 곳).
 * 결과는 core.js#decideNext 가 받는 snapshot 모양입니다.
 *
 * 단건 `cashier.html?orderId=…` 과 묶음 `batch-cashier.html?cashierOrderNo=…` 둘 다(티켓 §3).
 * 묶음은 주문번호·금액을 인라인 스크립트의 `batchServerModel` JSON 에서 읽습니다(🔴 eval 없음 · 괄호 짝 + JSON.parse).
 */
;(function (root) {
  'use strict'
  const C = root.ChibizWorldpayConfig
  const Core = root.ChibizWorldpayCore
  const S = C.SELECTORS
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT'])
  const BANNER_ATTR = 'data-chibiz-worldpay-banner'

  /** 페이지 글(스크립트·스타일 제외 · 숨은 요소 포함)을 글 조각마다 줄바꿈으로 이어 붙입니다 — 이웃 숫자가 붙지 않게. */
  function pageText(rootEl) {
    const base = rootEl || document.body
    if (!base) return ''
    const parts = []
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentElement
        while (el && el !== base) {
          if (SKIP_TAGS.has(el.tagName) || el.hasAttribute(BANNER_ATTR)) return NodeFilter.FILTER_REJECT
          el = el.parentElement
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    let n
    while ((n = walker.nextNode())) parts.push(n.nodeValue.trim())
    return parts.join('\n')
  }

  /** 묶음 서버 모델(없으면 null) */
  function readServerModel() {
    for (const s of document.scripts) {
      if (s.src) continue
      const text = s.textContent || ''
      if (!text.includes('batchServerModel')) continue
      const obj = Core.extractObjectAfterKey(text, 'batchServerModel')
      if (obj) return Core.summarizeBatchModel(obj)
    }
    return null
  }

  /** 일반결제 카드만 — 조합결제 카드(`.comb-channel-card`) 안·자신은 뺍니다. */
  function normalChannelCards() {
    return Array.from(document.querySelectorAll(S.channelCard)).filter((el) => !el.closest(S.combCard))
  }

  function readChannels() {
    return normalChannelCards().map((el) => {
      const args = Core.parseTrackerArgs(el.getAttribute('data-tracker-args'))
      const a = args.available
      return {
        channel: el.getAttribute('data-channel'),
        selected: el.classList.contains('selected'),
        disabled: el.classList.contains('disabled'),
        domAvailable: a === 'true' ? true : a === 'false' ? false : null,
      }
    })
  }

  /** `.currency-tab` 안에서 «人民币(CNY)» 글이 있는 가장 안쪽 요소 */
  function findCnyOption() {
    let best = null
    for (const tab of document.querySelectorAll(S.currencyTab)) {
      for (const el of [tab, ...tab.querySelectorAll('*')]) {
        if (!Core.isCnyText(el.textContent)) continue
        if (!best || best.contains(el)) best = el
      }
    }
    return best
  }

  function readCurrency() {
    const tab = document.querySelector(S.currencyTab)
    if (!tab) return { present: false, activeText: '', hasCnyOption: false }
    const active = tab.querySelector(S.currencyActive)
    return { present: true, activeText: active ? Core.normalizeText(active.textContent) : '', hasCnyOption: !!findCnyOption() }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    const st = getComputedStyle(el)
    return st.visibility !== 'hidden' && st.display !== 'none'
  }

  /**
   * 속성이 «켜짐» 인가 — 🆕 0.4.2 실측(2026-10-22 결제 페이지): q-button 은 늘 `loading="false"` 를 달고 있습니다.
   * 0.4.1 까지는 «속성이 있음» 만 봐서 멀쩡한 버튼을 «계산 중» 으로 읽고 PAY_BUTTON_DISABLED 로 멈췄습니다. 값이 "false" 면 꺼짐.
   */
  function attrOn(el, name) {
    if (!el.hasAttribute(name)) return false
    const v = String(el.getAttribute(name)).trim().toLowerCase()
    return v !== 'false' && v !== '0'
  }

  function isDisabledButton(el) {
    return attrOn(el, 'disabled') || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled') || attrOn(el, 'loading')
  }

  /**
   * 누를 결제 버튼 하나.
   * 🆕 0.4.1 — 화면에 «보이는» 것을 먼저 고릅니다(보이고 누를 수 있는 것 → 보이는 것 → 본문 `.static-operate-zone` → 첫 번째).
   *    0.4.0 까지는 본문 것을 무조건 먼저 골라, 본문 버튼이 숨겨져 있거나 비활성이고 하단 고정 버튼만 살아 있을 때 «버튼 없음» 으로 멈췄습니다.
   */
  function payButton() {
    const all = Array.from(document.querySelectorAll(S.payButton))
    const visible = all.filter(isVisible)
    return visible.find((el) => !isDisabledButton(el)) || visible[0] || all.find((el) => el.closest('.static-operate-zone')) || all[0] || null
  }

  /**
   * 🆕 0.6.3 외상 결제 버튼(«普通支付») — 글자가 정확히 그것인 가장 안쪽 요소. 외상 결제 칸(operate-zone[data-channel=shegou]) 안 → 보이고 누를 수 있는 것 → 보이는 것 순.
   * 🔴 «免密支付» 는 후보가 될 수 없음(글자 일치만 받음).
   */
  function creditPayButton() {
    const want = C.TEXT.creditPayButtonText
    const all = Array.from(document.querySelectorAll('q-button, button, [role=button], a, div, span')).filter(
      (el) => Core.normalizeText(el.textContent) === want && ![...el.children].some((c) => Core.normalizeText(c.textContent) === want),
    )
    // 안쪽 글자 요소가 버튼 태그 안이면 버튼 쪽을 씀
    const lifted = all.map((el) => el.closest('q-button, button, [role=button], a') || el).filter((el, i, a) => a.indexOf(el) === i)
    const inZone = (el) => !!el.closest(`.operate-zone[data-channel="${C.CREDIT_CHANNEL}"]`)
    const visible = lifted.filter(isVisible)
    return (
      visible.find((el) => inZone(el) && !isDisabledButton(el)) ||
      visible.find((el) => !isDisabledButton(el)) ||
      visible[0] ||
      lifted[0] ||
      null
    )
  }

  function isCreditPayButton(el) {
    return !!el && el === creditPayButton()
  }

  function readButton(el) {
    if (!el) return { present: false, disabled: false, text: '' }
    return { present: true, disabled: isDisabledButton(el), text: Core.normalizeText(el.textContent) }
  }

  function readPayButton() {
    const el = payButton()
    if (!el) return { present: false, disabled: false, text: '' }
    return { present: true, disabled: isDisabledButton(el), text: Core.normalizeText(el.textContent) }
  }

  /** 🆕 0.5.2 진단 — 결제 수단 카드(화면)와 서버 모델 채널 한 줄(≤ 200자 · 채널 코드·선택·비활성·가능 여부·조합결제 안·덮는 주문 수만) */
  function describeChannels() {
    const cards = Array.from(document.querySelectorAll(S.channelCard)).slice(0, 8).map((el) => {
      const a = Core.parseTrackerArgs(el.getAttribute('data-tracker-args')).available
      const f = [el.classList.contains('selected') ? 'sel' : '', el.classList.contains('disabled') ? 'dis' : '', a === 'true' ? 'av' : a === 'false' ? 'na' : '', el.closest(S.combCard) ? 'comb' : '']
      return `${el.getAttribute('data-channel') || '?'}[${f.filter(Boolean).join(',')}]`
    })
    const m = readServerModel()
    const model = m ? m.channels.slice(0, 8).map((c) => `${c.channel}${c.available === false ? '(na)' : ''}/${c.itemOrderIds.length}`).join(' ') : '없음'
    return `카드: ${cards.join(' ') || '없음'} · 모델: ${model}`.slice(0, 200)
  }

  /** 🆕 0.4.1 진단 — 결제 버튼 후보 모양 한 줄(≤ 200자 · 태그·클래스·글자·비활성·보임·구역만 · 개인정보 없음) */
  function describePayButtons() {
    const all = Array.from(document.querySelectorAll(S.payButton))
    const parts = all.slice(0, 4).map((el, i) => {
      const zone = el.closest('[class*="operate-zone"]')
      const flags = [isVisible(el) ? 'vis' : 'hid', isDisabledButton(el) ? 'dis' : 'on', attrOn(el, 'loading') ? 'loading' : ''].filter(Boolean).join(',')
      return `#${i}[${flags}] "${Core.normalizeText(el.textContent).slice(0, 8)}" zone=${zone ? String(zone.className).slice(0, 30) : '-'}`
    })
    // 셀렉터에 안 걸린 «立即付款» 글자 요소(태그·클래스만)
    const other = Array.from(document.querySelectorAll('button, [role=button], q-button, a, div, span'))
      .filter((el) => !el.matches(S.payButton) && Core.normalizeText(el.textContent) === C.TEXT.payButtonText && ![...el.children].some((c) => Core.normalizeText(c.textContent) === C.TEXT.payButtonText))
      .slice(0, 2)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').split(/\s+/).slice(0, 2).join('.')}${isVisible(el) ? '' : '(hid)'}`)
    const cb = creditPayButton()
    const credit = cb ? ` · 普通支付 ${cb.tagName.toLowerCase()}[${isVisible(cb) ? 'vis' : 'hid'},${isDisabledButton(cb) ? 'dis' : 'on'}] zone=${(cb.closest('[class*="operate-zone"]') || {}).className ? String(cb.closest('[class*="operate-zone"]').className).slice(0, 30) + '/' + (cb.closest('[class*="operate-zone"]').getAttribute('data-channel') || '-') : '-'}` : ' · 普通支付 없음'
    return `pay-btn ${all.length}개: ${parts.join(' | ') || '없음'}${credit}${other.length ? ' · 다른 立即付款: ' + other.join(', ') : ''}`.slice(0, 200)
  }

  function worldpayCard() {
    return channelCard(C.WORLDPAY_CHANNEL)
  }

  /** 🆕 0.6.0 결제 수단 카드 하나(일반결제 구역 · 조합결제 안 제외) */
  function channelCard(code) {
    return normalChannelCards().find((el) => el.getAttribute('data-channel') === code) || null
  }

  /** 🆕 0.6.0 외상 카드의 남은 한도(分 · 못 읽으면 null) */
  function readCreditLimitFen() {
    const el = channelCard(C.CREDIT_CHANNEL)
    return el ? Core.parseCreditLimitFen(el.textContent || '') : null
  }

  /** 결제 페이지 한 장면 */
  function readSnapshot() {
    const text = pageText()
    const channels = readChannels()
    const btn = readPayButton()
    const totalTexts = Array.from(document.querySelectorAll(S.priceInfoItem)).map((el) => el.textContent)
    return {
      pageKind: Core.pageKindOf(location.href),
      sessionExpired: text.includes(C.TEXT.sessionExpired),
      loginPrompt: text.includes(C.TEXT.loginPrompt),
      rendered: channels.length > 0 || btn.present,
      channels,
      model: readServerModel(),
      operateZoneChannels: Array.from(document.querySelectorAll(S.operateZone)).map((el) => el.getAttribute('data-channel') || ''),
      currency: readCurrency(),
      domOrderTotalFens: Core.extractOrderTotalFens(totalTexts),
      payButton: btn,
      creditPayButton: readButton(creditPayButton()), // 🆕 0.6.3 외상 «普通支付»
      creditLimitFen: readCreditLimitFen(),
      // 🆕 0.6.2 외상 금액(«确认收货后付款 ¥…») — 외상 카드 자신의 글(«确认收货后付款» 설명)은 빼고 금액이 붙은 것만 잡힘
      creditDueFens: Core.extractCreditDueFens(text),
      pageOrderTotalFens: Core.extractPageOrderTotalFens(text), // 🆕 0.6.4 외상 화면의 订单总金额(칸 밖)
      orderNos: Core.extractOrderNos(text),
      url: Core.parseCashierUrl(location.href),
    }
  }

  /** 누르려는 요소의 모양 — core.js#isClickAllowed 가 판정합니다. */
  function describeElement(el) {
    if (!el || el.nodeType !== 1) return null
    const card = el.closest('.channel-card')
    const zone = el.closest(S.operateZone)
    return {
      closestChannel: card ? card.getAttribute('data-channel') || '' : null,
      insideCombCard: !!el.closest(S.combCard),
      isChannelCard: el.matches(S.channelCard),
      insideCurrencyTab: !!el.closest(S.currencyTab),
      text: Core.normalizeText(el.textContent),
      isPayButton: el.matches(S.payButton) || isCreditPayButton(el),
      operateZoneChannel: zone ? zone.getAttribute('data-channel') : null,
      pageKind: Core.pageKindOf(location.href),
    }
  }

  root.ChibizWorldpayPage = Object.freeze({ BANNER_ATTR, pageText, readSnapshot, readServerModel, describeElement, findCnyOption, payButton, worldpayCard, channelCard, describePayButtons, describeChannels, creditPayButton })
})(globalThis)
