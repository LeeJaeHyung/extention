package kr.chibiz.depositagent;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 신청 큐 대조 (docs/deposit-claim-agent-spec.md).
 *  - pollSec 마다 사이트별 pending 을 가져와 deposit_claim 에 병합 + 콜백 미전송분 전송
 *  - matchMin 마다(그리고 새 입금 직후) approved=0 입금 × PENDING 신청을 신청 시각 순으로 대조
 */
public class Matcher {
    private final Config cfg;
    private final Db db;
    private final SiteClient client = new SiteClient();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "matcher");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean matching = new AtomicBoolean(false);
    private volatile LocalDateTime lastPollAt;
    private volatile LocalDateTime lastMatchAt;

    public Matcher(Config cfg, Db db) {
        this.cfg = cfg;
        this.db = db;
    }

    public List<Config.Site> sites() {
        List<Config.Site> out = new ArrayList<>();
        for (Config.Site s : cfg.sites) {
            if (s.enabled()) {
                out.add(s);
            }
        }
        return out;
    }

    public boolean enabled() {
        return !sites().isEmpty();
    }

    public LocalDateTime lastPollAt() {
        return lastPollAt;
    }

    public LocalDateTime lastMatchAt() {
        return lastMatchAt;
    }

    public void start() {
        if (!enabled()) {
            AgentLog.info("사이트 설정 없음(config.sites) — 입금 수집만 하고 신청 큐 대조는 하지 않음");
            return;
        }
        AgentLog.info("신청 큐 대조 켜짐 " + sites().stream().map(s -> s.code).toList() + " · 폴링 " + cfg.matching.pollSec + "초 · 대조 " + cfg.matching.matchMin + "분");
        exec.scheduleWithFixedDelay(this::safeTick, 3, Math.max(10, cfg.matching.pollSec), TimeUnit.SECONDS);
        exec.scheduleWithFixedDelay(() -> safeMatch("schedule"), 60, Math.max(1, cfg.matching.matchMin) * 60L, TimeUnit.SECONDS);
    }

    /**
     * 시스템 오류 보고 → 각 사이트 POST /deposit/claims/agent/alert (서버가 메일·알림톡 ERROR_SYSTEM 으로 전달).
     * 같은 code 는 30분에 한 번만(서버에도 억제가 있지만 네트워크 낭비를 줄임).
     */
    private final java.util.Map<String, Long> lastAlertAt = new java.util.concurrent.ConcurrentHashMap<>();

    public void reportSystemError(String code, String message, String target, int count, String action) {
        long now = System.currentTimeMillis();
        Long last = lastAlertAt.get(code);
        if (last != null && now - last < 30L * 60 * 1000) {
            return;
        }
        lastAlertAt.put(code, now);
        List<Config.Site> sites = sites();
        if (sites.isEmpty()) {
            AgentLog.warn("시스템 오류 보고 못 함(사이트 키 없음): " + code + " " + message);
            return;
        }
        exec.execute(() -> {
            for (Config.Site site : sites) {
                try {
                    java.util.Map<String, Object> body = new LinkedHashMap<>();
                    body.put("source", "입금 수집");
                    body.put("code", code);
                    body.put("message", message);
                    body.put("target", target);
                    body.put("count", count);
                    body.put("action", action);
                    SiteClient.Reply r = client.post(site, "/deposit/claims/agent/alert", body);
                    AgentLog.info("시스템 오류 보고 " + site.code + " " + code + " → " + r.status());
                } catch (Exception e) {
                    AgentLog.warn("시스템 오류 보고 실패 " + site.code + " " + e.getMessage());
                }
            }
        });
    }

    /** 5분마다: 마지막 수집 성공 뒤 alertNoRunMinutes 가 지났는데 실행 기록이 없으면(탭 닫힘·PC 절전) 보고 + 계좌별 끊김 보고 */
    void watchdog() {
        watchCollectors();
        try {
            List<Map<String, Object>> st = db.query("SELECT MAX(run_at) last_run, MAX(CASE WHEN ok=1 THEN run_at END) last_ok FROM collect_run");
            if (st.isEmpty() || st.get(0).get("last_run") == null) {
                return;
            }
            LocalDateTime lastRun = parse(Db.str(st.get(0).get("last_run")).replace(' ', 'T'));
            long idleMin = java.time.Duration.between(lastRun, LocalDateTime.now()).toMinutes();
            if (idleMin >= cfg.matching.alertNoRunMinutes) {
                reportSystemError("COLLECT_STOPPED", "입금 수집이 " + idleMin + "분째 멈춤(실행 기록 없음 — 탭 닫힘·PC 절전·크롬 종료)",
                        "마지막 실행 " + Db.str(st.get(0).get("last_run")), 1, "수집 PC 에서 빠른조회 탭을 열고 계좌 정보 입력 후 [실행]");
            }
        } catch (Exception e) {
            AgentLog.warn("감시 오류 " + e.getMessage());
        }
    }

    /**
     * 계좌별 끊김: 한 번이라도 붙었던 계좌(collector 행)가 alertNoRunMinutes 동안 보고가 없으면 그 계좌만 짚어 보고(메일·알림톡).
     * 끊김마다 한 번만(alerted_at) — 다시 보고가 오면 upsertCollector 가 alerted_at 을 지우므로 다음 끊김 때 또 보고한다.
     * 전체 멈춤(COLLECT_STOPPED)과 달리 다른 탭이 돌고 있어도 잡는다. 보고 코드에 끝4자리를 넣어 reportSystemError 의 30분 중복 억제가 계좌별로 걸리게 한다.
     */
    private void watchCollectors() {
        try {
            List<Map<String, Object>> rows = db.query("SELECT account_masked, last_seen_at, alerted_at FROM collector WHERE alerted_at IS NULL");
            for (Map<String, Object> r : rows) {
                String acct = Db.str(r.get("account_masked"));
                LocalDateTime last = parse(Db.str(r.get("last_seen_at")).replace(' ', 'T'));
                long idleMin = java.time.Duration.between(last, LocalDateTime.now()).toMinutes();
                if (idleMin < cfg.matching.alertNoRunMinutes) {
                    continue;
                }
                String label = cfg.accountLabel(acct);
                db.markCollectorAlerted(acct);
                AgentLog.warn("수집 끊김 " + label + " — " + idleMin + "분째 보고 없음(마지막 " + Db.str(r.get("last_seen_at")) + ")");
                reportSystemError("COLLECT_DISCONNECT_" + acct.replaceAll("[^0-9]", ""),
                        "계좌 " + label + " 수집이 " + idleMin + "분째 멈춤(탭 닫힘·세션 만료·PC 절전)",
                        "마지막 보고 " + Db.str(r.get("last_seen_at")), 1,
                        "수집 PC 크롬에서 " + label + " 빠른조회 탭을 열고 계좌 정보 입력 후 [실행]");
            }
        } catch (Exception e) {
            AgentLog.warn("계좌별 감시 오류 " + e.getMessage());
        }
    }

    public void startWatchdog() {
        exec.scheduleWithFixedDelay(this::watchdog, 5, 5, TimeUnit.MINUTES);
    }

    /** 새 입금이 들어왔을 때 바로 한 번 */
    public void matchSoon() {
        if (enabled()) {
            exec.execute(() -> safeMatch("new-deposits"));
        }
    }

    /** 수동(화면 버튼·/match-now): 폴링 → 대조 → 콜백 */
    public void runNow() {
        exec.execute(() -> {
            safeTick();
            safeMatch("manual");
        });
    }

    private void safeTick() {
        try {
            pollClaims();
            sendCallbacks();
            lastPollAt = LocalDateTime.now();
        } catch (Exception e) {
            AgentLog.warn("폴링 오류 " + e.getMessage());
        }
    }

    private void safeMatch(String reason) {
        try {
            runMatch(reason);
        } catch (Exception e) {
            AgentLog.warn("대조 오류 " + e.getMessage());
        }
    }

    // ── 폴링·병합 ──

    void pollClaims() throws Exception {
        for (Config.Site site : sites()) {
            SiteClient.Reply r;
            try {
                r = client.get(site, "/deposit/claims/agent/pending");
            } catch (Exception e) {
                AgentLog.warn("큐 조회 실패 " + site.code + " " + e.getMessage());
                continue;
            }
            if (r.status() != 200 || r.body() == null || !r.body().path("data").isArray()) {
                AgentLog.warn("큐 조회 실패 " + site.code + " " + r.status() + " " + Db.left(r.raw(), 120));
                continue;
            }
            Set<String> seen = new HashSet<>();
            for (JsonNode c : r.body().get("data")) {
                String claimId = c.path("claimId").asText();
                if (claimId.isEmpty()) {
                    continue;
                }
                seen.add(claimId);
                List<String> names = new ArrayList<>();
                if (c.path("depositorNames").isArray()) {
                    for (JsonNode n : c.get("depositorNames")) {
                        if (!n.asText().isBlank()) {
                            names.add(n.asText().trim());
                        }
                    }
                } else if (!c.path("depositorName").asText().isBlank()) {
                    names.add(c.path("depositorName").asText().trim());
                }
                db.upsertClaim(site.code, claimId, c.path("memberId").asText(null), c.path("memberName").asText(null), String.join(",", names),
                        c.path("amount").asLong(), c.path("tolerancePct").asDouble(0), c.path("claimType").asText(null), c.path("refId").asText(null),
                        c.path("account").asText(null), amountsCsv(c.path("amounts")), parse(c.path("requestedAt").asText()), parse(c.path("expiresAt").asText()));
            }
            for (String id : db.pendingClaimIds(site.code)) {
                if (!seen.contains(id)) {
                    db.cancelClaim(site.code, id);
                }
            }
        }
    }

    private static LocalDateTime parse(String s) {
        if (s == null || s.isBlank()) {
            return LocalDateTime.now();
        }
        try {
            return LocalDateTime.parse(s.length() > 19 ? s.substring(0, 19) : s, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
        } catch (Exception e) {
            return LocalDateTime.now();
        }
    }

    // ── 대조 ──

    /** 사이트가 준 금액 목록(JSON 배열) → "a,b,c" (없으면 null) */
    static String amountsCsv(JsonNode arr) {
        if (arr == null || !arr.isArray() || arr.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (JsonNode n : arr) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(n.asLong());
        }
        return sb.toString();
    }

    /** 신청이 맞다고 보는 금액들: amounts 목록이 있으면 그것(정확히 일치), 없으면 amount ± 오차 */
    static boolean amountMatches(Map<String, Object> claim, long depositAmount) {
        String list = Db.str(claim.get("amounts"));
        if (!list.isBlank()) {
            for (String p : list.split(",")) {
                try {
                    if (Long.parseLong(p.trim()) == depositAmount) {
                        return true;
                    }
                } catch (NumberFormatException ignored) {
                    // 잘못된 항목은 건너뛴다
                }
            }
            return false;
        }
        long amount = Db.toLong(claim.get("amount"));
        long tol = Math.round(amount * toDouble(claim.get("tolerance_pct")) / 100.0);
        return Math.abs(depositAmount - amount) <= tol;
    }

    /** 이름 정규화: 공백·법인 표기·특수문자 제거, 소문자 */
    /**
     * 입금자명 정규화(J 2026-11-02 확정): «공백 제거 + 소문자». 회사 접두어·기호는 건드리지 않는다 —
     * 회원이 신청 때 적은 입금자명과 은행 적요가 공백 빼고 글자 그대로 같아야 한다.
     */
    static String normName(String s) {
        if (s == null) {
            return "";
        }
        // 대소문자는 구분하지 않는다(J 2026-11-02 18:50) — 영문 아이디·상호
        return s.replaceAll("\\s+", "").toLowerCase();
    }

    /**
     * 정규화한 은행 입금자명이 후보 중 하나와 «정확히 같은가»(J 2026-11-02: 포함·앞부분 일치 없음).
     * 금액은 따로 원 단위까지 맞춰 보고, 이름은 공백 제거 뒤 완전 일치만 인정한다.
     */
    static boolean nameMatches(List<String> names, String bank) {
        if (bank == null || bank.isEmpty()) {
            return false;
        }
        for (String c : names) {
            if (!c.isEmpty() && bank.equals(c)) {
                return true;
            }
        }
        return false;
    }

    void runMatch(String reason) throws Exception {
        if (!matching.compareAndSet(false, true)) {
            return;
        }
        try {
            List<Map<String, Object>> claims = db.query("SELECT * FROM deposit_claim WHERE status = 'PENDING' ORDER BY requested_at, id");
            if (claims.isEmpty()) {
                lastMatchAt = LocalDateTime.now();
                return;
            }
            List<Map<String, Object>> deps = db.query(
                    "SELECT * FROM bank_deposit WHERE approved = 0 AND deposit_amount > 0 AND tx_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY tx_date, tx_time, id",
                    cfg.matching.lookbackDays);
            Set<Object> used = new HashSet<>();
            int matched = 0;
            for (Map<String, Object> c : claims) {
                List<String> names = new ArrayList<>();
                for (String n : Db.str(c.get("depositor_names")).split(",")) {
                    String nn = normName(n);
                    if (!nn.isEmpty()) {
                        names.add(nn);
                    }
                }
                LocalDateTime earliest = parse(Db.str(c.get("requested_at")).replace(' ', 'T')).minusDays(cfg.matching.beforeRequestDays);
                // 신청에 계좌가 있으면 그 계좌만(KRW 인보이스 7304 · USD 인보이스 8338), 없으면 사이트 설정 계좌
                String claimAcct = Db.str(c.get("account")).replaceAll("[^0-9]", "");
                String wantAcct = claimAcct.isEmpty() ? siteAccount(Db.str(c.get("site_code"))) : claimAcct;
                Map<String, Object> hit = null;
                for (Map<String, Object> d : deps) {
                    if (used.contains(d.get("id"))) {
                        continue;
                    }
                    // 사이트에 계좌가 지정돼 있으면 그 계좌(끝4자리) 입금만
                    if (!wantAcct.isEmpty() && !Db.str(d.get("account_masked")).endsWith(wantAcct)) {
                        continue;
                    }
                    if (!amountMatches(c, Db.toLong(d.get("deposit_amount")))) {
                        continue;
                    }
                    if (!nameMatches(names, normName(Db.str(d.get("memo"))))) {
                        continue;
                    }
                    if (txAt(d).isBefore(earliest)) {
                        continue;
                    }
                    hit = d;
                    break;
                }
                if (hit == null) {
                    continue;
                }
                used.add(hit.get("id"));
                db.update("UPDATE bank_deposit SET approved = 1, approved_claim_id = ?, approved_at = NOW() WHERE id = ? AND approved = 0", c.get("id"), hit.get("id"));
                db.update("UPDATE deposit_claim SET status = 'MATCHED', bank_deposit_id = ?, matched_depositor = ?, matched_amount = ?, matched_tx_date = ?, matched_tx_time = ?, matched_at = NOW(), callback_status = 'NONE', updated_at = NOW() WHERE id = ? AND status = 'PENDING'",
                        hit.get("id"), hit.get("memo"), hit.get("deposit_amount"), hit.get("tx_date"), hit.get("tx_time"), c.get("id"));
                matched++;
                AgentLog.info("매칭 " + c.get("site_code") + " 신청 " + c.get("claim_id") + " " + c.get("claim_type") + " ← " + hit.get("memo") + " " + hit.get("deposit_amount") + "원 " + hit.get("tx_date") + " " + hit.get("tx_time"));
            }
            lastMatchAt = LocalDateTime.now();
            if (matched > 0) {
                sendCallbacks();
            }
        } finally {
            matching.set(false);
        }
    }

    /** 사이트 설정의 계좌 끝4자리(없으면 빈 문자열) */
    private String siteAccount(String siteCode) {
        for (Config.Site s : cfg.sites) {
            if (siteCode.equals(s.code) && s.account != null && !s.account.isBlank()) {
                return s.account.replaceAll("[^0-9]", "");
            }
        }
        return "";
    }

    private static LocalDateTime txAt(Map<String, Object> d) {
        try {
            Object date = d.get("tx_date");
            LocalDate ld = date instanceof java.sql.Date sd ? sd.toLocalDate() : LocalDate.parse(Db.str(date).substring(0, 10));
            String t = Db.str(d.get("tx_time"));
            LocalTime lt = t.length() >= 5 ? LocalTime.parse(t.substring(0, 5)) : LocalTime.MIDNIGHT;
            return LocalDateTime.of(ld, lt);
        } catch (Exception e) {
            return LocalDateTime.now();
        }
    }

    private static double toDouble(Object o) {
        if (o instanceof Number n) {
            return n.doubleValue();
        }
        try {
            return Double.parseDouble(Db.str(o));
        } catch (Exception e) {
            return 0;
        }
    }

    // ── 콜백 ──

    void sendCallbacks() throws Exception {
        List<Map<String, Object>> rows = db.query(
                "SELECT c.*, d.memo, d.deposit_amount, d.tx_date, d.tx_time FROM deposit_claim c JOIN bank_deposit d ON d.id = c.bank_deposit_id"
                        + " WHERE c.status = 'MATCHED' AND c.callback_status IN ('NONE','FAIL') AND c.callback_tries < ? ORDER BY c.matched_at LIMIT 50",
                cfg.matching.maxCallbackTries);
        for (Map<String, Object> r : rows) {
            Config.Site site = null;
            for (Config.Site s : sites()) {
                if (s.code.equals(Db.str(r.get("site_code")))) {
                    site = s;
                }
            }
            if (site == null) {
                continue;
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("bankDepositId", r.get("bank_deposit_id"));
            body.put("depositorName", r.get("memo"));
            body.put("amount", Db.toLong(r.get("deposit_amount")));
            body.put("txDate", Db.str(r.get("tx_date")).substring(0, Math.min(10, Db.str(r.get("tx_date")).length())));
            body.put("txTime", r.get("tx_time"));
            body.put("matchedAt", LocalDateTime.now().withNano(0).toString());
            String claimId = Db.str(r.get("claim_id"));
            try {
                SiteClient.Reply rep = client.post(site, "/deposit/claims/agent/" + claimId + "/matched", body);
                boolean done = rep.status() == 200 || rep.status() == 409;
                db.update("UPDATE deposit_claim SET callback_status = ?, callback_tries = callback_tries + 1, callback_at = NOW(), callback_last_error = ?, updated_at = NOW() WHERE id = ?",
                        done ? (rep.status() == 200 ? "OK" : "ALREADY") : "FAIL", done ? null : Db.left(rep.status() + " " + rep.raw(), 300), r.get("id"));
                if (rep.status() == 200) {
                    // 서버가 송금내역을 갱신했음 — 입금 쪽에도 확인 표시
                    db.update("UPDATE bank_deposit SET remit_updated = 1, remit_updated_at = NOW() WHERE id = ?", r.get("bank_deposit_id"));
                }
                AgentLog.info("콜백 " + site.code + " 신청 " + claimId + " → " + rep.status());
            } catch (Exception e) {
                db.update("UPDATE deposit_claim SET callback_status = 'FAIL', callback_tries = callback_tries + 1, callback_at = NOW(), callback_last_error = ?, updated_at = NOW() WHERE id = ?",
                        Db.left(e.getMessage(), 300), r.get("id"));
                AgentLog.warn("콜백 실패 " + site.code + " " + claimId + " " + e.getMessage());
            }
        }
    }
}
