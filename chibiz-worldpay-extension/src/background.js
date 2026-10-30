/*
 * 서비스 워커 — 작업 보관(chrome.storage.session · 브라우저를 닫으면 사라짐)·탭 배지.
 *
 * 🔴 작업은 10분 · 한 번 쓰면 소각(티켓 §4-2). 결제 버튼은 «작업 소각 성공» 뒤에만 눌립니다(BEGIN_PAY_CLICK).
 * 🆕 서버 작업 통로 둘(CHANNELS · 섞지 않음):
 *    - SERVER = 서버 주도 자동 결제(T-20261015-05 · «서버 작업 자동 실행» · 기본 꺼짐)
 *    - TEST = 관리자 «월드페이 결제 시험»(T-20261015-04 · 다른 PC · «시험 작업 받기» · 기본 꺼짐)
 *    켜진 통로는 알람마다 claim → 받은 작업을 저장소에 넣고 payUrl 새 탭 → 결제 페이지 흐름은 관리자 웹 작업과 똑같음 → 끝나면 그 통로 서버에 결과 5종 보고.
 * 🆕 0.4.0 — 비밀번호 자동 입력(사용자 지시 2026-10-22): 시험 작업(TEST)에 서버가 준 1회용 표(revealToken)가 있고 «비밀번호 자동 입력» 이
 *    켜져 있으면, 알리페이 비밀번호 창이 뜬 그 순간 서버에서 비밀번호를 1회 받아 그 프레임에만 건네고 버립니다(저장·로그·콘솔 금지).
 *    그 밖(서버 자동 결제 SERVER · 표 없음 · 꺼짐 · 받기 실패)은 «직접 입력해 주세요» 안내 + 사람이 «下一步» 누름만 읽어 보고(0.3.0 그대로).
 */
importScripts('config.js', 'core.js')

const C = self.ChibizWorldpayConfig
const Core = self.ChibizWorldpayCore

const KEY_JOBS = 'worldpayJobs'
const KEY_RESULTS = 'worldpayResults'
const RESULTS_MAX = 20
const CASHIER_ORIGIN = 'https://air.1688.com'
/** 🆕 0.5.5 결과 페이지 팝업의 주문별 결과를 기다리는 시간(못 받으면 그대로 확정) · 추정값 */
const RESULT_ORDERS_WAIT_MS = 8 * 1000
/** 🆕 0.5.0 결제 완료 신호를 받을 수 있는 출처(1688 결제·결과 페이지 · 알리페이 창) */
/** 🆕 0.5.3 — 결제 뒤 넘어가는 결과 페이지가 다른 1688 하위 도메인일 수 있어 https *.1688.com 전부(받는 쪽은 «결제 버튼 누른 탭» 만) */
function isPayPageOrigin(origin) {
  let u
  try {
    u = new URL(String(origin))
  } catch (e) {
    return false
  }
  const is1688 = u.protocol === 'https:' && !u.port && (u.hostname === '1688.com' || u.hostname.endsWith('.1688.com'))
  return is1688 || Core.isAlipayOrigin(origin)
}
/** 그 탭에서 익스텐션이 결제 버튼을 누른 가장 최근 작업(SUCCESS_DETECT.windowMs 안) */
function clickedJobInTab(jobs, tabId, now) {
  return Object.values(jobs)
    .filter((j) => j.tabId === tabId && j.outcome === 'PAY_CLICKED' && Number.isFinite(j.payClickedAt) && now - j.payClickedAt <= C.SUCCESS_DETECT.windowMs)
    .sort((a, b) => b.payClickedAt - a.payClickedAt)[0] || null
}

/**
 * 🆕 0.3.0 — 서버 작업 통로 둘(섞지 않음 · 주소·키·켜기 스위치·멈춤 상태·알람이 저마다 따로).
 *  - SERVER = 서버 주도 자동 결제(T-20261015-05 · 기본 꺼짐)
 *  - TEST = 관리자 «월드페이 결제 시험»(다른 PC · T-20261015-04 · 기본 꺼짐)
 * 흐름(결제 페이지 선택·클릭·결과 다섯 종류)은 둘이 같고 `job.source` 로만 가립니다.
 */
const CHANNELS = {
  SERVER: { cfg: C.AUTOPAY, setting: 'serverAutoRun', stateKey: 'autopayState', alarm: 'autopay-claim' },
  TEST: { cfg: C.TESTPAY, setting: 'testJobRun', stateKey: 'testpayState', alarm: 'testpay-claim' },
}
/** 작업의 통로 설정(서버 작업이 아니면 null) */
function channelOf(job) {
  return job && CHANNELS[job.source] ? CHANNELS[job.source] : null
}
function cfgFor(job) {
  const ch = channelOf(job)
  return ch ? ch.cfg : C.AUTOPAY
}

// session 저장소를 content script 가 못 읽게(기본값이지만 분명히)
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})

/** 관리자 웹 출처 — manifest content_scripts[0].matches 한 곳에서 읽습니다. */
function adminOrigins() {
  const cs = (chrome.runtime.getManifest().content_scripts || [])[0]
  return (cs ? cs.matches : []).map((m) => {
    try {
      return new URL(m.replace(/\*$/, '')).origin
    } catch (e) {
      return ''
    }
  })
}

function senderOrigin(sender) {
  if (sender.origin) return sender.origin
  try {
    return new URL(sender.url).origin
  } catch (e) {
    return ''
  }
}

