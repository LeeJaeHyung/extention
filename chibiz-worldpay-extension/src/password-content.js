/*
 * 알리페이 비밀번호 창(1688 결제 페이지 안 iframe · https://pcauth-site.alipay.com/home) — 티켓 §4-5.
 *
 * 1688 결제 페이지(air.1688.com) 안에 박힌, 우리 결제로 뜬 비밀번호 창인지 background 가 판정(decidePasswordStep)합니다.
 *
 * 🆕 0.4.0 자동 입력(사용자 지시 2026-10-22 «서버에 저장된 비밀번호를 받아 자동 기입») — background 가 FILL 이면:
 *   - 비밀번호 칸(PASSWORD_STEP.inputSelectors 중 처음 보이는 것)에 브라우저 기본 setter + input/change 이벤트로 넣음(사람 입력과 같은 길)
 *   - «下一步» 이 켜지면 한 번 누르고 AUTO_SUBMITTED · 그 뒤 틀림 문구가 뜨면 WRONG(🔴 다시 넣지 않음)
 *   - 칸이 없거나, 넣어도 «下一步» 이 안 켜지면(보안 입력이 받지 않음) 🔴 우회하지 않고 칸을 비운 뒤 사람에게 넘김(아래 0.3.0 흐름)
 *   - 받은 값은 넣자마자 변수에서 지움 · 저장·로그·콘솔 0
 * 그 밖(MANUAL) — 0.3.0 그대로 «직접 입력해 주세요»: 사람이 «下一步» 을 누르면 USER_SUBMITTED · 틀림 WRONG · 끝까지 안 누르면 MANUAL_TIMEOUT.
 * 🔴 입력칸의 값은 읽지 않습니다. iframe 주소의 쿼리(세션 값)는 읽지 않습니다. 저장·로그·콘솔 금지.
 */
