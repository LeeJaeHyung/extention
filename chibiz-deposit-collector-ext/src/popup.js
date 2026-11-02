// 툴바 아이콘 메뉴(0.1.6): 익스텐션 새로고침(코드 다시 읽기) · 은행 탭 새로고침
const BANK = 'https://www.kebhana.com/flex/quick/*'

document.getElementById('ver').textContent = '버전 ' + chrome.runtime.getManifest().version

async function reloadBankTabs() {
  const tabs = await chrome.tabs.query({ url: BANK })
  for (const t of tabs) chrome.tabs.reload(t.id)
  return tabs.length
}

document.getElementById('tabs').addEventListener('click', async () => {
  const n = await reloadBankTabs()
  document.getElementById('ver').textContent = '은행 탭 ' + n + '개 새로고침'
})

document.getElementById('reload').addEventListener('click', () => {
  // 폴더의 새 코드를 다시 읽는다. 다시 시작한 background 가 onInstalled 에서 열린 빠른조회 탭에 새 코드를 주입한다(탭 새로고침 없음).
  chrome.runtime.reload()
})
