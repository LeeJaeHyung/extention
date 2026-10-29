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

  // ── 화면 읽기 ──────────────────────────────────────────────────────────────

  function resultTable() {
    return [...document.querySelectorAll('table')].find((t) => /거래일자/.test(t.textContent) && t.querySelector('tbody tr'))
  }

  function num(s) {
    const v = String(s || '').replace(/[^0-9.-]/g, '')
    return v === '' ? null : Number(v)
  }

  function accountMasked() {
    const cell = [...document.querySelectorAll('th,td')].find((e) => /^계좌번호$/.test(e.textContent.trim()))
    const v = cell && cell.nextElementSibling ? cell.nextElementSibling.textContent.trim() : ''
    const digits = v.replace(/[^0-9]/g, '')
    return digits ? '****' + digits.slice(-4) : ''
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

  function canRequery() {
    const f = form()
    const fn = globalThis.pbk && globalThis.pbk.quickService && globalThis.pbk.quickService.acctInquiry
      && globalThis.pbk.quickService.acctInquiry.submitInquiry
    return !!(f && fn && f.acctNo && f.acctNo.value && f.acctPw && f.acctPw.value)
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
    if (!running) return
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
    globalThis.pbk.quickService.acctInquiry.submitInquiry(f)
    const until = Date.now() + B.requeryTimeoutMs
    while (Date.now() < until) {
      await sleep(500)
      const loading = document.querySelector('img[src*="Loading"]')
      const t = resultTable()
      const errText = (document.body.innerText.match(/시스템 장애중|잠시후 다시|비밀번호.*오류|오류가 발생/) || [])[0]
      if (errText) throw new Error(errText)
      if (!loading && t && (t !== before || (before && Date.now() - lastRun > 3000))) {
        // J 지시(2026-10-29): 응답이 돌아온 뒤 5초 더 기다렸다가 표를 읽는다(화면이 다 그려진 뒤 리스트업)
        await sleep(B.settleMs)
        return true
      }
    }
    throw new Error('조회 결과를 시간 안에 받지 못함')
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
    if (typeof globalThis.goContinuousPage !== 'function') throw new Error('페이지 함수 없음')
    globalThis.goContinuousPage(n, 'frmQuickInquiry', 'searchBtn')
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
    chrome.runtime.sendMessage({ type: 'BANK_RUN', ok, rowsRead, inserted, error: error || '', at: new Date().toISOString() }).catch(() => {})
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
      // stopAfterFails 0 = 멈추지 않고 다음 주기에 다시 시도(연속 수집 시험용)
      if (B.stopAfterFails > 0 && consecutiveFail >= B.stopAfterFails) stop('연속 ' + consecutiveFail + '회 실패 — 다시 입력하고 [실행]')
    }
  }

  function start() {
    if (running) return
    if (!canRequery()) {
      lastError = '계좌번호·비밀번호·사업자번호를 넣고 한 번 조회한 뒤 [실행]을 누르세요'
      render()
      return
    }
    running = true
    lastError = ''
    render()
    runOnce(!resultTable()).then(scheduleNext)
  }

  function stop(reason) {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
    nextRunAt = null
    if (reason) lastError = reason
    render()
  }

  // ── 패널 ───────────────────────────────────────────────────────────────────

  let panel = null

  function render() {
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
    btn.addEventListener('click', () => (running ? stop('') : start()))
    const once = document.createElement('button')
    once.textContent = '지금 1회'
    once.style.cssText = 'margin-left:8px;padding:6px 10px;border:1px solid #0d9488;border-radius:6px;background:#fff;color:#0d9488;cursor:pointer'
    once.addEventListener('click', () => runOnce(!!resultTable()))
    panel.append(title, info, err, btn, once)
  }

  function init() {
    if (!/\/flex\/quick\/quickService\.do/.test(location.pathname)) return
    render()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