// ── 직렬화(저장소 읽고-쓰기가 겹치지 않게) ──────────────────────────────────
let chain = Promise.resolve()
function serial(fn) {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

async function loadJobs(now) {
  const got = await chrome.storage.session.get(KEY_JOBS)
  const jobs = got[KEY_JOBS] || {}
  let changed = false
  for (const id of Object.keys(jobs)) {
    if (keepServerJob(jobs[id], now)) continue
    if (!Core.isJobAlive(jobs[id], now)) {
      delete jobs[id]
      changed = true
    }
  }
  if (changed) await chrome.storage.session.set({ [KEY_JOBS]: jobs })
  return jobs
}

async function saveJobs(jobs) {
  await chrome.storage.session.set({ [KEY_JOBS]: jobs })
}

async function pushResult(job, outcome, code, extra) {
  const got = await chrome.storage.session.get(KEY_RESULTS)
  const list = got[KEY_RESULTS] || []
  list.unshift(Object.assign({ at: Date.now(), jobId: job.jobId, orderIds: job.orderIds, expectedOrderTotalFen: job.expectedOrderTotalFen, outcome, code: code || null }, extra || {}))
  await chrome.storage.session.set({ [KEY_RESULTS]: list.slice(0, RESULTS_MAX) })
}

/** 최근 결과의 한 줄(같은 작업)을 고침 — 서버 보고 상태 표시용 */
async function patchResult(jobId, patch) {
  const got = await chrome.storage.session.get(KEY_RESULTS)
  const list = got[KEY_RESULTS] || []
  const row = list.find((r) => r.jobId === jobId)
  if (!row) return
  Object.assign(row, patch)
  await chrome.storage.session.set({ [KEY_RESULTS]: list })
}

async function getSettings() {
  const got = await chrome.storage.local.get('settings')
  return Object.assign({}, C.DEFAULT_SETTINGS, got.settings || {})
}

function setBadge(tabId, kind) {
  if (!Number.isInteger(tabId)) return
  const map = {
    STOP: { text: '!', color: '#dc2626' },
    CLICKED: { text: 'OK', color: '#16a34a' },
    DRY: { text: 'DRY', color: '#2563eb' },
    READY: { text: 'RDY', color: '#f59e0b' },
    WORK: { text: '…', color: '#6b7280' },
  }
  const b = map[kind] || { text: '', color: '#6b7280' }
  chrome.action.setBadgeText({ tabId, text: b.text }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => {})
}

function publicJob(job) {
  // 🆕 0.6.0 payChannel — 서버 작업이 CREDIT 로 지정했을 때만 외상(관리자 웹 작업은 언제나 월드페이)
  return { jobId: job.jobId, orderIds: job.orderIds, expectedOrderTotalFen: job.expectedOrderTotalFen, createdAt: job.createdAt, payChannel: isServerJob(job) && job.payChannel === 'CREDIT' ? 'CREDIT' : 'WORLDPAY' }
}

// ── 메시지 ─────────────────────────────────────────────────────────────────

const handlers = {
  /** 관리자 웹 → 작업 등록 */
  async REGISTER_JOB(msg, sender) {
    if (!adminOrigins().includes(senderOrigin(sender))) return { ok: false, reason: 'NOT_ADMIN_ORIGIN' }
    const now = Date.now()
    const v = Core.validateJob(msg.job, now)
    if (!v.ok) return { ok: false, reason: v.reason }
    return serial(async () => {
      const jobs = await loadJobs(now)
      if (jobs[v.job.jobId]) return { ok: false, reason: 'DUPLICATE_JOB_ID' }
      jobs[v.job.jobId] = Object.assign({}, v.job, {
        receivedAt: now,
        adminTabId: sender.tab ? sender.tab.id : null,
        state: 'PENDING',
        tabId: null,
        outcome: null,
        code: null,
        payClickedAt: null,
                updatedAt: now,
      })
      await saveJobs(jobs)
      return { ok: true }
    })
  },

  /** 결제 페이지 → 이 탭의 작업 찾기 */
  async CLAIM(msg, sender) {
    if (senderOrigin(sender) !== CASHIER_ORIGIN || !sender.tab) return { kind: 'NONE' }
    const tabId = sender.tab.id
    const now = Date.now()
    return serial(async () => {
      const jobs = await loadJobs(now)
      // 🔴 클릭 대상은 살아 있는(10분) 작업만 — 보고를 기다리며 남아 있는 서버 작업은 맞추지 않음
      const all = Object.values(jobs).filter((j) => Core.isJobAlive(j, now) && !(j.report && j.report.final))
      const m = Core.matchJob(all, msg.pageOrderNos, msg.urlOrderIds)
      if (m.kind === 'NONE') return { kind: 'NONE' }
      const job = jobs[m.job.jobId]
      if (m.kind === 'PARTIAL') {
        if (isServerJob(job) && job.openedTabId === tabId) {
          await finishServerInPlace(jobs, job, { kind: 'PARTIAL' }, now)
          await saveJobs(jobs)
          kickReports()
        }
        return { kind: 'PARTIAL', job: publicJob(job) }
      }
      if (job.state === 'DONE') return { kind: 'ALREADY_DONE', job: publicJob(job) }
      if (job.state === 'CLAIMED' && job.tabId !== tabId) return { kind: 'OTHER_TAB', job: publicJob(job) }
      job.state = 'CLAIMED'
      job.tabId = tabId
      job.updatedAt = now
      await saveJobs(jobs)
      setBadge(tabId, 'WORK')
      return { kind: 'MATCH', job: publicJob(job), settings: await getSettings() }
    })
  },

  /**
   * 로그인 안 된 결제 페이지 — 주문번호가 화면에 없으므로 주소의 orderId(단건) 또는 «살아 있는 미처리 작업이 있음»(묶음)으로
   * 경고 띠를 띄울지 정합니다. 🔴 작업은 소각하지 않습니다.
   */
  async PEEK(msg, sender) {
    if (senderOrigin(sender) !== CASHIER_ORIGIN || !sender.tab) return { warn: false }
    const now = Date.now()
    return serial(async () => {
      const store = await loadJobs(now)
      // 🆕 서버 작업으로 연 탭이면 그 작업 — 로그인 안 됨 → SESSION_EXPIRED · 안 그려짐 → ERROR 보고(티켓 §5 «보고 후 멈춤»)
      const mine = Object.values(store).find((j) => isServerJob(j) && j.openedTabId === sender.tab.id && !(j.report && j.report.final))
      if (mine) {
        await finishServerInPlace(store, mine, { kind: 'PEEK', code: msg.code === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : msg.code === 'ALREADY_PAID' ? 'ALREADY_PAID' : 'RENDER_TIMEOUT' }, now)
        await saveJobs(store)
        kickReports()
        setBadge(sender.tab.id, 'STOP')
        return { warn: true, job: publicJob(mine) }
      }
      const jobs = Object.values(store).filter((j) => j.state !== 'DONE')
      const url = msg.urlOrderIds || []
      const hit = url.length ? jobs.find((j) => Core.sameSet(url, j.orderIds)) : jobs[0]
      if (hit) setBadge(sender.tab.id, 'STOP')
      return { warn: !!hit, job: hit ? publicJob(hit) : null }
    })
  },

  /** 🔴 결제 버튼 누르기 직전 — 작업을 먼저 소각합니다(성공해야만 누름 · 다시 누르기 방지). */
  async BEGIN_PAY_CLICK(msg, sender) {
    if (senderOrigin(sender) !== CASHIER_ORIGIN || !sender.tab) return { ok: false }
    const now = Date.now()
    return serial(async () => {
      const jobs = await loadJobs(now)
      const job = jobs[msg.jobId]
      if (!job || job.state !== 'CLAIMED' || job.tabId !== sender.tab.id) return { ok: false }
      const settings = await getSettings()
      if (Core.finalAction(settings) !== 'CLICK_PAY') return { ok: false, reason: 'SETTINGS_CHANGED' }
      job.state = 'DONE'
      job.outcome = 'PAY_CLICKED'
      job.payClickedAt = now
      job.updatedAt = now
      if (isServerJob(job)) {
        // 서버 작업 — 비밀번호 창 결과를 기다렸다가 보고(없으면 시간이 지나 PAID_SUBMITTED·CLICKED)
        deferServer(job, { kind: 'CLICKED' }, now + cfgFor(job).AFTER_CLICK_WAIT_MS)
      }
      await saveJobs(jobs)
      if (!isServerJob(job)) await pushResult(job, 'PAID_SUBMITTED')
      setBadge(sender.tab.id, 'CLICKED')
      return { ok: true }
    })
  },

  /**
   * 세부 결과 보고(executeJobFlow → reportResult) — PAID 밖의 끝(시험 모드·준비만·멈춤).
   * msg = { jobId, stage: 'PAID'|'DRY_RUN'|'PREPARED'|'STOP', code, outcome(정규화 5종) }.
   * 🔴 로그인 안 됨(STOP·SESSION_EXPIRED)만 작업을 남깁니다(소각 안 함 · 티켓 §4-3).
   */
  async REPORT(msg, sender) {
    if (senderOrigin(sender) !== CASHIER_ORIGIN || !sender.tab) return { ok: false }
    const now = Date.now()
    return serial(async () => {
      const jobs = await loadJobs(now)
      const job = jobs[msg.jobId]
      if (!job || job.tabId !== sender.tab.id) return { ok: false }
      if (job.state === 'DONE') return { ok: true } // PAID 는 BEGIN_PAY_CLICK 에서 이미 DONE
      if (isServerJob(job)) {
        // 서버 작업 — 로그인 안 됨도 남기지 않고 보고(티켓 T-05 §5)
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 200) : null // 🆕 0.4.1 결제 버튼 진단(화면 모양만)
        await finishServerInPlace(jobs, job, { kind: 'STAGE', stage: msg.stage, code: msg.code, detail }, now)
        await saveJobs(jobs)
        kickReports()
        setBadge(sender.tab.id, msg.stage === 'DRY_RUN' ? 'DRY' : msg.stage === 'PREPARED' ? 'READY' : 'STOP')
        return { ok: true }
      }
      const keep = msg.stage === 'STOP' && Core.KEEP_JOB_CODES.includes(msg.code)
      if (!keep) {
        job.state = 'DONE'
        job.stage = msg.stage
        job.outcome = msg.outcome
        job.code = msg.code || null
      }
      job.updatedAt = now
      await saveJobs(jobs)
      await pushResult(job, msg.outcome, msg.code)
      setBadge(sender.tab.id, msg.stage === 'DRY_RUN' ? 'DRY' : msg.stage === 'PREPARED' ? 'READY' : 'STOP')
      return { ok: true }
    })
  },

  /** 관계없는 주문 구성 등 작업 없이 띄운 경고의 배지 */
  async BADGE(msg, sender) {
    if (senderOrigin(sender) !== CASHIER_ORIGIN || !sender.tab) return { ok: false }
    setBadge(sender.tab.id, msg.kind)
    return { ok: true }
  },

  /**
   * 🆕 0.5.0 결제 완료 감지 — 결제 버튼을 누른 탭(1688 결제·결과 페이지 또는 알리페이 비밀번호 창)에서 완료 글자를 봤다는 신호.
   * 그 탭에서 익스텐션이 결제 버튼을 누른 지 SUCCESS_DETECT.windowMs 안일 때만 받음. 서버 작업이면 기다리던 결과를 바로 확정.
   */
  async PAY_SUCCESS_SEEN(msg, sender) {
    if (!isPayPageOrigin(senderOrigin(sender)) || !sender.tab) return { ok: false }
    const text = Core.findSuccessText(msg && msg.text)
    if (!text) return { ok: false }
    const tabId = sender.tab.id
    const now = Date.now()
    const hit = await serial(async () => {
      const jobs = await loadJobs(now)
      const job = clickedJobInTab(jobs, tabId, now)
      if (!job) return null
      if (!job.successSeen) {
        // 🆕 0.5.3 화면 요약(건수·금액)을 작업과 대조 — 다르면 사유에 «⚠ 작업과 다름»(판정은 서버 1688 조회)
        const sm = msg.summary && typeof msg.summary === 'object' ? msg.summary : {}
        const summary = {
          orderCount: Number.isSafeInteger(sm.orderCount) ? sm.orderCount : null,
          amountFen: Number.isSafeInteger(sm.amountFen) ? sm.amountFen : null,
          worldpay: sm.worldpay === true,
        }
        const n = Array.isArray(job.orderIds) ? job.orderIds.length : null
        const mismatch = (summary.orderCount != null && n != null && summary.orderCount !== n) ||
          (summary.amountFen != null && Number.isSafeInteger(job.expectedOrderTotalFen) && summary.amountFen !== job.expectedOrderTotalFen)
        job.successSeen = { text, at: now, summary, mismatch }
      }
      job.updatedAt = now
      if (isServerJob(job) && !(job.report && job.report.final)) {
        const ev = job.pending ? job.pending.ev : { kind: 'CLICKED' }
        if (msg.ordersPending === true) {
          // 🆕 0.5.5 결과 페이지가 주문별 결과(팝업)를 이어서 보냄 — 최대 RESULT_ORDERS_WAIT_MS 기다렸다가 확정(못 받으면 그대로 확정)
          deferServer(job, ev, now + RESULT_ORDERS_WAIT_MS)
        } else {
          // 기다리던 결과(비밀번호 다음 등)가 있으면 그것으로, 없으면 «결제 버튼 누름» 으로 지금 확정
          await finishServerInPlace(jobs, job, ev, now)
        }
      }
      await saveJobs(jobs)
      await patchResult(job.jobId, { successSeen: true, successText: text })
      return job
    })
    if (!hit) return { ok: false }
    setBadge(tabId, 'CLICKED')
    chrome.tabs.sendMessage(tabId, { type: 'PAY_SUCCESS_BANNER', text }, { frameId: 0 }).catch(() => {})
    kickReports()
    closeTabAfterSuccess(tabId, hit.jobId).catch(() => {})
    return { ok: true }
  },

  /** 🆕 0.5.5 결과 페이지 팝업의 주문별 결과(번호·성공/실패·수단·금액) — 결제 버튼을 누른 탭만 · 받으면 바로 확정 */
  async PAY_RESULT_ORDERS(msg, sender) {
    if (!isPayPageOrigin(senderOrigin(sender)) || !sender.tab) return { ok: false }
    const now = Date.now()
    const rows = (Array.isArray(msg.orders) ? msg.orders : []).slice(0, 30).map((o) => ({
      orderNo: /^\d{10,25}$/.test(String(o && o.orderNo)) ? String(o.orderNo) : null,
      status: ['SUCCESS', 'FAILED', 'UNPAID', 'UNKNOWN'].includes(o && o.status) ? o.status : 'UNKNOWN',
      method: ['WORLDPAY', 'CREDIT', 'ALIPAY'].includes(o && o.method) ? o.method : null,
      amountFen: Number.isSafeInteger(o && o.amountFen) ? o.amountFen : null,
    })).filter((o) => o.orderNo)
    const hit = await serial(async () => {
      const jobs = await loadJobs(now)
      const job = clickedJobInTab(jobs, sender.tab.id, now)
      if (!job) return null
      job.resultOrders = rows
      if (isServerJob(job) && !(job.report && job.report.final)) {
        await finishServerInPlace(jobs, job, job.pending ? job.pending.ev : { kind: 'CLICKED' }, now)
      }
      await saveJobs(jobs)
      return job
    })
    if (hit) kickReports()
    return { ok: !!hit }
  },

  /** 🆕 0.5.3 결제 실패 화면 — 결제 버튼을 누른 탭에서 실패 글자(余额不足·支付失败 등)를 봄 → 서버 작업이면 바로 보고(서버가 1688 로 확인) */
  async PAY_FAIL_SEEN(msg, sender) {
    if (!isPayPageOrigin(senderOrigin(sender)) || !sender.tab) return { ok: false }
    const text = Core.findFailText(msg && msg.text)
    if (!text) return { ok: false }
    const tabId = sender.tab.id
    const now = Date.now()
    const hit = await serial(async () => {
      const jobs = await loadJobs(now)
      const job = clickedJobInTab(jobs, tabId, now)
      if (!job || job.successSeen) return null // 완료를 이미 봤으면 무시
      job.failSeen = { text, at: now }
      if (isServerJob(job) && !(job.report && job.report.final)) await finishServerInPlace(jobs, job, { kind: 'PAY_FAIL', failText: text }, now)
      await saveJobs(jobs)
      await patchResult(job.jobId, { failSeen: true, failText: text })
      return job
    })
    if (!hit) return { ok: false }
    setBadge(tabId, 'STOP')
    chrome.tabs.sendMessage(tabId, { type: 'PAY_FAIL_BANNER', text }, { frameId: 0 }).catch(() => {})
    kickReports()
    return { ok: true }
  },

  /** 🆕 0.5.0 결제 버튼 뒤 그 탭이 연 페이지의 경로(쿼리 없음) — 완료 화면을 못 봤을 때 «마지막 페이지» 로 보고(실제 완료 화면 주소를 배우려고) */
  async PAGE_AFTER_PAY(msg, sender) {
    if (!isPayPageOrigin(senderOrigin(sender)) || !sender.tab) return { ok: false }
    const path = typeof msg.path === 'string' ? msg.path.replace(/[?#].*$/, '').slice(0, 120) : null
    if (!path) return { ok: false }
    const now = Date.now()
    return serial(async () => {
      const jobs = await loadJobs(now)
      const job = clickedJobInTab(jobs, sender.tab.id, now)
      if (!job) return { ok: false }
      job.lastPath = `${senderOrigin(sender).replace(/^https:\/\//, '')}${path}`
      await saveJobs(jobs)
      return { ok: true }
    })
  },

  /**
   * 비밀번호 내주기(티켓 §4-5) — 알리페이 비밀번호 iframe(출처 pcauth-site.alipay.com · 하위 프레임)만.
   * 🔴 이 탭에서 익스텐션이 결제 버튼을 누른 지 2분 안 · 작업당 1회 · 시험 모드·자동 클릭 꺼짐이면 안 줌.
   *    내주기 «전에» 시도 기록을 남깁니다(틀려도 다시 넣지 않음).
   */
  async PASSWORD_REQUEST(msg, sender) {
    if (!Core.isAlipayOrigin(senderOrigin(sender)) || !sender.tab || sender.frameId === 0) return { ok: false, verdict: 'NONE' }
    const tabId = sender.tab.id
    const now = Date.now()
    const settings = await getSettings()
    const gate = await serial(async () => {
      const jobs = await loadJobs(now)
      const job = Object.values(jobs)
        .filter((j) => j.tabId === tabId && j.outcome === 'PAY_CLICKED' && Number.isFinite(j.payClickedAt))
        .sort((a, b) => b.payClickedAt - a.payClickedAt)[0]
      // 🆕 0.5.1 — 자동 입력은 «서버 작업(시험 TEST · 자동 결제 SERVER) + 1회용 표 있음 + 그 통로의 자동 입력 켜짐 + 시험 모드 아님» 일 때만
      //    통로별 설정: TEST = passwordAutoFill · SERVER = serverPasswordAutoFill(계약 X-5 «통로별 따로»)
      const ch = channelOf(job)
      const isServerish = !!ch
      const autoOn = isServerish && settings[ch.cfg.PASSWORD_SETTING] === true && settings.dryRun !== true
      const revealAvailable = isServerish && autoOn && typeof job.revealToken === 'string'
      const manualReason = isServerish && !autoOn ? 'AUTO_FILL_OFF' : isServerish && !job.revealToken ? 'NO_REVEAL_TOKEN' : 'USER_INPUT'
      const d = Core.decidePasswordStep({
        frame: msg.frame,
        payClickedByExtensionAt: job ? job.payClickedAt : null,
        now,
        dialogTitle: msg.dialogTitle,
        hasPasswordInput: msg.hasPasswordInput === true,
        revealAvailable,
        manualReason,
      })
      let token = null
      if (d.verdict === 'FILL') {
        // 🔴 표는 한 번만 — 받기 «전에» 지웁니다(받기 실패해도·틀려도 다시 받지 않음)
        token = { value: job.revealToken, cfg: ch.cfg, claimToken: job.claimToken }
        job.revealToken = null
        job.passwordFillTried = true
        await saveJobs(jobs)
      }
      return { d, token }
    })
    const d = gate.d
    // 사람이 직접 — 우리 창이면 «직접 입력해 주세요» 띠. 서버·시험 작업은 사람이 下一步 을 누를 때까지 결과를 기다립니다.
    if (d.verdict === 'MANUAL') relayPasswordBanner(tabId, 'MANUAL', d.reason || 'USER_INPUT')
    if (d.verdict !== 'FILL') return { ok: false, verdict: d.verdict, reason: d.reason }
    // 🔴 비밀번호 1회 받기 — 값은 이 응답으로 그 프레임에만 건네고 여기서는 남기지 않음(로그·콘솔·저장소 0)
    // 통로별 주소 · 본문 {revealToken}(자동 결제는 claimToken 도 함께 · 계약 X-5)
    const body = gate.token.cfg === C.AUTOPAY ? { revealToken: gate.token.value, claimToken: gate.token.claimToken } : { revealToken: gate.token.value }
    const res = await serverFetch(gate.token.cfg, gate.token.cfg.REVEAL_PATH, body)
    const pw = res.status === 200 && res.json && res.json.data && typeof res.json.data.password === 'string' ? res.json.data.password : null
    if (!pw || pw.length > 64) {
      relayPasswordBanner(tabId, 'MANUAL', 'REVEAL_FAILED')
      return { ok: false, verdict: 'MANUAL', reason: 'REVEAL_FAILED' }
    }
    return { ok: true, verdict: 'FILL', password: pw }
  },

  /** 비밀번호 창 결과 — MANUAL(안내만) · USER_SUBMITTED(사람이 下一步 누름) · 🆕 AUTO_SUBMITTED(자동 입력 + 下一步) · MANUAL_TIMEOUT · WRONG(틀림 문구) */
  async PASSWORD_RESULT(msg, sender) {
    if (!Core.isAlipayOrigin(senderOrigin(sender)) || !sender.tab || sender.frameId === 0) return { ok: false }
    const result = ['MANUAL', 'USER_SUBMITTED', 'AUTO_SUBMITTED', 'MANUAL_TIMEOUT', 'WRONG'].includes(msg.result) ? msg.result : 'MANUAL'
    const submitted = result === 'USER_SUBMITTED' || result === 'AUTO_SUBMITTED'
    const reason = typeof msg.reason === 'string' ? msg.reason : null
    relayPasswordBanner(sender.tab.id, result, reason)
    setBadge(sender.tab.id, submitted ? 'CLICKED' : 'STOP')
    // 🆕 서버·시험 작업이면 결과에 반영 — WRONG → PASSWORD_FAILED(즉시) · USER_SUBMITTED → 틀림 감시 뒤 PAID_SUBMITTED · MANUAL_TIMEOUT → BLOCKED
    const tabId = sender.tab.id
    if (result === 'MANUAL') return { ok: true } // 안내만 — 아직 결과 아님
    await serial(async () => {
      const now = Date.now()
      const jobs = await loadJobs(now)
      const job = Object.values(jobs)
        .filter((j) => isServerJob(j) && j.tabId === tabId && j.outcome === 'PAY_CLICKED')
        .sort((a, b) => b.payClickedAt - a.payClickedAt)[0]
      if (!job || (job.report && job.report.final)) return
      if (submitted) {
        job.passwordSubmitted = true
        deferServer(job, { kind: 'PASSWORD', result }, now + cfgFor(job).AFTER_PASSWORD_WAIT_MS)
      }
      else await finishServerInPlace(jobs, job, { kind: 'PASSWORD', result, reason }, now)
      await saveJobs(jobs)
    })
    kickReports()
    return { ok: true }
  },
}

// 팝업(익스텐션 페이지)에서만 부르는 동작
const popupHandlers = {
  async AUTOPAY_CLAIM_NOW() {
    await flushReports()
    return claimTick('SERVER', { manual: true })
  },
  async AUTOPAY_RESUME() {
    await setChannelState('autopayState', { halted: null })
    await flushReports()
    return claimTick('SERVER', { manual: true })
  },
  async TESTPAY_CLAIM_NOW() {
    await flushReports()
    return claimTick('TEST', { manual: true })
  },
  async TESTPAY_RESUME() {
    await setChannelState('testpayState', { halted: null })
    await flushReports()
    return claimTick('TEST', { manual: true })
  },
}

/** 비밀번호 창 결과를 그 탭의 결제 페이지(최상위 프레임) 띠로 */
function relayPasswordBanner(tabId, result, reason) {
  chrome.tabs.sendMessage(tabId, { type: 'PASSWORD_BANNER', result, reason }, { frameId: 0 }).catch(() => {})
}

// ══ 서버 주도 자동 결제 (T-20261015-05 · 계약 supplier-auto-pay.md) ══════════════════════
//
// 흐름: 알람 1분 → (설정 켜짐 · 멈춤 아님 · 열린 서버 작업 없음) → POST claim(키 헤더)
//   200 → 작업 검사(payUrl 은 1688 결제 주소만) → 저장소에 등록(source SERVER · claimToken · 보고 시한) → payUrl 새 탭
//   204·503 조용히 · 401 «키 오류»(팝업)
// 끝(결제 페이지·비밀번호 창·탭 닫힘·시한) → serverResultFor → POST result {claimToken, outcome, code, reason}
//   200 SENT · 400/404/409 포기(다시 보내도 같음) · 그 밖·네트워크는 다음 알람에 다시(서버 시한 + 1시간까지 · 같은 결과는 서버가 멱등)
// 🔴 payUrl·claimToken·비밀번호는 로그·콘솔·결과 목록에 남기지 않습니다(payUrl 은 저장도 안 함).

function isServerJob(job) {
  return !!job && !!CHANNELS[job.source]
}

/** 보고가 끝나지 않은 서버 작업은 10분 정리에서 빼고 남김(서버 시한 + 1시간까지) */
function keepServerJob(job, now) {
  if (!isServerJob(job)) return false
  const r = job.report
  if (r && (r.status === 'SENT' || r.status === 'GIVE_UP')) return false
  return now < (job.serverDeadline || 0) + 60 * 60 * 1000
}

async function getChannelState(stateKey) {
  const got = await chrome.storage.session.get(stateKey)
  return Object.assign({ lastClaimAt: null, lastClaimResult: null, lastClaimHttp: null, keyError: false, halted: null }, got[stateKey] || {})
}

async function setChannelState(stateKey, patch) {
  const cur = await getChannelState(stateKey)
  await chrome.storage.session.set({ [stateKey]: Object.assign(cur, patch) })
}

/** 결과를 나중에(비밀번호 결과·틀림 감시를 기다린 뒤) — 그 전에 더 확실한 결과가 오면 그것이 이김 */
function deferServer(job, ev, at) {
  job.pending = { ev, at }
  scheduleFlush(at)
}

function scheduleFlush(at) {
  // 크롬 알람은 최소 30초 — 그보다 이르면 30초 뒤
  chrome.alarms.create('autopay-flush', { when: Math.max(at, Date.now() + 30 * 1000) })
}

/** 서버 작업을 끝냄(저장소 객체를 고침 · 저장은 부르는 쪽) — 첫 확정 결과만 */
async function finishServerInPlace(jobs, job, ev, now) {
  if (!isServerJob(job) || (job.report && job.report.final)) return false
  // 🆕 0.5.0 결제 버튼을 누른 작업이면 «결제 완료 화면 감지» 결과를 붙임(감지 = true · 못 봄 = false + 마지막 페이지 경로)
  if (job.outcome === 'PAY_CLICKED') {
    ev = Object.assign({}, ev, job.successSeen
      ? { successSeen: true, successText: job.successSeen.text, successSummary: job.successSeen.summary || null, summaryMismatch: !!job.successSeen.mismatch, resultOrders: job.resultOrders || null }
      : { successSeen: false, afterPath: job.lastPath || null })
  }
  // 🆕 0.5.1 X-1 — 결제 버튼을 누른 뒤에는 PAID_SUBMITTED·PASSWORD_FAILED 둘 중 하나로만(원래 판정은 code CLICKED_THEN_<코드>)
  if (job.outcome === 'PAY_CLICKED') ev = Object.assign({}, ev, { clicked: true })
  const res = Core.serverResultFor(ev)
  // 🆕 0.5.1 X-2 — 보고 칸(서버는 모르는 칸을 무시 · 시험 통로도 그대로)
  const extra = {
    payClicked: job.outcome === 'PAY_CLICKED',
    passwordSubmitted: !!(ev && ev.kind === 'PASSWORD' && (ev.result === 'USER_SUBMITTED' || ev.result === 'AUTO_SUBMITTED')) || !!job.passwordSubmitted,
    successSeen: !!job.successSeen,
    clickedAt: Number.isFinite(job.payClickedAt) ? Math.trunc(job.payClickedAt) : null,
    // 🆕 0.5.5 결과 페이지 팝업의 주문별 결과(번호·SUCCESS/FAILED·수단·금액 分) — 서버는 모르면 무시
    resultOrders: Array.isArray(job.resultOrders) ? job.resultOrders : null,
  }
  job.report = { outcome: res.outcome, code: res.code, reason: res.reason, extra, final: true, status: 'PENDING', tries: 0, at: now }
  job.pending = null
  job.state = 'DONE'
  job.updatedAt = now
  await pushResult(job, res.outcome, res.code, { source: job.source, reportStatus: 'PENDING' })
  const ch = channelOf(job)
  if (ch && Core.haltsAutoRun(res.outcome)) await setChannelState(ch.stateKey, { halted: { reason: res.outcome, at: now } })
  return true
}

let kickTimer = null
function kickReports() {
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    flushReports().catch(() => {})
  }, 0)
}

