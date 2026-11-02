/*
 * 🆕 0.7.0 하나은행 빠른조회 → 입금 내역 수집 (J 지시 2026-10-29)
 *
 * 흐름: 관리자가 계좌번호·비밀번호·사업자번호를 직접 넣고 한 번 조회 → 이 패널의 [실행] →
 *       그 뒤 BANK.intervalMinMs~intervalMaxMs(10~15분 임의) 간격으로 화면의 조회 함수(pbk.quickService.acctInquiry.submitInquiry)를 다시 불러
 *       결과 표를 읽고 background(BANK_DEPOSITS) → 로컬 에이전트(http://127.0.0.1:18080/deposits) → MySQL.
 *
 * 실측(2026-10-29): 폼을 그대로 HTTP 재전송하면 WEBK00038 로 거절되지만, 화면 함수로 다시 제출하면 암호화 값이
 * 새로 서명되어 성공한다. 그래서 반드시 화면 함수를 부른다. 탭을 닫거나 세션이 끊기면 다시 입력해야 한다.
 *
 * 🔴 비밀번호·사업자번호는 절대 읽지도 보내지도 않는다. 읽는 건 결과 표와 화면에 표시된 계좌번호(끝 4자리만 보관)뿐.
 */
;(function () {
  'use strict'
  const C = globalThis.ChibizDepositConfig
  const B = C.BANK
  const STATE_KEY = 'chibiz-bank-collector'

  let timer = null
  let running = false
  let lastRun = null
  let lastSent = 0
  let lastError = ''
  let sentKeys = new Set()
  let consecutiveFail = 0
  let lastConditionNote = ''
  let nextRunAt = null
  /** (0.1.7) 새 코드가 이 탭에 다시 주입되면 옛 인스턴스는 여기가 true 가 되어 아무것도 안 한다 */
  let dead = false
  /** 실행 중 여부를 탭(sessionStorage)에 남겨, 코드만 다시 읽혀도(탭은 그대로) 새 인스턴스가 이어서 돌게 한다 */
  const RUNNING_KEY = 'chibiz-bank-running'
  /** (0.1.9) 사용자가 패널의 [중지]를 눌렀으면 자동 시작하지 않는다([실행]을 누르면 풀림) */
  let userStopped = false
  /**
   * (0.1.10) 실패로 자동 정지했을 때의 결과 표. 이 표가 그대로인 동안은 자동 시작하지 않는다 —
   * 관리자가 다시 [조회]해서 표가 새로 그려지거나(= 요소가 바뀜) [실행]을 눌러야 다시 돈다. 실패-재시작이 1초마다 도는 것을 막는다.
   */
  let blockedTable = null
  /** (0.1.11) 멈춤 표시를 탭(sessionStorage)에도 남긴다: 'user'([중지]) · 'auto'(실패) — 코드 새로고침으로 새 인스턴스가 와도 멈춤이 풀리지 않게 */
  const STOPPED_KEY = 'chibiz-bank-stopped'
  // (0.1.12) 멈춤 표시는 «이 문서»에만 묶는다(값에 페이지 로드 시각을 붙임). 페이지를 새로 불러오면(= 계좌 정보 다시 넣고 조회) 멈춤이 풀린다.
  const DOC_ID = String(Math.round(performance.timeOrigin || 0))
  function setStopped(kind) {
    try { kind ? sessionStorage.setItem(STOPPED_KEY, kind + '@' + DOC_ID) : sessionStorage.removeItem(STOPPED_KEY) } catch (e) { /* 무시 */ }
  }
  function getStopped() {
    try {
      const v = sessionStorage.getItem(STOPPED_KEY) || ''
      const i = v.indexOf('@')
      if (i < 0) return ''
      if (v.slice(i + 1) !== DOC_ID) { sessionStorage.removeItem(STOPPED_KEY); return '' }
      return v.slice(0, i)
    } catch (e) { return '' }
  }

  // ── 화면 읽기 ──────────────────────────────────────────────────────────────

  function resultTable() {
    return [...document.querySelectorAll('table')].find((t) => /거래일자/.test(t.textContent) && t.querySelector('tbody tr'))
  }

  function num(s) {
    const v = String(s || '').replace(/[^0-9.-]/g, '')
    return v === '' ? null : Number(v)
  }

  /**
   * 조회 결과 머리글 «계좌번호 | 342-910023-37304» 에서 끝 4자리.
   * 입력 폼에도 «계좌번호» 칸이 있어서(입력창이라 글자가 없음) 첫 번째 것을 집으면 빈 값이 된다 —
   * 그래서 «계좌번호» 셀을 모두 보고 옆 칸에 계좌번호 모양(숫자 10자리 이상)이 있는 것만 쓴다. (0.1.4)
   */
  function accountMasked() {
    for (const cell of document.querySelectorAll('th,td')) {
      if (!/^계좌번호\*?$/.test(cell.textContent.trim())) continue
      const v = cell.nextElementSibling ? cell.nextElementSibling.textContent.trim() : ''
      const digits = v.replace(/[^0-9]/g, '')
      if (digits.length >= 10) return '****' + digits.slice(-4)
    }
    return ''
  }

  /** 표 → 행 목록. 열 순서는 머리글 이름으로 찾는다(은행이 열을 바꿔도 이름이 같으면 동작). */
  function readRows() {
    const t = resultTable()
    if (!t) return null
    const heads = [...t.querySelectorAll('thead th, tr:first-child th')].map((h) => h.textContent.trim())
    const idx = (name) => heads.findIndex((h) => h.replace(/\s/g, '') === name)
    const iDate = idx('거래일자'), iKind = idx('구분'), iMemo = idx('적요'), iIn = idx('입금액'), iOut = idx('출금액'),
      iBal = idx('잔액'), iTime = idx('거래시간'), iBranch = idx('거래점')
    if (iDate < 0 || iIn < 0 || iBal < 0) return null
    const acct = accountMasked()
    const rows = []
    for (const tr of t.querySelectorAll('tbody tr')) {
      const td = [...tr.children].map((e) => e.textContent.trim())
      if (td.length < heads.length) continue
      const row = {
        txDate: td[iDate],
        txTime: iTime >= 0 ? td[iTime] : '',
        kind: iKind >= 0 ? td[iKind] : '',
        memo: iMemo >= 0 ? td[iMemo] : '',
        depositAmount: num(td[iIn]) || 0,
        withdrawAmount: iOut >= 0 ? num(td[iOut]) || 0 : 0,
        balance: num(td[iBal]),
        branch: iBranch >= 0 ? td[iBranch] : '',
        accountMasked: acct,
        rawText: td.join(' | '),
      }
      if (!row.txDate) continue
      row.key = [row.txDate, row.txTime, row.depositAmount, row.withdrawAmount, row.balance, row.memo].join('|')
      rows.push(row)
    }
    return rows
  }

  // ── 재조회 ─────────────────────────────────────────────────────────────────

  function form() {
    return document.forms['frmQuickInquiry']
  }

  /** 페이지 세계의 다리(page-bridge.js)에 명령을 보내고 응답을 기다린다. 콘텐츠 스크립트는 pbk.* 를 직접 못 부른다. */
  function pageCmd(cmd, n) {
    return new Promise((resolve, reject) => {
      const id = String(Date.now()) + Math.random().toString(36).slice(2, 7)
      const timer = setTimeout(() => {
        document.removeEventListener('chibiz-bank-ack', onAck)
        reject(new Error('페이지 다리 응답 없음(page-bridge)'))
      }, 3000)
      function onAck(e) {
        let d = {}
        try { d = JSON.parse(e.detail || '{}') } catch (err) { d = {} }
        if (d.id !== id) return
        clearTimeout(timer)
        document.removeEventListener('chibiz-bank-ack', onAck)
        if (d.ok) resolve(true)
        else reject(new Error(d.error || '페이지 명령 실패'))
      }
      document.addEventListener('chibiz-bank-ack', onAck)
      document.dispatchEvent(new CustomEvent('chibiz-bank-cmd', { detail: JSON.stringify({ id, cmd, n }) }))
    })
  }

  function bridgeReady() {
    return document.documentElement.getAttribute('data-chibiz-bank-bridge') === 'ready'
  }

  function canRequery() {
    // 비밀번호·계좌번호 칸은 보안 키패드가 값을 숨길 수 있어 보지 않는다. 결과 표가 한 번 그려졌고(=조회 성공) 페이지 다리가 준비됐으면 된다.
    return !!(form() && bridgeReady() && resultTable())
  }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  /**
   * 조회 조건을 «어제~오늘 · 입금내역 · 60건» 으로 맞춘다. 매번 다시 넣는다(자정이 지나면 날짜가 바뀌므로).
   * J 지시(2026-10-29): 어제까지 포함 — 23:58 에 돌고 다음 회차가 자정 뒤면 23:59 입금을 «오늘만» 조회로는 못 본다.
   * 최신순 60건이라 어제+오늘 입금이 60건을 넘으면 어제 앞부분은 빠지지만, 그건 이미 앞 회차에서 저장됐다.
   */
  function setConditions() {
    const f = form()
    // 현재 시각(Date)으로 어제·오늘을 계산해 화면 날짜 칸과 비교하고, 다를 때만 다시 넣는다(J 지시 2026-10-29)
    const now = new Date()
    const want = { from: ymd(new Date(now.getTime() - 24 * 60 * 60 * 1000)), to: ymd(now) }
    const have = { from: f.inqStrDt ? f.inqStrDt.value : '', to: f.inqEndDt ? f.inqEndDt.value : '' }
    const changed = []
    if (have.from !== want.from && f.inqStrDt) {
      f.inqStrDt.value = want.from
      changed.push('시작 ' + have.from + '→' + want.from)
    }
    if (have.to !== want.to && f.inqEndDt) {
      f.inqEndDt.value = want.to
      changed.push('종료 ' + have.to + '→' + want.to)
    }
    if (f.rcvWdrwDvCd && f.rcvWdrwDvCd.value !== '1') { f.rcvWdrwDvCd.value = '1'; changed.push('입금내역') }
    if (f.listSize && f.listSize.value !== '60') { f.listSize.value = '60'; changed.push('60건') }
    if (f.rvSeqInqYn && f.rvSeqInqYn.value !== 'Y') { f.rvSeqInqYn.value = 'Y'; changed.push('최근순') }
    if (f.cntnTrscDat) f.cntnTrscDat.value = ''
    lastConditionNote = changed.length ? '조건 바꿈: ' + changed.join(', ') : '조건 그대로 (' + want.from + '~' + want.to + ')'
    return changed.length > 0
  }

  /** 다음 실행까지 10~15분 사이 임의 시간(J 지시 2026-10-29: 일정한 간격으로 두지 않음) */
  function nextDelayMs() {
    const span = B.intervalMaxMs - B.intervalMinMs
    return B.intervalMinMs + Math.floor(Math.random() * (span + 1))
  }

  function scheduleNext() {
    if (!running || dead) return
    const delay = nextDelayMs()
    nextRunAt = Date.now() + delay
    timer = setTimeout(async () => {
      timer = null
      await runOnce(true)
      scheduleNext()
    }, delay)
    render()
  }

  /** 화면 조회 함수를 부르고, 표가 새로 그려질 때까지 기다린다. */
  async function requery() {
    const f = form()
    setConditions()
    const before = resultTable()
    // (0.1.12) 오류 문구는 «제출 뒤 새로 나타난 글»에서만 찾는다 — 폼 라벨 «계좌비밀번호» 같은 상시 문구에 걸리지 않게.
    const beforeLines = new Set(bodyLines())
    await pageCmd('submit')
    const until = Date.now() + B.requeryTimeoutMs
    while (Date.now() < until) {
      await sleep(500)
      const loading = document.querySelector('img[src*="Loading"]')
      const t = resultTable()
      const fresh = bodyLines().filter((l) => !beforeLines.has(l)).join('\n')
      const errText = (fresh.match(/시스템 장애중|잠시후 다시|비밀번호[^\n]{0,40}(오류|일치하지|틀|확인)|횟수[^\n]{0,20}초과|잠금|잠겼|오류가 발생/) || [])[0]
      if (errText) throw new Error(errText)
      if (!loading && t && (t !== before || (before && Date.now() - lastRun > 3000))) {
        // J 지시(2026-10-29): 응답이 돌아온 뒤 5초 더 기다렸다가 표를 읽는다(화면이 다 그려진 뒤 리스트업)
        await sleep(B.settleMs)
        return true
      }
    }
    throw new Error('조회 결과를 시간 안에 받지 못함')
  }

  function bodyLines() {
    return (document.body.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean)
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** 페이지 번호 링크(goContinuousPage(n,…)) 중 현재 페이지보다 큰 번호들 */
  function pageLinks() {
    const out = []
    for (const a of document.querySelectorAll('a[onclick*="goContinuousPage"]')) {
      const m = /goContinuousPage\((\d+)/.exec(a.getAttribute('onclick') || '')
      if (m) out.push({ page: Number(m[1]), el: a })
    }
    return out
  }

  function currentPage() {
    const mark = [...document.querySelectorAll('strong,span,a')].find((e) => /^\d+$/.test(e.textContent.trim()) && /on|active|current|sel/.test(e.className || ''))
    return mark ? Number(mark.textContent.trim()) : 1
  }

  /** 페이지를 넘기고 표가 바뀔 때까지 기다린다(실측 2026-10-29: goContinuousPage(n,'frmQuickInquiry','searchBtn')). */
  async function goPage(n) {
    const before = resultTable()
    const beforeFirst = before ? before.querySelector('tbody tr').textContent : ''
    await pageCmd('page', n)
    const until = Date.now() + B.requeryTimeoutMs
    while (Date.now() < until) {
      await sleep(500)
      const loading = document.querySelector('img[src*="Loading"]')
      const t = resultTable()
      if (!loading && t && t.querySelector('tbody tr').textContent !== beforeFirst) {
        await sleep(B.settleMs) // 페이지도 응답 뒤 5초 쉬고 읽는다
        return true
      }
    }
    throw new Error(n + '페이지를 시간 안에 받지 못함')
  }

  /**
   * 1페이지(지금 화면)부터 다음 페이지들을 차례로 읽어 전부 모은다.
   * 어제~오늘 조회는 보통 1페이지지만, 60건을 넘으면 2·3페이지에 어제 입금이 있으므로 끝까지 본다(최대 B.maxPages).
   */
  async function readAllPages() {
    const all = []
    const seen = new Set()
    const take = (rows) => {
      for (const r of rows || []) {
        if (!seen.has(r.key)) {
          seen.add(r.key)
          all.push(r)
        }
      }
    }
    const first = readRows()
    if (!first) return null
    take(first)
    let pages = 1
    while (pages < B.maxPages) {
      const cur = currentPage()
      const next = pageLinks().filter((p) => p.page > cur).sort((a, b) => a.page - b.page)[0]
      if (!next) break
      await goPage(next.page)
      take(readRows())
      pages++
    }
    if (pages > 1) {
      // 다음 회차가 1페이지부터 다시 조회하므로 되돌릴 필요는 없음
    }
    return all
  }

  // ── 전송 ───────────────────────────────────────────────────────────────────

  async function send(rows) {
    const fresh = rows.filter((r) => !sentKeys.has(r.key))
    if (fresh.length === 0) return 0
    const res = await chrome.runtime.sendMessage({ type: 'BANK_DEPOSITS', rows: fresh, fetchedAt: new Date().toISOString() })
    if (!res || !res.ok) throw new Error((res && res.reason) || '에이전트 전송 실패')
    for (const r of fresh) sentKeys.add(r.key)
    if (sentKeys.size > 5000) sentKeys = new Set([...sentKeys].slice(-2000))
    return res.inserted != null ? res.inserted : fresh.length
  }

  /** 실행 1회의 결과를 에이전트 collect_run 표에 남긴다(30일 연속 수집 시험: 언제부터 실패했는지 보려고). */
  function logRun(ok, rowsRead, inserted, error) {
    try {
      chrome.runtime.sendMessage({ type: 'BANK_RUN', ok, rowsRead, inserted, error: error || '', at: new Date().toISOString(), accountMasked: accountMasked() }).catch(() => {})
    } catch (e) {
      // 익스텐션이 다시 읽힌 뒤의 옛 인스턴스(컨텍스트 무효) — 무시
    }
  }

  /** (0.1.5) [실행] 때 «이 탭은 어느 계좌를 조회하는지»를 에이전트에 알린다 → 에이전트 화면의 «수집 연결» 줄 */
  function hello() {
    try {
      chrome.runtime.sendMessage({ type: 'BANK_HELLO', accountMasked: accountMasked(), at: new Date().toISOString() }).catch(() => {})
    } catch (e) {
      // 옛 인스턴스 — 무시
    }
  }

  async function runOnce(withRequery) {
    const t0 = Date.now()
    try {
      if (withRequery) await requery()
      const rows = await readAllPages()
      if (!rows) throw new Error('결과 표가 없습니다 — 먼저 조회하세요')
      const n = await send(rows)
      lastRun = Date.now()
      lastSent += n
      lastError = ''
      consecutiveFail = 0
      render()
      logRun(true, rows.length, n, '')
    } catch (e) {
      lastError = (e && e.message) || String(e)
      consecutiveFail++
      render()
      logRun(false, 0, 0, lastError + ' (' + Math.round((Date.now() - t0) / 1000) + 's)')
      // (0.1.10) 비밀번호 오류는 한 번이면 바로 멈춘다 — 은행의 비밀번호 오류 횟수 제한(계좌 잠김)에 걸리지 않게. 다시 [조회]할 때까지 자동 시작도 안 한다.
      if (/비밀번호|횟수|잠금|잠겼/.test(lastError)) {
        autoStop('비밀번호 오류로 멈춤 — 계좌 정보를 다시 넣고 [조회]하세요 (반복하면 계좌가 잠깁니다): ' + lastError)
        return
      }
      // stopAfterFails 0 = 멈추지 않고 다음 주기에 다시 시도(연속 수집 시험용)
      if (B.stopAfterFails > 0 && consecutiveFail >= B.stopAfterFails) autoStop('연속 ' + consecutiveFail + '회 실패 — 다시 입력하고 [조회]')
    }
  }

  function start() {
    if (running) return
    if (!canRequery()) {
      lastError = bridgeReady() ? '계좌번호·비밀번호·사업자번호를 넣고 [조회]를 눌러 결과 표가 보인 뒤 [실행]을 누르세요' : '페이지 다리가 아직 준비되지 않았습니다 — 탭을 새로고침한 뒤 다시 조회하세요'
      render()
      return
    }
    running = true
    lastError = ''
    setStopped(null)
    try { sessionStorage.setItem(RUNNING_KEY, '1') } catch (e) { /* 무시 */ }
    render()
    hello()
    // [실행] 은 항상 «어제~오늘 · 입금내역 · 60건» 으로 다시 조회한 결과를 읽는다(화면에 남은 표가 다른 조건일 수 있으므로)
    runOnce(true).then(scheduleNext)
  }

  function stop(reason) {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
    nextRunAt = null
    if (reason) lastError = reason
    if (!dead) {
      try { sessionStorage.removeItem(RUNNING_KEY) } catch (e) { /* 무시 */ }
    }
    render()
  }

  /** 실패로 멈춤: 지금 결과 표를 기억해 두고, 표가 새로 그려질 때까지 자동 시작을 막는다 */
  function autoStop(reason) {
    blockedTable = resultTable() || document.body
    setStopped('auto')
    stop(reason)
  }

  /**
   * (0.1.7) 익스텐션이 다시 읽혀 새 코드가 이 탭에 주입되면(background onInstalled → scripting.executeScript) 새 인스턴스가 이 이벤트를 쏜다.
   * 옛 인스턴스는 타이머를 끊고 패널을 치우고 죽는다. 탭은 새로고침하지 않으므로 입력해 둔 계좌 정보와 조회 결과가 남는다.
   */
  function onTakeover() {
    if (dead) return
    dead = true
    if (timer) clearTimeout(timer)
    timer = null
    running = false
    if (panel) {
      panel.remove()
      panel = null
    }
  }

  // ── 패널 ───────────────────────────────────────────────────────────────────

  let panel = null

  function render() {
    if (dead) return
    if (!panel) {
      panel = document.createElement('div')
      panel.id = STATE_KEY
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:2px solid #0d9488;border-radius:8px;padding:10px 12px;font:13px/1.5 sans-serif;color:#111;box-shadow:0 4px 14px rgba(0,0,0,.2);min-width:260px'
      document.body.appendChild(panel)
    }
    const fmt = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour12: false }) : '-')
    panel.innerHTML = ''
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:700;margin-bottom:6px'
    const acct = accountMasked()
    title.textContent = '차이비즈 입금 수집' + (acct ? ' ' + acct : '') + ' ' + (running ? '● 실행 중' : '○ 대기')
    const info = document.createElement('div')
    info.style.cssText = 'color:#444;white-space:pre-line;margin-bottom:8px'
    info.textContent = '재조회 ' + Math.round(B.intervalMinMs / 60000) + '~' + Math.round(B.intervalMaxMs / 60000) + '분 임의 · 에이전트 ' + B.agentUrl.replace(/^https?:\/\//, '')
      + '\n마지막 전송 ' + fmt(lastRun) + ' · 누적 ' + lastSent + '건 · 다음 ' + fmt(nextRunAt)
      + (lastConditionNote ? '\n' + lastConditionNote : '')
    const err = document.createElement('div')
    err.style.cssText = 'color:#b91c1c;white-space:pre-line;margin-bottom:8px;' + (lastError ? '' : 'display:none')
    err.textContent = lastError
    const btn = document.createElement('button')
    btn.textContent = running ? '중지' : '실행'
    btn.style.cssText = 'padding:6px 14px;border:0;border-radius:6px;color:#fff;cursor:pointer;background:' + (running ? '#6b7280' : '#0d9488')
    btn.addEventListener('click', () => {
      if (running) {
        userStopped = true
        setStopped('user')
        stop('')
      } else {
        userStopped = false
        blockedTable = null
        setStopped(null)
        start()
      }
    })
    const once = document.createElement('button')
    once.textContent = '지금 1회'
    once.style.cssText = 'margin-left:8px;padding:6px 10px;border:1px solid #0d9488;border-radius:6px;background:#fff;color:#0d9488;cursor:pointer'
    once.addEventListener('click', () => runOnce(!!resultTable()))
    panel.append(title, info, err, btn, once)
  }

  function init() {
    if (!/\/flex\/quick\/quickService\.do/.test(location.pathname)) return
    // 옛 인스턴스가 있으면 물려받는다(코드 새로고침 때). 옛 패널은 옛 인스턴스가 치우지만, 혹시 남아 있으면 여기서도 치운다.
    // 이벤트는 동기라서 리스너를 먼저 달면 자기 이벤트에 자기가 죽는다(0.1.7 첫 판 버그) — 쏜 뒤에 단다.
    document.dispatchEvent(new CustomEvent('chibiz-bank-takeover'))
    document.addEventListener('chibiz-bank-takeover', onTakeover)
    const stale = document.getElementById(STATE_KEY)
    if (stale) stale.remove()
    render()
    // (0.1.9) 자동 시작: 관리자가 은행의 [조회]를 눌러 결과 표가 뜨면(= canRequery) 패널의 [실행]을 누르지 않아도 시작한다.
    // 코드 새로고침 뒤 이어서 실행하는 것도 같은 길로 된다(표가 그대로 있으므로). [중지]를 누른 탭은 다시 [실행]을 누를 때까지 가만히 둔다.
    // (0.1.11) 옛 인스턴스가 멈춰 있었으면 그 멈춤을 이어받는다 — [중지]면 [실행]까지, 실패면 다시 [조회]까지 자동 시작 안 함
    const stoppedKind = getStopped()
    if (stoppedKind === 'user') userStopped = true
    else if (stoppedKind === 'auto') { blockedTable = resultTable() || document.body; lastError = '실패로 멈춘 상태 — 계좌 정보를 다시 넣고 [조회]하세요'; render() }
    setInterval(() => {
      if (dead || running || userStopped) return
      if (!canRequery()) return
      // 실패로 멈춘 뒤 표가 그대로면 기다린다(관리자가 다시 [조회]하면 표 요소가 바뀐다)
      if (blockedTable && resultTable() === blockedTable) return
      blockedTable = null
      start()
    }, 1000)
    // 패널이 뜨면 조회 조건을 미리 «어제~오늘 · 입금내역 · 60건 · 최근순» 으로 맞춰 둔다(관리자는 계좌 정보만 넣고 [조회]).
    // 페이지 스크립트가 늦게 기본값을 덮어쓸 수 있어 조금 뒤 한 번 더 맞춘다.
    const preset = () => { try { if (form()) setConditions() } catch (e) { /* 폼이 아직 없으면 무시 */ } render() }
    setTimeout(preset, 800)
    setTimeout(preset, 3000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
