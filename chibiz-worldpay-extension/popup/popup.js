/* 팝업 — 설정(chrome.storage.local) · 대기 작업/최근 결과(chrome.storage.session) 보기 */
;(function () {
  'use strict'
  const C = globalThis.ChibizWorldpayConfig
  const Core = globalThis.ChibizWorldpayCore
  const $ = (id) => document.getElementById(id)

  const OUTCOME = {
    PAID_SUBMITTED: ['결제 버튼 누름', 't-ok'],
    BLOCKED: ['멈춤(조건 미달·시험·준비)', 't-stop'],
    PASSWORD_FAILED: ['비밀번호 단계 실패', 't-stop'],
    SESSION_EXPIRED: ['1688 로그인 안 됨', 't-stop'],
    ERROR: ['오류', 't-stop'],
  }

  function time(ms) {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  async function getSettings() {
    const got = await chrome.storage.local.get('settings')
    return Object.assign({}, C.DEFAULT_SETTINGS, got.settings || {})
  }

  function renderMode(s) {
    const el = $('mode')
    const f = Core.finalAction(s)
    if (f === 'DRY_RUN') {
      el.className = 'mode dry'
      el.textContent = '시험 모드 — 결제 버튼을 누르지 않습니다'
    } else if (f === 'PREPARE_ONLY') {
      el.className = 'mode prep'
      el.textContent = '준비만 — 결제 버튼은 직접 누르세요'
    } else {
      el.className = 'mode live'
      el.textContent = '켜짐 — 조건이 모두 맞으면 결제 버튼(立即付款)을 누릅니다'
    }
  }

  const CLAIM_TEXT = {
    JOB: '작업 받음 — 결제 페이지를 열었습니다',
    NONE: '가져갈 작업 없음',
    KEY_ERROR: '키 오류 — 서버가 익스텐션 키를 받지 않습니다(401)',
    DISABLED: '서버 자동 결제 꺼짐(503)',
    ERROR: '서버에 닿지 못함',
  }
  const REPORT_TEXT = { PENDING: '서버 보고 대기', RETRY: '서버 보고 다시 시도 중', SENT: '서버 보고됨', GIVE_UP: '서버가 거절(다시 보내지 않음)' }
  const HALT_TEXT = {
    SESSION_EXPIRED: '1688 로그인이 풀려 멈췄습니다 — 주계정(jungpan88)으로 로그인한 뒤 «다시 시작»',
    PASSWORD_FAILED: '비밀번호 틀림으로 멈췄습니다 — 서버도 멈춤(관리자 웹 «다시 시작» 필요) · 확인 뒤 «다시 시작»',
  }

  /** 통로 하나(SERVER·TEST)의 상태 줄을 그립니다. */
  async function renderChannel(opts) {
    const s = await getSettings()
    const got = await chrome.storage.session.get(opts.stateKey)
    const st = got[opts.stateKey] || {}
    const box = $(opts.boxId)
    box.textContent = ''
    const line = (text, cls) => {
      const d = document.createElement('div')
      if (cls) d.className = cls
      d.textContent = text
      box.appendChild(d)
    }
    const on = s[opts.setting] === true
    line(`서버 ${opts.baseUrl} · ${on ? `켜짐${opts.period ? `(${opts.period})` : ''}` : '꺼짐'}`)
    if (st.keyError) line('키 오류 — config.js 의 익스텐션 키가 서버 값과 다릅니다', 'bad')
    if (st.halted) line(HALT_TEXT[st.halted.reason] || `멈춤(${st.halted.reason})`, 'bad')
    if (on && s.dryRun) line('시험 모드가 켜져 있어 작업은 결제하지 않고 «BLOCKED(DRY_RUN)» 로 보고됩니다', 'warn')
    if (on && !s.autoClick && !s.dryRun) line('자동 클릭이 꺼져 있어 작업은 «BLOCKED(PREPARE_ONLY)» 로 보고됩니다', 'warn')
    if (st.lastClaimAt) line(`마지막 확인 ${time(st.lastClaimAt)} · ${CLAIM_TEXT[st.lastClaimResult] || st.lastClaimResult || '—'}${st.lastClaimHttp ? ` (HTTP ${st.lastClaimHttp})` : ''}`)
    else line('아직 서버에 확인하지 않았습니다')
    $(opts.resumeId).hidden = !st.halted
    $(opts.claimId).disabled = !on || !!st.halted
  }

  async function renderServer() {
    await renderChannel({ setting: 'serverAutoRun', stateKey: 'autopayState', boxId: 'srv', resumeId: 'resume', claimId: 'claimNow', baseUrl: C.AUTOPAY.SERVER_BASE_URL, period: '1분마다' })
    await renderChannel({ setting: 'testJobRun', stateKey: 'testpayState', boxId: 'testSrv', resumeId: 'testResume', claimId: 'testClaimNow', baseUrl: C.TESTPAY.SERVER_BASE_URL })
  }

  function li(text, tag) {
    const item = document.createElement('li')
    if (tag) {
      const t = document.createElement('span')
      t.className = `tag ${tag[1]}`
      t.textContent = tag[0]
      item.appendChild(t)
    }
    item.appendChild(document.createTextNode(text))
    return item
  }

  async function renderLists() {
    const now = Date.now()
    const got = await chrome.storage.session.get(['worldpayJobs', 'worldpayResults'])
    const jobs = Object.values(got.worldpayJobs || {}).filter((j) => j.state !== 'DONE' && Core.isJobAlive(j, now))
    const ul = $('jobs')
    ul.textContent = ''
    if (!jobs.length) ul.appendChild(Object.assign(li('없음'), { className: 'empty' }))
    for (const j of jobs) {
      const left = Math.max(0, Math.round((C.JOB_TTL_MS - (now - Math.min(j.createdAt, j.receivedAt))) / 60000))
      ul.appendChild(li(`${time(j.receivedAt)} · ${j.orderIds.length}건 · ${Core.formatFen(j.expectedOrderTotalFen)} · ${j.state === 'CLAIMED' ? '결제 페이지 처리 중' : '결제 페이지 기다림'} · 약 ${left}분 남음`))
    }
    const rs = got.worldpayResults || []
    const ur = $('results')
    ur.textContent = ''
    if (!rs.length) ur.appendChild(Object.assign(li('없음'), { className: 'empty' }))
    for (const r of rs) {
      const reason = r.code ? ` · ${Core.STOP_MESSAGES[r.code] || r.code}` : ''
      const srv = r.source === 'SERVER' ? ` · [서버 작업] ${REPORT_TEXT[r.reportStatus] || ''}${r.reportHttp ? ` (HTTP ${r.reportHttp})` : ''}` : ''
      ur.appendChild(li(`${time(r.at)} · ${(r.orderIds || []).join(', ')} · ${Core.formatFen(r.expectedOrderTotalFen)}${reason}${srv}`, OUTCOME[r.outcome] || [r.outcome, 't-stop']))
    }
  }

  async function init() {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version
    const s = await getSettings()
    $('autoClick').checked = s.autoClick === true
    $('dryRun').checked = s.dryRun === true
    $('serverAutoRun').checked = s.serverAutoRun === true
    $('testJobRun').checked = s.testJobRun === true
    $('passwordAutoFill').checked = s.passwordAutoFill === true
    $('serverPasswordAutoFill').checked = s.serverPasswordAutoFill === true
    renderMode(s)
    for (const id of ['autoClick', 'dryRun', 'serverAutoRun', 'testJobRun', 'passwordAutoFill', 'serverPasswordAutoFill']) {
      $(id).addEventListener('change', async () => {
        const next = Object.assign(await getSettings(), { [id]: $(id).checked })
        await chrome.storage.local.set({ settings: next })
        renderMode(next)
        renderServer()
      })
    }
    const act = (id, type) =>
      $(id).addEventListener('click', async () => {
        $(id).disabled = true
        try {
          await chrome.runtime.sendMessage({ type })
        } finally {
          $(id).disabled = false
          renderServer()
          renderLists()
        }
      })
    act('claimNow', 'AUTOPAY_CLAIM_NOW')
    act('resume', 'AUTOPAY_RESUME')
    act('testClaimNow', 'TESTPAY_CLAIM_NOW')
    act('testResume', 'TESTPAY_RESUME')
    await renderServer()
    await renderLists()
    chrome.storage.onChanged.addListener((_c, area) => {
      if (area === 'session') {
        renderLists()
        renderServer()
      }
    })
  }

  init()
})()