async function serverFetch(cfg, path, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(cfg.SERVER_BASE_URL + path, {
      method: 'POST',
      // 🆕 0.6.1 X-EXT-CAPABILITIES — 이 익스텐션이 외상(先采后付) 작업을 처리할 수 있음을 알림(서버는 이 헤더가 없으면 CREDIT 작업을 내주지 않음)
      headers: Object.assign({ [cfg.KEY_HEADER]: cfg.EXTENSION_KEY, 'X-EXT-CAPABILITIES': 'CREDIT' }, C.SERVER_HEADERS, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: ctrl.signal,
    })
    let json = null
    if (res.status === 200) {
      try {
        json = await res.json()
      } catch (e) {
        json = null
      }
    }
    return { status: res.status, json }
  } catch (e) {
    return { status: 0, json: null }
  } finally {
    clearTimeout(timer)
  }
}

let flushing = null
let flushAgain = false
/** 미뤄 둔 결과 확정 · 시한 지난 작업 정리 · 보고 보내기 — 도는 중에 또 부르면 끝난 뒤 한 번 더 */
function flushReports() {
  if (flushing) {
    flushAgain = true
    return flushing
  }
  flushing = (async () => {
    do {
      flushAgain = false
      await flushOnce()
    } while (flushAgain)
  })().finally(() => {
    flushing = null
  })
  return flushing
}

