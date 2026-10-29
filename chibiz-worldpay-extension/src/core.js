/*
 * 판정 로직 — DOM·chrome API 를 쓰지 않는 순수 함수만 (node 로 단위 시험 · test/core.test.js)
 *
 * 흐름(티켓 §4-3): 결제 페이지 모양(snapshot) + 등록된 작업(job) + 설정 → 다음 동작 하나.
 * 🔴 결제 수단 카드는 월드페이(kjpayV2)만 누를 수 있습니다 — {@link isClickAllowed} 한 곳.
 */
(function (root, factory) {
  const config = typeof module === 'object' && module.exports ? require('./config.js') : root.ChibizWorldpayConfig
  const api = factory(config)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ChibizWorldpayCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict'

  // ── 문구(한국어) ───────────────────────────────────────────────────────────

  const STOP_MESSAGES = Object.freeze({
    SESSION_EXPIRED: '1688 에 로그인되어 있지 않습니다 — 주계정(jungpan88)으로 로그인한 뒤 관리자 웹에서 결제 링크를 다시 받으세요.',
    RENDER_TIMEOUT: '결제 페이지가 시간 안에 그려지지 않았습니다 — 자동 결제를 하지 않습니다. 직접 결제하세요.',
    ORDER_MISMATCH: '이 결제 페이지의 주문 구성이 관리자 웹에서 링크를 받은 주문과 다릅니다 — 자동 결제를 하지 않습니다.',
    OTHER_TAB: '같은 주문의 자동 결제를 다른 탭이 이미 처리하고 있습니다 — 이 탭에서는 아무것도 하지 않습니다.',
    ALREADY_DONE: '이 주문의 자동 결제 작업은 이미 끝났습니다 — 다시 누르지 않습니다. 필요하면 직접 결제하세요.',
    NO_WORLDPAY: '결제 수단에 지정한 수단(월드페이 또는 외상)이 없습니다 — 다른 수단은 고르지 않습니다. 막힌 주문을 확인하세요.',
    CREDIT_LIMIT_SHORT: '외상(先采后付) 남은 한도가 결제 금액보다 적습니다 — 결제하지 않습니다.',
    WORLDPAY_UNAVAILABLE: '월드페이(跨境宝)를 쓸 수 없는 상태입니다(비활성) — 다른 수단은 고르지 않습니다. 막힌 주문을 확인하세요.',
    WORLDPAY_PARTIAL: '월드페이(跨境宝)로 이 묶음의 주문을 전부 결제할 수 없습니다(일부 주문만 가능) — 다른 수단·조합결제는 고르지 않습니다. 막힌 주문을 확인하세요.',
    WORLDPAY_SELECT_FAILED: '월드페이(跨境宝)를 눌렀지만 선택되지 않았습니다 — 직접 확인하세요.',
    PAY_CHANNEL_MISMATCH: '결제 버튼이 월드페이(kjpayV2)가 아닌 수단(조합결제·외상·알리페이 등)으로 잡혀 있습니다 — 누르지 않습니다.',
    OPERATE_ZONE_UNKNOWN: '결제 버튼이 어느 수단으로 잡혀 있는지 읽지 못했습니다 — 자동 결제를 하지 않습니다.',
    CURRENCY_UNKNOWN: '결제 통화 탭을 찾지 못했습니다 — 자동 결제를 하지 않습니다.',
    CURRENCY_SELECT_FAILED: '결제 통화를 人民币(CNY)로 바꾸지 못했습니다 — 직접 확인하세요.',
    AMOUNT_UNKNOWN: '결제 페이지의 주문 총액(订单总金额)을 읽지 못했거나 화면 안에서 값이 서로 다릅니다 — 자동 결제를 하지 않습니다.',
    AMOUNT_MISMATCH: '주문 총액이 관리자 웹의 1688 금액과 다릅니다(금액 바뀜) — 자동 결제를 하지 않습니다. 관리자 웹에서 「1688 동기화」로 확인하세요.',
    PAY_BUTTON_MISSING: '결제 버튼(立即付款)을 찾지 못했습니다 — 직접 결제하세요.',
    PAY_BUTTON_DISABLED: '결제 버튼이 눌리지 않는 상태(비활성·계산 중)로 남아 있습니다 — 월드페이 잔액·결제 페이지 안내를 확인하고 직접 결제하세요.',
    PAY_BUTTON_TEXT: '결제 버튼 글자가 «立即付款» 이 아닙니다(조합결제 등) — 누르지 않습니다.',
    CLICK_REFUSED: '안전 규칙에 맞지 않는 요소라 누르지 않았습니다 — 직접 결제하세요.',
    CHANGED_BEFORE_CLICK: '결제 버튼을 누르기 직전 화면이 바뀌었습니다 — 누르지 않았습니다. 직접 확인하세요.',
    INTERNAL: '익스텐션 내부 오류로 멈췄습니다 — 직접 결제하세요.',
  })

  /** 로그인 안 됨은 작업을 소각하지 않습니다(티켓 §4-3 · 로그인 뒤 같은 탭 새로 고침이면 다시 판정). */
  const KEEP_JOB_CODES = Object.freeze(['SESSION_EXPIRED'])

  // ── 값 다루기 ──────────────────────────────────────────────────────────────

  /** 공백·전각 괄호·전각 콜론을 정리합니다(비교용). */
  function normalizeText(text) {
    return String(text == null ? '' : text)
      .replace(/[ 　]/g, ' ')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/：/g, ':')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * 元 금액 글자 → 分 정수. 부동소수를 거치지 않습니다.
   * 「￥1,234.56」「¥ 12.3」「12」 → 123456 · 1230 · 1200 · 그 밖 → null
   */
  function parseYuanToFen(text) {
    const s = normalizeText(text).replace(/^[￥¥]\s*/, '').replace(/,/g, '')
    const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s)
    if (!m) return null
    const frac = (m[2] || '').padEnd(2, '0')
    return Number(m[1]) * 100 + Number(frac)
  }

  /** 分 정수 → 「¥1,234.56」 (표시용) */
  function formatFen(fen) {
    if (!Number.isSafeInteger(fen)) return '—'
    const neg = fen < 0
    const abs = Math.abs(fen)
    const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return `${neg ? '-' : ''}¥${yuan}.${String(abs % 100).padStart(2, '0')}`
  }

  /** 글 안의 「订单编号：숫자」 전부(중복 제거 · 나온 순서). */
  function extractOrderNos(text) {
    const label = C.TEXT.orderNoLabel
    const re = new RegExp(label + '\\s*[：:]\\s*(\\d{6,30})', 'g')
    const out = []
    const s = String(text == null ? '' : text)
    let m
    while ((m = re.exec(s))) if (!out.includes(m[1])) out.push(m[1])
    return out
  }

  /** 글 안의 「订单总金额：￥금액」 → 分 정수 배열(못 읽은 것은 null). */
  function extractOrderTotalFens(texts) {
    const label = C.TEXT.orderTotalLabel
    const re = new RegExp(label + '\\s*:\\s*[￥¥]?\\s*([\\d,]+(?:\\.\\d{1,2})?)')
    const out = []
    for (const raw of texts || []) {
      const t = normalizeText(raw)
      if (!t.includes(label)) continue
      const m = re.exec(t)
      out.push(m ? parseYuanToFen(m[1]) : null)
    }
    return out
  }

  /**
   * 결제 페이지 주소 → { orderIds(단건 orderId · 쉼표면 여러 개), cashierOrderNo }.
   * 묶음 링크는 `cashierOrderNo=<32자>` 라 주문번호가 주소에 없습니다(티켓 §3 · admin_pay_link 실측).
   */
  function parseCashierUrl(href) {
    let url
    try {
      url = new URL(String(href))
    } catch (e) {
      return { orderIds: [], cashierOrderNo: null }
    }
    const raw = url.searchParams.get('orderId') || ''
    const orderIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6,30}$/.test(s))
    return { orderIds: Array.from(new Set(orderIds)), cashierOrderNo: url.searchParams.get('cashierOrderNo') || null }
  }

  /** `data-tracker-args="available=false"` → { available: 'false' } (쉼표·& 둘 다 구분자) */
  function parseTrackerArgs(text) {
    const out = {}
    for (const part of String(text == null ? '' : text).split(/[,&;]/)) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    return out
  }

  /**
   * 글 안에서 `key:` 바로 뒤의 `{…}` 를 괄호 짝으로 잘라 JSON.parse — 🔴 eval 하지 않습니다.
   * 묶음 결제 페이지 인라인 스크립트 `app({ container: "root", batchServerModel: {…} …` (티켓 §3 묶음 실측).
   * @returns 객체 | null(없음·깨짐)
   */
  function extractObjectAfterKey(text, key) {
    const s = String(text == null ? '' : text)
    const re = new RegExp('["\']?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\s*:\\s*\\{', 'g')
    const m = re.exec(s)
    if (!m) return null
    const start = m.index + m[0].length - 1
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            const obj = JSON.parse(s.slice(start, i + 1))
            return obj && typeof obj === 'object' ? obj : null
          } catch (e) {
            return null
          }
        }
      }
    }
    return null
  }

  function toFen(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
    if (typeof v === 'string' && /^\d{1,14}$/.test(v.trim())) return Number(v.trim())
    return null
  }

  function triBool(v) {
    if (v === true || v === 'true') return true
    if (v === false || v === 'false') return false
    return null
  }

  /**
   * batchServerModel → 판정에 쓰는 칸만.
   * { cashierType, orderIds, totalPayFeeFen, channels: [{ channel, available(true|false|null), itemOrderIds, copywriting }] }
   * 🔴 1688 철자 `avaliable` 그대로 읽고, 바른 철자 `available` 도 받습니다.
   */
  function summarizeBatchModel(model) {
    if (!model || typeof model !== 'object') return null
    const order = model.cashierOrder || {}
    const orderIds = Array.isArray(order.orderIds) ? order.orderIds.map((x) => String(x).trim()).filter((x) => /^\d{6,30}$/.test(x)) : []
    const channels = (Array.isArray(model.batchChannels) ? model.batchChannels : []).map((ch) => {
      const items = Array.isArray(ch && ch.combinationChannelItems) ? ch.combinationChannelItems : []
      const itemOrderIds = []
      let copywriting = ''
      for (const it of items) {
        for (const id of String((it && it.orderId) || '').split(/[;,]/)) {
          const t = id.trim()
          if (/^\d{6,30}$/.test(t) && !itemOrderIds.includes(t)) itemOrderIds.push(t)
        }
        if (!copywriting && it && it.features && typeof it.features.copywriting === 'string') copywriting = it.features.copywriting
      }
      const avail = ch && ('avaliable' in ch ? ch.avaliable : ch.available)
      return { channel: String((ch && ch.channel) || ''), available: triBool(avail), itemOrderIds, copywriting }
    })
    return {
      cashierType: typeof model.cashierType === 'string' ? model.cashierType : null,
      orderIds: Array.from(new Set(orderIds)),
      totalPayFeeFen: toFen(order.totalPayFee),
      channels,
    }
  }

  /** 주소 → 'single'(cashier.html) | 'batch'(batch-cashier.html) | 'unknown' */
  function pageKindOf(href) {
    let path = ''
    try {
      path = new URL(String(href)).pathname
    } catch (e) {
      return 'unknown'
    }
    if (/\/batch-cashier\.html$/.test(path)) return 'batch'
    if (/\/cashier\.html$/.test(path)) return 'single'
    return 'unknown'
  }

  /** 이 페이지의 주문번호 — 서버 모델이 있으면 그것(정본) · 없으면 화면 `订单编号` */
  function pageOrderNos(snapshot) {
    if (snapshot && snapshot.model && snapshot.model.orderIds.length) return snapshot.model.orderIds
    return (snapshot && snapshot.orderNos) || []
  }

  function sameSet(a, b) {
    const sa = new Set(a)
    const sb = new Set(b)
    if (sa.size !== sb.size) return false
    for (const x of sa) if (!sb.has(x)) return false
    return true
  }

  function intersects(a, b) {
    const sb = new Set(b)
    return a.some((x) => sb.has(x))
  }

  // ── 작업(관리자 웹 → 익스텐션) ─────────────────────────────────────────────

  /**
   * 관리자 웹이 보낸 작업 검사(티켓 §4-2).
   * job = { jobId, orderIds: string[](1688 주문번호), expectedOrderTotalFen: 分 정수, createdAt: ms }
   * @returns {{ ok: true, job } | { ok: false, reason }}
   */
  function validateJob(raw, now) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'NOT_OBJECT' }
    const jobId = raw.jobId
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(jobId)) return { ok: false, reason: 'BAD_JOB_ID' }
    if (!Array.isArray(raw.orderIds) || raw.orderIds.length === 0) return { ok: false, reason: 'NO_ORDERS' }
    if (raw.orderIds.length > C.MAX_ORDERS_PER_JOB) return { ok: false, reason: 'TOO_MANY_ORDERS' }
    const orderIds = []
    for (const id of raw.orderIds) {
      if (typeof id !== 'string' || !/^\d{6,30}$/.test(id)) return { ok: false, reason: 'BAD_ORDER_ID' }
      if (orderIds.includes(id)) return { ok: false, reason: 'DUPLICATE_ORDER_ID' }
      orderIds.push(id)
    }
    const fen = raw.expectedOrderTotalFen
    if (!Number.isSafeInteger(fen) || fen <= 0) return { ok: false, reason: 'BAD_AMOUNT' }
    const createdAt = raw.createdAt
    if (!Number.isFinite(createdAt)) return { ok: false, reason: 'BAD_CREATED_AT' }
    if (createdAt > now + C.CLOCK_SKEW_MS) return { ok: false, reason: 'FROM_FUTURE' }
    if (now - createdAt >= C.JOB_TTL_MS) return { ok: false, reason: 'EXPIRED' }
    return { ok: true, job: { jobId, orderIds, expectedOrderTotalFen: fen, createdAt } }
  }

  /** 작업이 아직 살아 있나 — 관리자 시각(createdAt)과 받은 시각(receivedAt) 둘 다 10분 안. */
  function isJobAlive(job, now) {
    if (!job) return false
    const base = Math.min(Number(job.createdAt) || 0, Number(job.receivedAt) || Number(job.createdAt) || 0)
    return now - base < C.JOB_TTL_MS
  }

  /**
   * 결제 페이지 주문 구성 ↔ 작업 맞추기(티켓 §4-3 1번).
   *  - 화면 주문번호 집합 == 작업 집합, 그리고 주소에 orderId 가 있으면 그것도 같은 집합 → MATCH
   *  - 겹치기는 하지만 같지 않음 → PARTIAL(경고만 · 클릭 없음)
   *  - 겹치지 않음 → NONE(우리 탭이 아님 · 아무것도 안 함)
   * @param jobs 살아 있는 작업들(state 무관 — 상태 판단은 부르는 쪽)
   */
  function matchJob(jobs, pageOrderNos, urlOrderIds) {
    const page = Array.from(new Set(pageOrderNos || []))
    const url = Array.from(new Set(urlOrderIds || []))
    if (page.length === 0) return { kind: 'NONE' }
    let partial = null
    for (const job of jobs || []) {
      const ids = job.orderIds || []
      const pageOk = sameSet(page, ids)
      const urlOk = url.length === 0 || sameSet(url, ids)
      if (pageOk && urlOk) return { kind: 'MATCH', job }
      if (!partial && (intersects(page, ids) || intersects(url, ids))) partial = job
    }
    return partial ? { kind: 'PARTIAL', job: partial } : { kind: 'NONE' }
  }

  // ── 결제 페이지 판정 ───────────────────────────────────────────────────────

  function findChannel(snapshot, channel) {
    return (snapshot.channels || []).find((c) => c.channel === channel) || null
  }

  /**
   * 다음 동작 하나(티켓 §4-3 2~5번 + 묶음 실측). snapshot 은 page.js#readSnapshot 모양:
   * { pageKind, sessionExpired, loginPrompt, rendered,
   *   channels:[{channel, selected, disabled, domAvailable(true|false|null)}],   ← 일반결제 `.channel-card[data-channel]`
   *   model: summarizeBatchModel 결과 | null, operateZoneChannels: string[],
   *   currency:{ present, activeText, hasCnyOption }, domOrderTotalFens:[분|null], payButton:{ present, disabled } }
   * @param tried { channel: 누른 횟수, currency: 누른 횟수 } — 같은 요소는 한 번만 누릅니다
   * @returns {{ action: 'WAIT' } | { action: 'STOP', code } | { action: 'CLICK_CHANNEL' } | { action: 'CLICK_CNY' } | { action: 'READY' }}
   */
  /** 🆕 0.6.0 이 작업이 누를 결제 수단 — 서버가 CREDIT 로 지정한 작업만 외상(shegou) · 그 밖 언제나 월드페이(kjpayV2) */
  function targetChannelOf(job) {
    return job && job.payChannel === 'CREDIT' ? C.CREDIT_CHANNEL : C.WORLDPAY_CHANNEL
  }

  function decideNext(snapshot, job, tried) {
    const t = tried || {}
    const W = targetChannelOf(job)
    if (!snapshot) return { action: 'WAIT' }
    if (snapshot.sessionExpired) return { action: 'STOP', code: 'SESSION_EXPIRED' }
    if (!snapshot.rendered) return { action: 'WAIT' }
    // 🆕 0.5.4 실측(2026-10-23 · 기본 선택이 先采后付(외상)인 묶음 결제 페이지): 서버 모델의 결제 수단 목록이 비어 있음 → 모델은 «모름» 으로 보고
    //    화면 카드로만 판정(금액은 화면 订单总金额 · 결제 버튼 수단 operate-zone 대조는 그대로). 목록이 있는 모델만 대조에 씀.
    const model = snapshot.model && Array.isArray(snapshot.model.channels) && snapshot.model.channels.length > 0 ? snapshot.model : null
    const jobIds = (job && job.orderIds) || []

    // 2. 월드페이 카드(일반결제 구역) — 화면 카드가 있어야 하고, 화면·서버 모델 어느 쪽도 «못 씀» 이 아니어야 함
    const wp = findChannel(snapshot, W)
    if (!wp) return { action: 'STOP', code: 'NO_WORLDPAY' }
    const wpModel = model ? model.channels.find((c) => c.channel === W) || null : null
    if (model && !wpModel) return { action: 'STOP', code: 'NO_WORLDPAY' }
    const domAvail = wp.domAvailable === undefined ? null : wp.domAvailable
    const modelAvail = wpModel ? wpModel.available : null
    if (wp.disabled || domAvail === false || modelAvail === false) return { action: 'STOP', code: 'WORLDPAY_UNAVAILABLE' }
    if (domAvail !== true && modelAvail !== true) return { action: 'STOP', code: 'WORLDPAY_UNAVAILABLE' }
    // 🆕 0.6.0 외상 — 카드의 «剩余额度 ¥…»(남은 한도)를 읽었고 작업 금액보다 작으면 누르지 않음
    if (W === C.CREDIT_CHANNEL && Number.isSafeInteger(snapshot.creditLimitFen) && job && snapshot.creditLimitFen < job.expectedOrderTotalFen) {
      return { action: 'STOP', code: 'CREDIT_LIMIT_SHORT' }
    }
    // 묶음: 월드페이가 묶음의 주문을 전부 덮어야 함(일부만이면 조합결제로 가야 하므로 멈춤)
    if (wpModel && wpModel.itemOrderIds.length && !sameSet(wpModel.itemOrderIds, jobIds)) return { action: 'STOP', code: 'WORLDPAY_PARTIAL' }

    // 3. 고르기(한 번만 누름)
    if (!wp.selected) return (t.channel || 0) >= 1 ? { action: 'STOP', code: 'WORLDPAY_SELECT_FAILED' } : { action: 'CLICK_CHANNEL' }
    if ((snapshot.channels || []).some((c) => c.selected && c.channel !== W)) return { action: 'STOP', code: 'WORLDPAY_SELECT_FAILED' }

    // 3-1. 결제 버튼이 잡고 있는 수단(`.operate-zone[data-channel]`) — 전부 정확히 kjpayV2. 묶음은 반드시 있어야 함
    const zones = snapshot.operateZoneChannels || []
    if (zones.length === 0 && snapshot.pageKind !== 'single') return { action: 'STOP', code: 'OPERATE_ZONE_UNKNOWN' }
    if (zones.some((z) => z !== W)) return { action: 'STOP', code: 'PAY_CHANNEL_MISMATCH' }

    // 4. 통화 CNY — 단건은 탭이 있어야 함(§3 실측) · 묶음은 탭이 있을 때만 확인(묶음 실측에 탭 언급 없음)
    const cur = snapshot.currency || {}
    if (!cur.present) {
      if (snapshot.pageKind === 'single' || snapshot.pageKind === 'unknown') return { action: 'STOP', code: 'CURRENCY_UNKNOWN' }
    } else if (!isCnyText(cur.activeText)) {
      if (!cur.hasCnyOption) return { action: 'STOP', code: 'CURRENCY_UNKNOWN' }
      return (t.currency || 0) >= 1 ? { action: 'STOP', code: 'CURRENCY_SELECT_FAILED' } : { action: 'CLICK_CNY' }
    }

    // 5. 금액 — 分 단위 정확히. 서버 모델 totalPayFee 와 화면 订单总金额(여러 곳이면 전부)이 모두 같은 값이어야 함
    const amounts = []
    if (W === C.CREDIT_CHANNEL) {
      // 🆕 0.6.2 실측(2026-10-23): 외상을 고르면 지금 낼 돈은 «¥0.00» 이고 실제 금액은 «确认收货后付款 ¥915.00»(수령 후 결제)으로 따로 나옴
      //    → 외상은 그 금액(화면에 여러 곳이면 전부)이 작업 금액과 같아야 함 · 지금 낼 돈 0.00 은 대조에 쓰지 않음
      //    🆕 사용자 지시: «订单总金额 ¥915.00» 과 «确认收货后付款 ¥915.00» 두 가지 모두 확인 — 둘 다 있어야 하고 모두 같아야 함
      const due = snapshot.creditDueFens || []
      // 🆕 0.6.4 订单总金额 은 `.ext-price-info-item` 칸 + 페이지 전체 글 둘 다에서 찾음(외상 화면은 칸 밖에 있음)
      const totals = [...(snapshot.domOrderTotalFens || []), ...(snapshot.pageOrderTotalFens || [])]
      // 🆕 0.6.5 사용자 확인(2026-10-23): 외상 화면에는 订单总金额 이 없음(월드페이 화면에만 보임) → 外상은 确认收货后付款 이 필수 · 订单总金额 은 보일 때만 함께 대조
      if (due.length === 0) return { action: 'STOP', code: 'AMOUNT_UNKNOWN' }
      for (const f of due) amounts.push(f)
      for (const f of totals) amounts.push(f)
    } else {
      if (model) amounts.push(model.totalPayFeeFen)
      for (const f of snapshot.domOrderTotalFens || []) amounts.push(f)
    }
    if (amounts.length === 0 || amounts.some((f) => !Number.isSafeInteger(f))) return { action: 'STOP', code: 'AMOUNT_UNKNOWN' }
    if (new Set(amounts).size !== 1) return { action: 'STOP', code: 'AMOUNT_UNKNOWN' }
    if (!job || amounts[0] !== job.expectedOrderTotalFen) return { action: 'STOP', code: 'AMOUNT_MISMATCH' }

    // 결제 버튼
    // 🆕 0.6.3 외상은 «普通支付» 버튼
    const btn = (W === C.CREDIT_CHANNEL ? snapshot.creditPayButton : snapshot.payButton) || {}
    const wantText = W === C.CREDIT_CHANNEL ? C.TEXT.creditPayButtonText : C.TEXT.payButtonText
    // 🆕 0.4.1 — 없음(MISSING)과 «있는데 못 누름»(DISABLED · disabled·loading)을 나눔 · 흐름은 둘 다 잠시 기다렸다가 다시 봄(executeJobFlow)
    if (!btn.present) return { action: 'STOP', code: 'PAY_BUTTON_MISSING' }
    if (btn.disabled) return { action: 'STOP', code: 'PAY_BUTTON_DISABLED' }
    if (!normalizeText(btn.text).includes(wantText) || normalizeText(btn.text).includes(C.TEXT.creditNoPasswordText)) return { action: 'STOP', code: 'PAY_BUTTON_TEXT' }
    return { action: 'READY' }
  }

  /** 월드페이 카드의 업그레이드 안내 문구(막지 않음 · 띠에 참고로만 · 묶음 실측 6번) */
  function worldpayNotice(snapshot) {
    const m = snapshot && snapshot.model
    const wp = m ? m.channels.find((c) => c.channel === C.WORLDPAY_CHANNEL) : null
    return wp && wp.copywriting ? wp.copywriting : ''
  }

  function isCnyText(text) {
    const t = normalizeText(text)
    return t.includes(C.TEXT.cny) && t.toUpperCase().includes(C.TEXT.cnyCode)
  }

  /** READY 뒤 설정에 따른 마지막 동작(티켓 §4-4). */
  function finalAction(settings) {
    const s = Object.assign({}, C.DEFAULT_SETTINGS, settings || {})
    if (s.dryRun === true) return 'DRY_RUN'
    if (s.autoClick !== true) return 'PREPARE_ONLY'
    return 'CLICK_PAY'
  }

  // ── 작업 결과 종류(서버 주도 자동 결제 T-20261015-05 와 공통) ────────────────

  /** 결제 페이지에서 작업 하나를 실행한 결과 종류 */
  const OUTCOME = Object.freeze({
    PAID_SUBMITTED: 'PAID_SUBMITTED', // 결제 버튼(立即付款)을 눌렀음(그 뒤 비밀번호·인증은 별개)
    BLOCKED: 'BLOCKED', // 조건 미달로 누르지 않음(수단 없음·금액 다름·시험 모드·준비만 등)
    PASSWORD_FAILED: 'PASSWORD_FAILED', // 비밀번호 단계 실패(틀림·주입 실패) — 자동 입력을 사람이 완성한 뒤에만 남
    SESSION_EXPIRED: 'SESSION_EXPIRED', // 1688 로그인 안 됨
    ERROR: 'ERROR', // 내부 오류·버튼 거절·누르기 직전 바뀜
  })

  /** 클릭 직전 바뀜·거절·내부 = 오류로 보는 멈춤 코드 */
  const ERROR_STOP_CODES = Object.freeze(['INTERNAL', 'CLICK_REFUSED', 'CHANGED_BEFORE_CLICK'])

  /**
   * 세부 결과 → 다섯 종류 하나(서버 보고용).
   * @param r { stage: 'PAID'|'DRY_RUN'|'PREPARED'|'STOP'|'PASSWORD', code?: 멈춤 코드 }
   */
  function classifyOutcome(r) {
    if (!r || typeof r !== 'object') return OUTCOME.ERROR
    switch (r.stage) {
      case 'PAID':
        return OUTCOME.PAID_SUBMITTED
      case 'DRY_RUN':
      case 'PREPARED':
        return OUTCOME.BLOCKED
      case 'PASSWORD':
        return OUTCOME.PASSWORD_FAILED
      case 'STOP':
        if (r.code === 'SESSION_EXPIRED') return OUTCOME.SESSION_EXPIRED
        if (ERROR_STOP_CODES.includes(r.code)) return OUTCOME.ERROR
        return OUTCOME.BLOCKED
      default:
        return OUTCOME.ERROR
    }
  }

  // ── 서버 주도 자동 결제(T-20261015-05 · 계약 supplier-auto-pay.md) — 순수 함수 ──────────

  /** 1688 결제 링크로 믿을 주소 — https · trade.1688.com / air.1688.com 만(서버가 준 payUrl 도 이걸 통과해야 엶) */
  const PAY_URL_HOSTS = Object.freeze(['trade.1688.com', 'air.1688.com'])
  function isSafePayUrl(href) {
    let u
    try {
      u = new URL(String(href))
    } catch (e) {
      return false
    }
    return u.protocol === 'https:' && PAY_URL_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port
  }

  /**
   * claim 응답 data → 익스텐션 작업. 🔴 createdAt 은 서버 시각이 아니라 받은 시각(now) — 시계 차이와 무관하게.
   * @returns {{ ok: true, job, payUrl, claimToken, serverDeadline } | { ok: false, reason }}
   */
  function validateServerJob(data, now) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'NOT_OBJECT' }
    if (typeof data.claimToken !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(data.claimToken)) return { ok: false, reason: 'BAD_CLAIM_TOKEN' }
    if (!isSafePayUrl(data.payUrl)) return { ok: false, reason: 'BAD_PAY_URL' }
    const v = validateJob(
      { jobId: data.jobId, orderIds: Array.isArray(data.orderIds) ? data.orderIds.map((x) => String(x)) : data.orderIds, expectedOrderTotalFen: data.expectedOrderTotalFen, createdAt: now },
      now,
    )
    if (!v.ok) return v
    // 주문별 1688 금액 합 = 작업 금액(서버가 준 두 값이 서로 맞는지 · 있을 때만)
    if (Array.isArray(data.orders) && data.orders.length) {
      let sum = 0
      for (const o of data.orders) {
        if (!o || !Number.isSafeInteger(o.supplierTotalFen)) return { ok: false, reason: 'BAD_ORDERS' }
        sum += o.supplierTotalFen
      }
      const nos = data.orders.map((o) => String(o.supplierOrderNo || ''))
      if (sum !== v.job.expectedOrderTotalFen || !sameSet(nos, v.job.orderIds)) return { ok: false, reason: 'ORDERS_MISMATCH' }
    }
    // 결과 보고 시한 — 서버 expiresInSeconds(없거나 이상하면 15분) 에서 1분 여유를 뺌
    const secs = Number.isFinite(data.expiresInSeconds) && data.expiresInSeconds > 0 ? Math.min(data.expiresInSeconds, 15 * 60) : 15 * 60
    // 🆕 0.4.0 비밀번호 1회용 표(계약 §5-1 · 없거나 모양이 이상하면 null → 사람이 직접)
    const revealToken = typeof data.revealToken === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(data.revealToken) ? data.revealToken : null
    // 🆕 0.6.0 결제 수단 — 없으면 월드페이 · CREDIT 면 외상 · 그 밖 값은 이상한 작업
    if (data.payChannel != null && data.payChannel !== 'WORLDPAY' && data.payChannel !== 'CREDIT') return { ok: false, reason: 'BAD_PAY_CHANNEL' }
    const job = Object.assign({}, v.job, { payChannel: data.payChannel === 'CREDIT' ? 'CREDIT' : 'WORLDPAY' })
    return { ok: true, job, payUrl: String(data.payUrl), claimToken: data.claimToken, revealToken, serverDeadline: now + Math.max(0, secs - 60) * 1000 }
  }

  /** 서버 결과 보고 `code` 규칙(≤ 64자 · [A-Za-z0-9_.:-]) 에 맞춤 */
  function sanitizeCode(code) {
    if (code == null || code === '') return null
    return String(code).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64)
  }

  /** 서버 보고용 짧은 글(≤ 200 · 🔴 비밀번호·링크·개인정보 없음 — 고정 문구만) */
  const SERVER_REASON = Object.freeze({
    DRY_RUN: '시험 모드 — 결제 버튼을 누르지 않음',
    PREPARE_ONLY: '자동 클릭 꺼짐 — 결제 준비까지만',
    ORDER_MISMATCH: STOP_MESSAGES.ORDER_MISMATCH,
    PASSWORD_WRONG: '비밀번호 틀림 문구 — 다시 넣지 않음',
    PASSWORD_SUBMITTED: '결제 버튼 + 비밀번호 다음(下一步)까지 누름',
    CLICKED: '결제 버튼을 누름(비밀번호 창 결과 없음)',
    CLICKED_NO_RESULT: '결제 버튼을 누른 뒤 결과를 받지 못함',
    NO_RESULT: '결제 페이지에서 결과를 받지 못함(탭 닫힘·시간 초과)',
    TAB_OPEN_FAILED: '결제 페이지 탭을 열지 못함',
    PASSWORD_MANUAL: '비밀번호를 사람이 직접 입력하는 단계 — 직접 입력 필요',
    PASSWORD_USER_SUBMITTED: '비밀번호를 사람이 직접 넣고 다음(下一步)을 누름',
    PASSWORD_MANUAL_TIMEOUT: '비밀번호 직접 입력을 기다렸지만 다음(下一步)을 누르지 않음',
    PASSWORD_AUTO_SUBMITTED: '저장된 비밀번호를 자동 입력하고 다음(下一步)을 누름',
  })

  /**
   * 익스텐션 안의 사건 → 서버 결과 { outcome, code, reason }.
   * ev.kind: STAGE{stage,code} · PASSWORD{result,reason} · CLICKED · PEEK{code} · PARTIAL · NO_RESULT{clicked} · TAB_FAILED · BAD_JOB{reason}
   */
  function serverResultFor(ev) {
    const r = (outcome, code) => {
      const c = sanitizeCode(code)
      const base = c ? String(c).split(':')[0] : ''
      const reason = (SERVER_REASON[c] || SERVER_REASON[base] || STOP_MESSAGES[c] || STOP_MESSAGES[base] || PASSWORD_MANUAL_REASONS[c] || '').slice(0, 200)
      return { outcome, code: c, reason: reason || null }
    }
    if (!ev || typeof ev !== 'object') return r(OUTCOME.ERROR, 'INTERNAL')
    // 🆕 0.5.0 결제 완료 화면 감지 결과를 code 끝·사유에 덧붙임(서버는 code·reason 만 저장 · 결과 보고 모양 그대로)
    const base = serverResultBase(ev, r)
    // 🆕 0.5.1 X-1 — 결제 버튼을 누른 뒤의 다른 판정(ERROR·BLOCKED·SESSION_EXPIRED)은 PAID_SUBMITTED + CLICKED_THEN_<코드>
    if (ev.clicked === true && base.outcome !== OUTCOME.PAID_SUBMITTED && base.outcome !== OUTCOME.PASSWORD_FAILED) {
      const orig = base.code || 'UNKNOWN'
      base.outcome = OUTCOME.PAID_SUBMITTED
      base.code = sanitizeCode(`CLICKED_THEN_${orig}`)
      base.reason = `결제 버튼을 누른 뒤 ${base.reason || orig}`.slice(0, 200)
    }
    if (base.outcome !== OUTCOME.PAID_SUBMITTED) return base
    if (ev.successSeen === true) {
      base.code = sanitizeCode(`${base.code}:SUCCESS_SEEN`)
      const s = ev.successSummary || {}
      const parts = []
      if (s.orderCount != null) parts.push(`${s.orderCount}건`)
      if (s.amountFen != null) parts.push(formatFen(s.amountFen))
      if (s.worldpay) parts.push('跨境宝')
      if (ev.summaryMismatch) parts.push('⚠ 작업과 다름')
      // 🆕 0.5.5 팝업의 주문별 결과 — 성공 n/m · 실패 번호(끝 6자리)
      if (Array.isArray(ev.resultOrders) && ev.resultOrders.length) {
        const ok = ev.resultOrders.filter((o) => o.status === 'SUCCESS').length
        const bad = ev.resultOrders.filter((o) => o.status !== 'SUCCESS').map((o) => String(o.orderNo).slice(-6))
        parts.push(`주문별 성공 ${ok}/${ev.resultOrders.length}${bad.length ? ` · 실패 …${bad.join(',…')}` : ''}`)
      }
      const sum = parts.length ? ` · 화면 ${parts.join(' ')}` : ''
      base.reason = `결제 완료 화면 감지(${String(ev.successText || '').slice(0, 20)})${sum} · ${base.reason || ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
    } else if (ev.successSeen === false) {
      base.code = sanitizeCode(`${base.code}:NO_SUCCESS_SEEN`)
      const path = ev.afterPath ? ` · 마지막 페이지 ${String(ev.afterPath).slice(0, 80)}` : ''
      base.reason = `${base.reason || ''} · 결제 완료 화면 미감지${path}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
    }
    return base
  }

  /** 감지 정보 없이 결과 종류만 정함(0.4.x 의 serverResultFor 본문) */
  function serverResultBase(ev, r) {
    switch (ev.kind) {
      case 'STAGE': {
        const o = classifyOutcome({ stage: ev.stage, code: ev.code })
        if (ev.stage === 'PAID') return r(o, 'CLICKED')
        if (ev.stage === 'DRY_RUN') return r(o, 'DRY_RUN')
        if (ev.stage === 'PREPARED') return r(o, 'PREPARE_ONLY')
        const out = r(o, ev.code || 'INTERNAL')
        // 🆕 0.4.1 진단이 있으면 사유에 덧붙임(서버 사유 200자 · 제어 문자 제거)
        if (typeof ev.detail === 'string' && ev.detail) out.reason = `${out.reason || ''} · ${ev.detail}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
        return out
      }
      case 'PASSWORD':
        if (ev.result === 'WRONG') return r(OUTCOME.PASSWORD_FAILED, 'PASSWORD_WRONG')
        if (ev.result === 'USER_SUBMITTED') return r(OUTCOME.PAID_SUBMITTED, 'PASSWORD_USER_SUBMITTED')
        if (ev.result === 'AUTO_SUBMITTED') return r(OUTCOME.PAID_SUBMITTED, 'PASSWORD_AUTO_SUBMITTED')
        if (ev.result === 'MANUAL_TIMEOUT') return r(OUTCOME.BLOCKED, 'PASSWORD_MANUAL_TIMEOUT')
      {
        const out = r(OUTCOME.BLOCKED, `PASSWORD_MANUAL${ev.reason ? ':' + ev.reason : ''}`)
        const extra = ev.reason && PASSWORD_MANUAL_REASONS[ev.reason]
        if (extra) out.reason = `${SERVER_REASON.PASSWORD_MANUAL} · ${extra}`.slice(0, 200)
        return out
      }
      case 'CLICKED':
        return r(OUTCOME.PAID_SUBMITTED, 'CLICKED')
      case 'PAY_FAIL': {
        // 🆕 0.5.3 결제 실패 화면 — 결제 버튼 뒤라 X-1 에 따라 PAID_SUBMITTED + CLICKED_THEN_PAY_FAIL_SEEN 으로 나감(서버가 1688 로 «결제 안 됨» 확정)
        const out = r(OUTCOME.BLOCKED, 'PAY_FAIL_SEEN')
        out.reason = `결제 실패 화면 감지(${String(ev.failText || '').slice(0, 20)})`
        return out
      }
      case 'PEEK':
        return ev.code === 'SESSION_EXPIRED' ? r(OUTCOME.SESSION_EXPIRED, 'SESSION_EXPIRED') : r(OUTCOME.ERROR, ev.code || 'RENDER_TIMEOUT')
      case 'PARTIAL':
        return r(OUTCOME.BLOCKED, 'ORDER_MISMATCH')
      case 'NO_RESULT':
        return ev.clicked ? r(OUTCOME.PAID_SUBMITTED, 'CLICKED_NO_RESULT') : r(OUTCOME.ERROR, 'NO_RESULT')
      case 'TAB_FAILED':
        return r(OUTCOME.ERROR, 'TAB_OPEN_FAILED')
      case 'BAD_JOB':
        return r(OUTCOME.ERROR, `BAD_JOB:${ev.reason || ''}`)
      default:
        return r(OUTCOME.ERROR, 'INTERNAL')
    }
  }

  /** 이 결과 뒤 익스텐션 쪽 자동 실행을 멈출까(티켓 §5 «Session过期 면 보고 후 멈춤» · 비밀번호 틀림은 서버도 멈춤) */
  function haltsAutoRun(outcome) {
    return outcome === OUTCOME.SESSION_EXPIRED || outcome === OUTCOME.PASSWORD_FAILED
  }

  /** claim 응답 HTTP 상태 → JOB · NONE(204) · KEY_ERROR(401) · DISABLED(503) · ERROR */
  function classifyClaimStatus(status) {
    if (status === 200) return 'JOB'
    if (status === 204) return 'NONE'
    if (status === 401) return 'KEY_ERROR'
    if (status === 503) return 'DISABLED'
    return 'ERROR'
  }

  /** 결과 보고 응답 HTTP 상태 → SENT(200) · GIVE_UP(400·404·409 — 다시 보내도 같음) · KEY_ERROR(401) · RETRY(그 밖·네트워크) */
  function classifyReportStatus(status) {
    if (status === 200) return 'SENT'
    if (status === 400 || status === 404 || status === 409) return 'GIVE_UP'
    if (status === 401) return 'KEY_ERROR'
    return 'RETRY'
  }

  // ── 🔴 클릭 허용 — 이 함수 한 곳 ───────────────────────────────────────────

  /**
   * 누르려는 요소의 모양(page.js#describeElement) 과 목적이 맞을 때만 true.
   * desc = { closestChannel: 가장 가까운 .channel-card 의 data-channel | null, insideCombCard, isChannelCard,
   *          insideCurrencyTab, text, isPayButton, operateZoneChannel: 감싼 .operate-zone 의 data-channel | null, pageKind }
   * 🔴 월드페이(kjpayV2) 밖의 결제 수단 카드·조합결제 카드 안의 요소는 어떤 목적이든 false.
   * 🆕 0.3.0 — 비밀번호 창에서는 익스텐션이 아무것도 누르지 않습니다(사람이 직접). «passwordNext» 목적은 없앴습니다.
   */
  function isClickAllowed(desc, purpose, target) {
    // 🆕 0.6.0 누를 결제 수단은 월드페이(기본) 또는 서버가 지정한 외상 둘 중 하나만 — 그 밖 값은 월드페이로 봄
    const W = target === C.CREDIT_CHANNEL ? C.CREDIT_CHANNEL : C.WORLDPAY_CHANNEL
    if (!desc || typeof desc !== 'object') return false
    if (desc.insideCombCard === true) return false
    if (desc.closestChannel != null && desc.closestChannel !== W) return false
    switch (purpose) {
      case 'channel':
        return desc.isChannelCard === true && desc.closestChannel === W
      case 'currency':
        return desc.closestChannel == null && desc.insideCurrencyTab === true && isCnyText(desc.text)
      case 'pay': {
        if (desc.closestChannel != null || desc.isPayButton !== true) return false
        // 결제 버튼이 잡은 수단 — 있으면 kjpayV2 여야 하고, 묶음은 반드시 있어야 함
        if (desc.operateZoneChannel != null && desc.operateZoneChannel !== W) return false
        if (desc.operateZoneChannel == null && desc.pageKind !== 'single') return false
        // 글자가 «立即付款» 이어야 함(조합결제면 «组合付款») · 🆕 0.6.3 외상은 정확히 «普通支付»(🔴 «免密支付» 거절)
        const text = normalizeText(desc.text)
        if (text.includes(C.TEXT.creditNoPasswordText)) return false
        if (W === C.CREDIT_CHANNEL) return text === C.TEXT.creditPayButtonText
        return text.includes(C.TEXT.payButtonText) && !text.includes('组合')
      }
      default:
        return false
    }
  }

  // ── 비밀번호 단계(티켓 §4-5) — 🔴 에이전트는 실행하지 않음 · 이 판정만 단위 시험 ─────────

  /**
   * 이 프레임이 «1688 결제 페이지 안에 박힌 알리페이 비밀번호 창» 인가.
   * @param f { isTop, origin, pathname, parentOrigin(location.ancestorOrigins[0]) }
   */
  /** 🆕 0.5.0 결제 완료 글자 — 화면 글에서 처음 맞는 것(없으면 null) */
  function findSuccessText(text) {
    const t = normalizeText(text)
    return C.SUCCESS_DETECT.texts.find((x) => x && t.includes(x)) || null
  }

  /** 🆕 0.6.2 화면 글에서 «确认收货后付款 ¥915.00»(외상 · 수령 후 결제 금액) 전부 → 分 목록 */
  function extractCreditDueFens(text) {
    const out = []
    const re = /确认收货后付款\s*[¥￥]\s*([\d,]+(?:\s*\.\s*\d{1,2})?)/g
    let m
    const t = normalizeText(text)
    while ((m = re.exec(t)) !== null) {
      const f = parseYuanToFen(m[1].replace(/[\s,]/g, ''))
      out.push(Number.isSafeInteger(f) ? f : null)
    }
    return out
  }

  /**
   * 🆕 0.6.4 페이지 전체 글에서 «订单总金额:¥915.00» 금액들(分) — 외상 화면은 이 글이 `.ext-price-info-item` 밖에 있음(실측 2026-10-23).
   * 라벨 뒤 금액이 숫자가 아니면 null 로 넣어 멈추게 함.
   */
  function extractPageOrderTotalFens(text) {
    const out = []
    const t = normalizeText(text)
    const re = new RegExp(C.TEXT.orderTotalLabel + '\\s*:?\\s*([¥￥]?)\\s*([\\d,]+(?:\\s*\\.\\s*\\d{1,2})?)?', 'g')
    let m
    while ((m = re.exec(t)) !== null) {
      if (!m[2]) {
        out.push(null)
        continue
      }
      const f = parseYuanToFen(m[2].replace(/[\s,]/g, ''))
      out.push(Number.isSafeInteger(f) ? f : null)
    }
    return out
  }

  /** 🆕 0.6.0 외상 카드 글에서 «剩余额度 ¥508858.51» → 分(못 읽으면 null) */
  function parseCreditLimitFen(text) {
    const m = normalizeText(text).match(/剩余额度\s*[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/)
    if (!m) return null
    const f = parseYuanToFen(m[1].replace(/,/g, ''))
    return Number.isSafeInteger(f) ? f : null
  }

  /** 🆕 0.5.3 결제 실패 글자 — 화면 글에서 처음 맞는 것(없으면 null) */
  function findFailText(text) {
    const t = normalizeText(text)
    return C.SUCCESS_DETECT.failTexts.find((x) => x && t.includes(x)) || null
  }

  /**
   * 🆕 0.5.3 완료 화면 요약(실측 2026-10-23: «支付成功 · 跨境宝 | 共6笔订单 ¥11268.50») — 건수·금액(分)·수단 글자.
   * 못 읽으면 null 칸. 화면 글은 완료 글자 근처 600자만 봅니다.
   */
  function parseSuccessSummary(text) {
    const t = normalizeText(text)
    const i = Math.max(0, t.search(/支付成功|付款成功|交易成功|支付完成/))
    const near = t.slice(i, i + 600)
    const cnt = near.match(/共\s*(\d{1,3})\s*笔订单/)
    const amt = near.match(/[¥￥]\s*([\d,]+(?:\s*\.\s*\d{1,2})?)/)
    const fen = amt ? parseYuanToFen(amt[1].replace(/[\s,]/g, '')) : null
    return {
      orderCount: cnt ? Number(cnt[1]) : null,
      amountFen: Number.isSafeInteger(fen) ? fen : null,
      worldpay: /跨境宝/.test(near),
    }
  }

  /** 🆕 0.4.4 비밀번호 창 제목인가(여러 판본 글자 중 하나) */
  function isPasswordTitle(text) {
    const t = normalizeText(text)
    return C.PASSWORD_STEP.titleTexts.some((x) => t.includes(x))
  }

  /** 🆕 0.4.3 알리페이 비밀번호 창 출처 — https + *.alipay.com(실측 pcauth-site 하나만 보던 것을 넓힘) */
  function isAlipayOrigin(origin) {
    try {
      const u = new URL(String(origin))
      return u.protocol === 'https:' && (u.hostname === 'alipay.com' || u.hostname.endsWith('.alipay.com')) && !u.port
    } catch (e) {
      return false
    }
  }

  function isPasswordFrame(f) {
    if (!f || f.isTop !== false) return false
    if (!isAlipayOrigin(f.origin)) return false
    // 🆕 0.4.3 — 경로(/home)·바로 위 프레임만 보던 것을 넓힘: 알리페이 창이 한 겹 더 안에 박혀도(중간 프레임) 맨 위가 1688 결제 페이지면 우리 창
    const ancestors = Array.isArray(f.ancestorOrigins) ? f.ancestorOrigins : []
    return f.parentOrigin === C.PASSWORD_STEP.parentOrigin || ancestors[ancestors.length - 1] === C.PASSWORD_STEP.parentOrigin
  }

  /**
   * 🆕 0.3.0(W-1) — 비밀번호는 사람이 직접 넣습니다. 이 판정은 «이 창이 우리 결제로 뜬 비밀번호 창인가» 만 가립니다.
   * @param s { frame, payClickedByExtensionAt: ms|null, now, dialogTitle }
   * @returns {{ verdict: 'NONE'|'MANUAL', reason }}
   *   NONE = 우리 일 아님(아무것도 안 함) · MANUAL = «비밀번호를 직접 입력해 주세요» 안내(사람이 입력)
   */
  function decidePasswordStep(s) {
    const none = (reason) => ({ verdict: 'NONE', reason })
    if (!s || !isPasswordFrame(s.frame)) return none('NOT_PASSWORD_FRAME')
    if (!Number.isFinite(s.payClickedByExtensionAt)) return none('NO_PAY_CLICK')
    if (s.now < s.payClickedByExtensionAt || s.now - s.payClickedByExtensionAt > C.PASSWORD_STEP.windowMs) return none('PAY_CLICK_TOO_OLD')
    if (!isPasswordTitle(s.dialogTitle) && s.hasPasswordInput !== true) return none('NO_TITLE')
    // 🆕 0.4.0 — 자동 입력은 «시험 작업 + 1회용 표 있음 + 자동 입력 켜짐 + 아직 안 씀» 일 때만(background 가 판정해 넘김) · 그 밖은 사람이 직접
    if (s.revealAvailable === true) return { verdict: 'FILL', reason: null }
    return { verdict: 'MANUAL', reason: s.manualReason || null }
  }

  /** 글 안에 비밀번호 틀림 문구가 있나 */
  function hasPasswordError(text) {
    const t = normalizeText(text)
    return C.PASSWORD_STEP.errorTexts.some((e) => e && t.includes(e))
  }

  /** «비밀번호를 직접 입력해 주세요» 안내의 까닭 문구(0.3.0 — 사람이 직접 입력) */
  const PASSWORD_MANUAL_REASONS = Object.freeze({
    USER_INPUT: '비밀번호는 사람이 직접 입력합니다(익스텐션은 넣지 않습니다)',
    DRY_RUN: '시험 모드입니다 — 결제 비밀번호 단계는 사람이 직접',
    AUTO_FILL_OFF: '«비밀번호 자동 입력» 이 꺼져 있습니다 — 직접 입력해 주세요',
    NO_REVEAL_TOKEN: '저장된 비밀번호가 없습니다(관리자 웹 «결제 비밀번호 설정») — 직접 입력해 주세요',
    REVEAL_FAILED: '서버에서 비밀번호를 받지 못했습니다 — 직접 입력해 주세요',
    NO_INPUT: '비밀번호 칸을 찾지 못했습니다 — 직접 입력해 주세요',
    FILL_REJECTED: '비밀번호 칸이 자동 입력을 받지 않았습니다(칸을 비움) — 직접 입력해 주세요',
  })

  return Object.freeze({
    STOP_MESSAGES,
    KEEP_JOB_CODES,
    normalizeText,
    parseYuanToFen,
    formatFen,
    extractOrderNos,
    extractOrderTotalFens,
    parseCashierUrl,
    parseTrackerArgs,
    extractObjectAfterKey,
    summarizeBatchModel,
    pageKindOf,
    pageOrderNos,
    worldpayNotice,
    sameSet,
    validateJob,
    isJobAlive,
    matchJob,
    decideNext,
    isCnyText,
    finalAction,
    OUTCOME,
    classifyOutcome,
    isSafePayUrl,
    validateServerJob,
    sanitizeCode,
    serverResultFor,
    haltsAutoRun,
    classifyClaimStatus,
    classifyReportStatus,
    isClickAllowed,
    isPasswordFrame,
    isAlipayOrigin,
    isPasswordTitle,
    findSuccessText,
    findFailText,
    parseCreditLimitFen,
    extractCreditDueFens,
    extractPageOrderTotalFens,
    targetChannelOf,
    parseSuccessSummary,
    decidePasswordStep,
    hasPasswordError,
    PASSWORD_MANUAL_REASONS,
  })
})