;(function (root) {
  'use strict'
  if (window.top === window) return
  if (root.__chibizWorldpayPasswordStarted) return
  root.__chibizWorldpayPasswordStarted = true

  const C = root.ChibizWorldpayConfig
  const Core = root.ChibizWorldpayCore
  const P = C.PASSWORD_STEP

  const frame = {
    isTop: false,
    origin: location.origin,
    pathname: location.pathname,
    parentOrigin: location.ancestorOrigins && location.ancestorOrigins.length ? location.ancestorOrigins[0] : null,
    ancestorOrigins: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [],
  }
  // 알리페이를 직접 연 탭·다른 상위 페이지 → 아무것도 안 함
  if (!Core.isPasswordFrame(frame)) return

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res || null))
      } catch (e) {
        resolve(null)
      }
    })
  }

  function dialogTitle() {
    const t = document.body ? document.body.innerText || document.body.textContent || '' : ''
    return t.slice(0, 2000)
  }

  /** «下一步» 글자를 가진 가장 안쪽 요소(읽기용 — 누르지 않습니다) */
  function nextButton() {
    for (const el of document.querySelectorAll('button, [role=button], a, div, span')) {
      if (Core.normalizeText(el.textContent) !== P.nextButtonText) continue
      if ([...el.children].some((c) => Core.normalizeText(c.textContent) === P.nextButtonText)) continue
      return el
    }
    return null
  }

  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        observer.disconnect()
        clearInterval(poll)
        clearTimeout(timer)
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
      const observer = new MutationObserver(check)
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      const poll = setInterval(check, 200)
      const timer = setTimeout(() => finish(null), timeoutMs)
      check()
    })
  }

  async function run() {
    // 제목이 그려질 때까지
    // 🆕 0.4.4 — 제목 글자(여러 판본) 또는 비밀번호 칸이 보이면 진행
    await waitFor(() => Core.isPasswordTitle(dialogTitle()) || !!passwordInput(), P.titleWaitMs)
    const gate = await send({ type: 'PASSWORD_REQUEST', frame, dialogTitle: dialogTitle(), hasPasswordInput: !!passwordInput() })
    if (!gate || gate.verdict === 'NONE') return // 우리 창이 아님 — 아무것도 안 함
    if (gate.verdict === 'FILL' && typeof gate.password === 'string') {
      const filled = await autoFill(gate.password)
      gate.password = null
      if (filled === 'SUBMITTED') {
        await send({ type: 'PASSWORD_RESULT', result: 'AUTO_SUBMITTED' })
        await watchAfterSubmit()
        return
      }
      // 자동 입력 못 함 — 사람에게 넘김(띠 문구에 까닭)
      await send({ type: 'PASSWORD_RESULT', result: 'MANUAL', reason: filled })
    }
    // 사람이 직접 입력. background 가 상위 탭에 «직접 입력해 주세요» 띠를 보냈습니다.
    //    여기서는 사람이 «下一步» 을 누르는지만 지켜봅니다(누름 = USER_SUBMITTED).
    const btn = nextButton()
    if (!btn) {
      await send({ type: 'PASSWORD_RESULT', result: 'MANUAL', reason: 'USER_INPUT' })
      return
    }
    const clicked = await waitForClick(btn, P.userSubmitWatchMs)
    if (!clicked) {
      await send({ type: 'PASSWORD_RESULT', result: 'MANUAL_TIMEOUT' })
      return
    }
    await send({ type: 'PASSWORD_RESULT', result: 'USER_SUBMITTED' })
    // 사람이 누른 «下一步» 뒤 틀림 문구 → WRONG · 🆕 0.5.0 완료 글자 → PAY_SUCCESS_SEEN
    await watchAfterSubmit()
  }

  /** 🆕 0.5.0 «下一步» 뒤 — 틀림 문구면 WRONG, 결제 완료 글자면 PAY_SUCCESS_SEEN(창이 닫혀 상위 페이지에 뜨는 경우는 result-content 가 봄) */
  async function watchAfterSubmit() {
    const hit = await waitFor(() => {
      const t = dialogTitle()
      if (Core.hasPasswordError(t)) return { wrong: true }
      const ok = Core.findSuccessText(t)
      if (ok) return { ok, summary: Core.parseSuccessSummary(t) }
      const fail = Core.findFailText(t)
      return fail ? { fail } : null
    }, Math.max(P.errorWatchMs, 60 * 1000))
    if (hit && hit.wrong) await send({ type: 'PASSWORD_RESULT', result: 'WRONG' })
    else if (hit && hit.ok) await send({ type: 'PAY_SUCCESS_SEEN', text: hit.ok, summary: hit.summary })
    else if (hit && hit.fail) await send({ type: 'PAY_FAIL_SEEN', text: hit.fail })
  }

  /** 보이는 비밀번호 칸 하나(후보 순서대로 · 없으면 null) */
  function passwordInput() {
    for (const sel of P.inputSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.disabled || el.readOnly) continue
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) return el
      }
    }
    return null
  }

  function isEnabled(btn) {
    if (!btn) return false
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false
    return !/\bdisabled\b/i.test(String(btn.className || ''))
  }

  /** 칸에 값 넣기 — 브라우저 기본 setter + input/change(사람 입력과 같은 길) */
  function setInputValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    el.focus()
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * 🆕 0.4.0 자동 입력 — 'SUBMITTED' | 'NO_INPUT' | 'FILL_REJECTED'.
   * 🔴 «下一步» 이 켜지지 않으면 우회하지 않고 칸을 비웁니다. 누르기는 한 번만.
   */
  async function autoFill(password) {
    const input = passwordInput()
    if (!input) return 'NO_INPUT'
    setInputValue(input, password)
    password = null
    const btn = await waitFor(() => {
      const b = nextButton()
      return isEnabled(b) ? b : null
    }, P.enableWaitMs)
    if (!btn) {
      setInputValue(input, '')
      return 'FILL_REJECTED'
    }
    btn.click()
    return 'SUBMITTED'
  }

  /** 사람이 요소(또는 그 안)를 누를 때까지 — 시한이 지나면 false. 읽기만(preventDefault 없음). */
  function waitForClick(el, timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        document.removeEventListener('click', onClick, true)
        clearTimeout(timer)
        resolve(v)
      }
      const onClick = (e) => {
        const t = e.target
        if (el === t || (el.contains && t && el.contains(t)) || Core.normalizeText(t && t.textContent) === P.nextButtonText) finish(true)
      }
      document.addEventListener('click', onClick, true)
      const timer = setTimeout(() => finish(false), timeoutMs)
    })
  }

  run().catch(() => {
    // 조용히 — 비밀번호 창에서는 어떤 상황에서도 값을 남기지 않습니다.
  })
})(globalThis)