async function flushOnce() {
  {
    const toSend = await serial(async () => {
      const now = Date.now()
      const jobs = await loadJobs(now)
      for (const job of Object.values(jobs)) {
        if (!isServerJob(job) || (job.report && job.report.final)) continue
        if (job.pending && now >= job.pending.at) await finishServerInPlace(jobs, job, job.pending.ev, now)
        else if (now >= job.serverDeadline) await finishServerInPlace(jobs, job, { kind: 'NO_RESULT', clicked: job.outcome === 'PAY_CLICKED' }, now)
        else if (job.pending) scheduleFlush(job.pending.at)
      }
      await saveJobs(jobs)
      return Object.values(jobs)
        .filter((j) => isServerJob(j) && j.report && j.report.final && (j.report.status === 'PENDING' || j.report.status === 'RETRY'))
        .map((j) => ({ jobId: j.jobId, source: j.source, claimToken: j.claimToken, outcome: j.report.outcome, code: j.report.code, reason: j.report.reason, extra: j.report.extra || null }))
    })
    for (const r of toSend) {
      const ch = CHANNELS[r.source] || CHANNELS.SERVER
      const body = { claimToken: r.claimToken, outcome: r.outcome }
      if (r.code) body.code = r.code
      if (r.reason) body.reason = r.reason
      if (r.extra) Object.assign(body, r.extra)
      const res = await serverFetch(ch.cfg, ch.cfg.RESULT_PATH(r.jobId), body)
      const verdict = Core.classifyReportStatus(res.status)
      await serial(async () => {
        const jobs = await loadJobs(Date.now())
        const job = jobs[r.jobId]
        if (!job || !job.report) return
        job.report.tries = (job.report.tries || 0) + 1
        job.report.lastHttp = res.status
        job.report.status = verdict === 'SENT' ? 'SENT' : verdict === 'GIVE_UP' ? 'GIVE_UP' : 'RETRY'
        if (verdict === 'SENT' || verdict === 'GIVE_UP') job.claimToken = null // 🔴 다 쓴 claimToken 은 버림
        await saveJobs(jobs)
        await patchResult(r.jobId, { reportStatus: job.report.status, reportHttp: res.status })
      })
      if (verdict === 'KEY_ERROR') await setChannelState(ch.stateKey, { keyError: true })
    }
  }
}

