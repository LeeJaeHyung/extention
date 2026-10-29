/*
 * 관리자 웹(manifest 의 첫 content script 매치 출처) — 티켓 §4-2.
 *  - <html data-chibiz-worldpay-ext="버전"> 으로 «설치됨» 을 알림
 *  - window.postMessage({ source: 'chibiz-admin', type: 'WORLDPAY_JOB', job }, location.origin) 를 받아 background 로 넘김
 *  - 결과를 { source: 'chibiz-worldpay-ext', type: 'WORLDPAY_JOB_ACK', jobId, ok, reason } 로 돌려줌
 */
;(function (root) {
  'use strict'
  if (window.top !== window) return
  const C = root.ChibizWorldpayConfig
  const version = chrome.runtime.getManifest().version

  document.documentElement.setAttribute(C.INSTALLED_ATTR, version)

  function reply(payload) {
    window.postMessage(Object.assign({ source: C.MSG_SOURCE_EXT }, payload), location.origin)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== C.MSG_SOURCE_ADMIN) return
    if (data.type === C.MSG_TYPE_PING) {
      reply({ type: C.MSG_TYPE_READY, version })
      return
    }
    if (data.type !== C.MSG_TYPE_JOB) return
    const jobId = data.job && typeof data.job.jobId === 'string' ? data.job.jobId : null
    try {
      chrome.runtime.sendMessage({ type: 'REGISTER_JOB', job: data.job }, (res) => {
        if (chrome.runtime.lastError) {
          reply({ type: C.MSG_TYPE_JOB_ACK, jobId, ok: false, reason: 'EXTENSION_UNAVAILABLE' })
          return
        }
        reply({ type: C.MSG_TYPE_JOB_ACK, jobId, ok: !!(res && res.ok), reason: (res && res.reason) || null })
      })
    } catch (e) {
      // 익스텐션을 새로 고친 뒤 옛 content script 가 남은 경우 등
      reply({ type: C.MSG_TYPE_JOB_ACK, jobId, ok: false, reason: 'EXTENSION_RELOADED' })
    }
  })

  reply({ type: C.MSG_TYPE_READY, version })
})(globalThis)
