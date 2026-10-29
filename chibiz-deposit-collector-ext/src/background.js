/*
 * 차이비즈 입금 수집 — background (service worker)
 * content script(bank-content.js)는 다른 출처로 직접 fetch 할 수 없어서, 여기서 host_permissions(127.0.0.1:18080)로 에이전트에 보낸다.
 */
importScripts('config.js')
const C = self.ChibizDepositConfig
const BANK_ORIGIN = 'https://www.kebhana.com'

function senderOrigin(sender) {
  try {
    return new URL(sender.url || (sender.tab && sender.tab.url) || '').origin
  } catch (e) {
    return ''
  }
}

const handlers = {
  /** 입금 행 묶음 → 에이전트 /deposits */
  async BANK_DEPOSITS(msg, sender) {
    if (senderOrigin(sender) !== BANK_ORIGIN || !sender.tab) return { ok: false, reason: 'NOT_BANK_ORIGIN' }
    const rows = Array.isArray(msg.rows) ? msg.rows.slice(0, 500) : []
    if (rows.length === 0) return { ok: true, inserted: 0 }
    try {
      const res = await fetch(C.BANK.agentUrl + '/deposits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, fetchedAt: msg.fetchedAt || new Date().toISOString(), extVersion: chrome.runtime.getManifest().version }),
      })
      if (!res.ok) return { ok: false, reason: '에이전트 응답 ' + res.status }
      const body = await res.json().catch(() => ({}))
      return { ok: true, inserted: body.inserted || 0, duplicates: body.duplicates || 0 }
    } catch (e) {
      return { ok: false, reason: '에이전트에 연결할 수 없음(실행 중인지 확인): ' + (e && e.message) }
    }
  },

  /** 실행 1회 결과 → 에이전트 /runs (30일 연속 수집 시험 기록) */
  async BANK_RUN(msg, sender) {
    if (senderOrigin(sender) !== BANK_ORIGIN || !sender.tab) return { ok: false }
    try {
      await fetch(C.BANK.agentUrl + '/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: !!msg.ok, rowsRead: msg.rowsRead || 0, inserted: msg.inserted || 0, error: String(msg.error || '').slice(0, 500), at: msg.at, extVersion: chrome.runtime.getManifest().version }),
      })
    } catch (e) {
      // 기록 실패는 무시
    }
    return { ok: true }
  },
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string' || !handlers[msg.type]) return false
  handlers[msg.type](msg, sender)
    .then(sendResponse)
    .catch((e) => {
      console.warn('[chibiz-deposit] 처리 실패', msg.type, e && e.message)
      sendResponse({ ok: false, reason: 'INTERNAL' })
    })
  return true
})