const claiming = {}
/** 통로(SERVER·TEST)에서 작업 하나 가져오기 — 조건이 안 맞으면 부르지 않음 */
async function claimTick(source, opts) {
  const ch = CHANNELS[source]
  if (!ch) return { skipped: 'NO_CHANNEL' }
  if (claiming[source]) return { skipped: 'BUSY' }
  claiming[source] = true
  try {
    const settings = await getSettings()
    if (settings[ch.setting] !== true) return { skipped: 'OFF' }
    const st = await getChannelState(ch.stateKey)
    if (st.halted) return { skipped: 'HALTED' }
    const now = Date.now()
    // 🔴 통로를 가리지 않고 «열린 서버 작업이 하나라도 있으면» 멈춤 — 한 번에 한 결제 페이지만(두 통로 섞임도 막음)
    const open = await serial(async () => Object.values(await loadJobs(now)).some((j) => isServerJob(j) && !(j.report && j.report.final)))
    if (open) return { skipped: 'OPEN_JOB' }

    const res = await serverFetch(ch.cfg, ch.cfg.CLAIM_PATH, null)
    const kind = Core.classifyClaimStatus(res.status)
    await setChannelState(ch.stateKey, { lastClaimAt: Date.now(), lastClaimResult: kind, lastClaimHttp: res.status, keyError: kind === 'KEY_ERROR' })
    if (kind !== 'JOB') return { result: kind }

    const data = res.json && res.json.data
    const v = Core.validateServerJob(data, Date.now())
    if (!v.ok) {
      // 받은 작업이 이상함 — 보고할 수 있으면(jobId·claimToken) ERROR 로 돌려줌 · 탭은 열지 않음
      if (data && typeof data.jobId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(data.jobId) && typeof data.claimToken === 'string') {
        await serial(async () => {
          const jobs = await loadJobs(Date.now())
          const job = { jobId: data.jobId, orderIds: [], expectedOrderTotalFen: 0, createdAt: Date.now(), receivedAt: Date.now(), source, claimToken: data.claimToken, serverDeadline: Date.now(), state: 'PENDING', report: null }
          jobs[job.jobId] = job
          await finishServerInPlace(jobs, job, { kind: 'BAD_JOB', reason: v.reason }, Date.now())
          await saveJobs(jobs)
        })
        kickReports()
      }
      return { result: 'BAD_JOB', reason: v.reason }
    }

    const t = Date.now()
    await serial(async () => {
      const jobs = await loadJobs(t)
      jobs[v.job.jobId] = Object.assign({}, v.job, {
        receivedAt: t,
        source,
        claimToken: v.claimToken,
        // 🆕 0.4.0 비밀번호 1회용 표 — 비밀번호 창이 뜰 때 한 번 쓰고 지움(값이 아니라 표 · session 저장소 · 콘텐츠 스크립트는 못 읽음)
        revealToken: v.revealToken,
        serverDeadline: v.serverDeadline,
        state: 'PENDING',
        tabId: null,
        openedTabId: null,
        outcome: null,
        code: null,
        payClickedAt: null,
        report: null,
        pending: null,
        updatedAt: t,
      })
      await saveJobs(jobs)
    })
    let tab = null
    try {
      tab = await chrome.tabs.create({ url: v.payUrl, active: true })
    } catch (e) {
      tab = null
    }
    await serial(async () => {
      const jobs = await loadJobs(Date.now())
      const job = jobs[v.job.jobId]
      if (!job) return
      if (tab && Number.isInteger(tab.id)) job.openedTabId = tab.id
      else await finishServerInPlace(jobs, job, { kind: 'TAB_FAILED' }, Date.now())
      await saveJobs(jobs)
    })
    if (!tab) kickReports()
    scheduleFlush(v.serverDeadline)
    return { result: 'JOB', jobId: v.job.jobId, manual: !!(opts && opts.manual) }
  } finally {
    claiming[source] = false
  }
}


