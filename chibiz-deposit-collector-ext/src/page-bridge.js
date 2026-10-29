/*
 * 페이지(MAIN world)에서 도는 다리. 콘텐츠 스크립트(bank-content.js)는 격리된 세계라 은행 페이지의 pbk.* 함수를 직접 못 부른다
 * (윈도우 실측 2026-10-29: [실행]이 «조회 안 됨» 으로 막힘). 그래서 이 파일이 페이지 안에서 명령을 받아 대신 호출한다.
 *  - 상태: <html data-chibiz-bank-bridge="ready|nofn">
 *  - 명령: document 에 CustomEvent 'chibiz-bank-cmd' (detail 은 JSON 문자열 {id, cmd:'submit'|'page', n})
 *  - 응답: CustomEvent 'chibiz-bank-ack' (detail JSON {id, ok, error})
 * 비밀번호·계좌번호 값은 읽지 않는다.
 */
;(function () {
  'use strict'
  function fn() {
    const p = window.pbk
    return p && p.quickService && p.quickService.acctInquiry && typeof p.quickService.acctInquiry.submitInquiry === 'function'
      ? p.quickService.acctInquiry.submitInquiry : null
  }
  function mark() {
    document.documentElement.setAttribute('data-chibiz-bank-bridge', fn() ? 'ready' : 'nofn')
  }
  document.addEventListener('chibiz-bank-cmd', function (e) {
    let d = {}
    try { d = JSON.parse(e.detail || '{}') } catch (err) { d = {} }
    let ok = true
    let error = ''
    try {
      if (d.cmd === 'submit') {
        const f = fn()
        if (!f) throw new Error('조회 함수 없음')
        f(document.forms['frmQuickInquiry'])
      } else if (d.cmd === 'page') {
        if (typeof window.goContinuousPage !== 'function') throw new Error('페이지 함수 없음')
        window.goContinuousPage(d.n, 'frmQuickInquiry', 'searchBtn')
      } else {
        throw new Error('알 수 없는 명령')
      }
    } catch (err) {
      ok = false
      error = String((err && err.message) || err)
    }
    document.dispatchEvent(new CustomEvent('chibiz-bank-ack', { detail: JSON.stringify({ id: d.id, ok: ok, error: error }) }))
  })
  mark()
  setInterval(mark, 2000)
})()
