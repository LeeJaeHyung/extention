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
                        parse(c.path("requestedAt").asText()), parse(c.path("expiresAt").asText()));
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

    /** 이름 정규화: 공백·법인 표기·특수문자 제거, 소문자 */
    static String normName(String s) {
        if (s == null) {
            return "";
        }
        return s.toLowerCase()
                .replaceAll("주식회사|\\(주\\)|㈜|유한회사|\\(유\\)|co\\.?,?\\s*ltd\\.?|inc\\.?|corp\\.?", "")
                .replaceAll("[\\s\\-_.,·()\\[\\]{}'\"`~!@#$%^&*+=|\\\\/:;<>?]", "");
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
                long amount = Db.toLong(c.get("amount"));
                long tol = Math.round(amount * toDouble(c.get("tolerance_pct")) / 100.0);
                LocalDateTime earliest = parse(Db.str(c.get("requested_at")).replace(' ', 'T')).minusDays(cfg.matching.beforeRequestDays);
                String wantAcct = siteAccount(Db.str(c.get("site_code")));
                Map<String, Object> hit = null;
                for (Map<String, Object> d : deps) {
                    if (used.contains(d.get("id"))) {
                        continue;
                    }
                    // 사이트에 계좌가 지정돼 있으면 그 계좌(끝4자리) 입금만
                    if (!wantAcct.isEmpty() && !Db.str(d.get("account_masked")).endsWith(wantAcct)) {
                        continue;
                    }
                    if (Math.abs(Db.toLong(d.get("deposit_amount")) - amount) > tol) {
                        continue;
                    }
                    if (!names.contains(normName(Db.str(d.get("memo"))))) {
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
                AgentLog.info("콜백 " + site.code + " 신청 " + claimId + " → " + rep.status());
            } catch (Exception e) {
                db.update("UPDATE deposit_claim SET callback_status = 'FAIL', callback_tries = callback_tries + 1, callback_at = NOW(), callback_last_error = ?, updated_at = NOW() WHERE id = ?",
                        Db.left(e.getMessage(), 300), r.get("id"));
                AgentLog.warn("콜백 실패 " + site.code + " " + claimId + " " + e.getMessage());
            }
        }
    }
}