/**
 * 🆕 0.6.6(운영) 결제 완료를 감지한 탭 닫기.
 * 결과 보고가 확정될 때까지 기다린 뒤(확정 전에 닫으면 onRemoved 가 «결과 없음» 으로 보고함) 완료 화면을 잠깐 보여 주고 닫는다.
 * 🔴 같은 창에 다른 탭이 하나 이상 있을 때만 닫는다 — 탭이 1개는 무조건 남아야 한다(창이 닫히면 확장이 서버 작업을 못 받음).
 */
async function closeTabAfterSuccess(tabId, jobId) {
  const S = C.SUCCESS_DETECT
  if (!S.closeTabAfterSuccess) return
  const deadline = Date.now() + S.closeTabWaitReportMs
  while (Date.now() < deadline) {
    const jobs = await loadJobs(Date.now())
    const job = jobs[jobId]
    if (!job || !isServerJob(job) || (job.report && job.report.final)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  await new Promise((r) => setTimeout(r, S.closeTabDelayMs))
  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch (e) {
    return // 이미 닫힘
  }
  const sameWindow = await chrome.tabs.query({ windowId: tab.windowId })
  if (sameWindow.length < 2) return // 마지막 탭은 남김
  await chrome.tabs.remove(tabId)
}

/** 서버 작업으로 연 탭이 닫히면 — 미뤄 둔 결과를 바로 확정 · 없으면 «결과 없음» */
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const now = Date.now()
    const jobs = await loadJobs(now)
    const job = Object.values(jobs).find((j) => isServerJob(j) && j.openedTabId === tabId && !(j.report && j.report.final))
    if (!job) return
    await finishServerInPlace(jobs, job, job.pending ? job.pending.ev : { kind: 'NO_RESULT', clicked: job.outcome === 'PAY_CLICKED' }, now)
    await saveJobs(jobs)
  }).then(kickReports, () => {})
})

function ensureAlarm() {
  for (const source of Object.keys(CHANNELS)) {
    const ch = CHANNELS[source]
    chrome.alarms.get(ch.alarm).then((a) => {
      if (!a) chrome.alarms.create(ch.alarm, { periodInMinutes: ch.cfg.CLAIM_PERIOD_MIN, delayInMinutes: ch.cfg.CLAIM_PERIOD_MIN })
    })
  }
}

/** 알람 이름 → 통로(없으면 null) */
function sourceOfAlarm(name) {
  for (const source of Object.keys(CHANNELS)) if (CHANNELS[source].alarm === name) return source
  return null
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const source = sourceOfAlarm(alarm.name)
  if (source) flushReports().then(() => claimTick(source)).catch(() => {})
  else if (alarm.name === 'autopay-flush') flushReports().catch(() => {})
})
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)
ensureAlarm()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false
  // 팝업(익스텐션 페이지)만 부르는 동작 — content script 의 sender.url 은 언제나 웹 페이지 주소라 chrome-extension:// 일 수 없음
  if (popupHandlers[msg.type]) {
    if (!String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false
    popupHandlers[msg.type](msg, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: 'INTERNAL' }))
    return true
  }
  if (!handlers[msg.type]) return false
  handlers[msg.type](msg, sender)
    .then(sendResponse)
    .catch((e) => {
      console.warn('[chibiz-worldpay] 처리 실패', msg.type, e && e.message)
      sendResponse({ ok: false, reason: 'INTERNAL' })
    })
  return true
})
