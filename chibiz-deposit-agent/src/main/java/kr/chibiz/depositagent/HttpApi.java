package kr.chibiz.depositagent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * 익스텐션이 부르는 로컬 HTTP (127.0.0.1 만).
 *  POST /deposits · POST /runs · GET /health · GET /summary · GET /claims?status= · GET /matches · POST /match-now · POST /review-now · GET /reviews?minutes=
 *  입금 처리 확인 앱(J 2026-11-05): GET /deposits/unprocessed?days= · GET /deposits/processed?days= · POST /deposits/{id}/process · POST /deposits/{id}/cancel · GET /deposits/actions?days=
 */
public class HttpApi {
    private static final ObjectMapper M = new ObjectMapper();
    private final Config cfg;
    private final Db db;
    private final Matcher matcher;
    private final Runnable onDeposits;
    private HttpServer server;

    public HttpApi(Config cfg, Db db, Matcher matcher, Runnable onDeposits) {
        this.cfg = cfg;
        this.db = db;
        this.matcher = matcher;
        this.onDeposits = onDeposits;
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", cfg.port), 16);
        server.createContext("/", this::handle);
        server.setExecutor(Executors.newFixedThreadPool(4, r -> {
            Thread t = new Thread(r, "http");
            t.setDaemon(true);
            return t;
        }));
        server.start();
        AgentLog.info("입금 에이전트 HTTP 시작 http://127.0.0.1:" + cfg.port);
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        try {
            if ("OPTIONS".equals(method)) {
                send(ex, 204, Map.of());
                return;
            }
            if ("GET".equals(method) && "/health".equals(path)) {
                db.query("SELECT 1");
                send(ex, 200, Map.of("ok", true, "db", cfg.db.database, "port", cfg.port, "sites", matcher.sites().stream().map(s -> s.code).toList()));
                return;
            }
            if ("GET".equals(method) && "/summary".equals(path)) {
                send(ex, 200, summary());
                return;
            }
            if ("GET".equals(method) && "/claims".equals(path)) {
                String q = ex.getRequestURI().getQuery();
                String st = q != null && q.startsWith("status=") ? q.substring(7) : null;
                send(ex, 200, st == null ? db.query("SELECT * FROM deposit_claim ORDER BY id DESC LIMIT 200") : db.query("SELECT * FROM deposit_claim WHERE status = ? ORDER BY id DESC LIMIT 200", st));
                return;
            }
            if ("GET".equals(method) && "/matches".equals(path)) {
                send(ex, 200, db.query("SELECT site_code, claim_id, claim_type, amount, matched_depositor, matched_amount, matched_tx_date, matched_tx_time, matched_at, callback_status, callback_tries, callback_last_error FROM deposit_claim WHERE status = 'MATCHED' ORDER BY matched_at DESC LIMIT 200"));
                return;
            }
            if ("POST".equals(method) && "/deposits".equals(path)) {
                Map<String, Object> body = readJson(ex);
                Object rowsObj = body.get("rows");
                List<Map<String, Object>> rows = rowsObj instanceof List<?> l ? (List<Map<String, Object>>) (List<?>) l : List.of();
                LocalDateTime fetchedAt = parseIso(Db.str(body.get("fetchedAt")));
                int[] r = db.saveDeposits(rows, fetchedAt, Db.str(body.get("extVersion")));
                if (r[0] > 0) {
                    AgentLog.info("입금 저장 " + r[0] + "건 (중복 " + r[1] + ")");
                    matcher.matchSoon();
                }
                onDeposits.run();
                send(ex, 200, Map.of("ok", true, "inserted", r[0], "duplicates", r[1]));
                return;
            }
            if ("POST".equals(method) && "/runs".equals(path)) {
                Map<String, Object> body = readJson(ex);
                boolean ok = Boolean.TRUE.equals(body.get("ok"));
                String acct = Db.str(body.get("accountMasked"));
                db.saveRun(parseIso(Db.str(body.get("at"))), ok, (int) Db.toLong(body.get("rowsRead")), (int) Db.toLong(body.get("inserted")), Db.str(body.get("error")), Db.str(body.get("extVersion")), acct);
                db.upsertCollector(acct, Db.str(body.get("extVersion")), parseIso(Db.str(body.get("at"))), true);
                if (!ok) {
                    AgentLog.warn("수집 실패 보고: " + Db.str(body.get("error")));
                    List<Map<String, Object>> recent = db.query("SELECT ok FROM collect_run ORDER BY id DESC LIMIT ?", cfg.matching.alertAfterFails);
                    boolean allFail = recent.size() >= cfg.matching.alertAfterFails && recent.stream().allMatch(r -> Db.toLong(r.get("ok")) == 0);
                    if (allFail) {
                        matcher.reportSystemError("COLLECT_FAIL", "입금 수집 연속 실패: " + Db.left(Db.str(body.get("error")), 80), "빠른조회 탭", cfg.matching.alertAfterFails,
                                "수집 PC 크롬에서 빠른조회에 계좌 정보를 다시 넣고 조회 후 [실행]");
                    }
                }
                onDeposits.run();
                send(ex, 200, Map.of("ok", true));
                return;
            }
            if ("POST".equals(method) && "/collector".equals(path)) {
                // 익스텐션 [실행]: 이 탭이 조회하는 계좌 → 화면 «수집 연결»
                Map<String, Object> body = readJson(ex);
                String acct = Db.str(body.get("accountMasked"));
                db.upsertCollector(acct, Db.str(body.get("extVersion")), parseIso(Db.str(body.get("at"))), false);
                AgentLog.info("수집 연결 " + (acct.isEmpty() ? "(계좌 못 읽음)" : cfg.accountLabel(acct)) + " ext " + Db.str(body.get("extVersion")));
                onDeposits.run();
                send(ex, 200, Map.of("ok", true));
                return;
            }
            if ("POST".equals(method) && "/match-now".equals(path)) {
                matcher.runNow();
                send(ex, 200, Map.of("ok", true));
                return;
            }
            // AI 검토(J 2026-11-04): 시간별 점검 메일(수집 PC 예약 작업)이 정시에 부른다 — 동기 실행 뒤 요약, 결과 목록은 /reviews
            if ("POST".equals(method) && "/review-now".equals(path)) {
                send(ex, 200, matcher.runReview("http"));
                return;
            }
            if ("GET".equals(method) && "/reviews".equals(path)) {
                int minutes = 0;
                String rq = ex.getRequestURI().getQuery();
                if (rq != null) {
                    for (String kv : rq.split("&")) {
                        if (kv.startsWith("minutes=")) {
                            try {
                                minutes = Integer.parseInt(kv.substring(8));
                            } catch (NumberFormatException ignored) {
                                // 기본 0 = 전체(최근 200건)
                            }
                        }
                    }
                }
                send(ex, 200, minutes > 0
                        ? db.query("SELECT site_code, claim_id, bank_deposit_id, claim_names, bank_memo, amount, verdict, confidence, reason, sent_at FROM ai_review WHERE sent_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE) ORDER BY id DESC LIMIT 200", minutes)
                        : db.query("SELECT site_code, claim_id, bank_deposit_id, claim_names, bank_memo, amount, verdict, confidence, reason, sent_at FROM ai_review ORDER BY id DESC LIMIT 200"));
                return;
            }
            if (path.startsWith("/deposits/")) {
                handleDeposits(ex, method, path);
                return;
            }
            send(ex, 404, Map.of("ok", false, "reason", "not found"));
        } catch (Exception e) {
            AgentLog.warn("HTTP 오류 " + method + " " + path + " " + e.getMessage());
            send(ex, 500, Map.of("ok", false, "reason", String.valueOf(e.getMessage())));
        }
    }

    /** 입금 처리 확인 앱 — 미처리 목록 · 처리 내역 · 처리(MANUAL 승인) · 취소(사람이 처리한 것만). 자동 매칭(AUTO)·관리자 영수증 적립(ADMIN) 은 여기서 취소하지 않는다 */
    private void handleDeposits(HttpExchange ex, String method, String path) throws Exception {
        String q = ex.getRequestURI().getQuery();
        int days = 14;
        if (q != null) {
            for (String kv : q.split("&")) {
                if (kv.startsWith("days=")) {
                    try {
                        days = Math.max(1, Math.min(90, Integer.parseInt(kv.substring(5))));
                    } catch (NumberFormatException ignored) {
                        // 기본 14일
                    }
                }
            }
        }
        if ("GET".equals(method) && "/deposits/unprocessed".equals(path)) {
            send(ex, 200, label(db.query("SELECT id, tx_date, tx_time, kind, memo, deposit_amount, balance, branch, account_masked, fetched_at FROM bank_deposit WHERE approved = 0 AND deposit_amount > 0 AND tx_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY tx_date DESC, tx_time DESC, id DESC LIMIT 500", days)));
            return;
        }
        if ("GET".equals(method) && "/deposits/processed".equals(path)) {
            send(ex, 200, label(db.query("SELECT id, tx_date, tx_time, kind, memo, deposit_amount, account_masked, approved_by, approved_operator, approved_note, approved_claim_id, approved_at FROM bank_deposit WHERE approved = 1 AND tx_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY approved_at DESC, id DESC LIMIT 500", days)));
            return;
        }
        if ("GET".equals(method) && "/deposits/actions".equals(path)) {
            send(ex, 200, db.query("SELECT id, bank_deposit_id, action, operator, note, memo, amount, acted_at FROM deposit_action WHERE acted_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY id DESC LIMIT 500", days));
            return;
        }
        if ("POST".equals(method)) {
            String[] parts = path.split("/");
            // /deposits/{id}/process · /deposits/{id}/cancel
            if (parts.length == 4) {
                long id;
                try {
                    id = Long.parseLong(parts[2]);
                } catch (NumberFormatException e) {
                    send(ex, 400, Map.of("ok", false, "reason", "id"));
                    return;
                }
                Map<String, Object> body = readJson(ex);
                String operator = Db.left(Db.str(body.get("operator")).trim(), 50);
                String note = Db.left(Db.str(body.get("note")).trim(), 200);
                if (operator.isEmpty()) {
                    send(ex, 400, Map.of("ok", false, "reason", "operator(SuperID) 없음"));
                    return;
                }
                List<Map<String, Object>> rows = db.query("SELECT id, memo, deposit_amount, approved, approved_by FROM bank_deposit WHERE id = ?", id);
                if (rows.isEmpty()) {
                    send(ex, 404, Map.of("ok", false, "reason", "입금 없음"));
                    return;
                }
                Map<String, Object> d = rows.get(0);
                if ("process".equals(parts[3])) {
                    int n = db.update("UPDATE bank_deposit SET approved = 1, approved_by = 'MANUAL', approved_operator = ?, approved_note = ?, approved_at = NOW() WHERE id = ? AND approved = 0", operator, note.isEmpty() ? null : note, id);
                    if (n == 0) {
                        send(ex, 409, Map.of("ok", false, "reason", "이미 처리됨(" + Db.str(d.get("approved_by")) + ")"));
                        return;
                    }
                    db.update("INSERT INTO deposit_action (bank_deposit_id, action, operator, note, memo, amount) VALUES (?,?,?,?,?,?)", id, "PROCESS", operator, note.isEmpty() ? null : note, d.get("memo"), d.get("deposit_amount"));
                    AgentLog.info("입금 처리(사람) " + operator + " ← " + d.get("memo") + " " + d.get("deposit_amount") + "원 #" + id + (note.isEmpty() ? "" : " · " + note));
                    onDeposits.run();
                    send(ex, 200, Map.of("ok", true));
                    return;
                }
                if ("cancel".equals(parts[3])) {
                    String by = Db.str(d.get("approved_by"));
                    if (Db.toLong(d.get("approved")) != 1) {
                        send(ex, 409, Map.of("ok", false, "reason", "처리된 입금이 아님"));
                        return;
                    }
                    if (!"MANUAL".equals(by)) {
                        send(ex, 409, Map.of("ok", false, "reason", ("AUTO".equals(by) ? "에이전트 자동 매칭(서버 적립됨)" : "관리자 영수증 적립") + " 건은 여기서 취소할 수 없음"));
                        return;
                    }
                    db.update("UPDATE bank_deposit SET approved = 0, approved_by = NULL, approved_operator = NULL, approved_note = NULL, approved_claim_id = NULL, approved_at = NULL WHERE id = ? AND approved = 1 AND approved_by = 'MANUAL'", id);
                    db.update("INSERT INTO deposit_action (bank_deposit_id, action, operator, note, memo, amount) VALUES (?,?,?,?,?,?)", id, "CANCEL", operator, note.isEmpty() ? null : note, d.get("memo"), d.get("deposit_amount"));
                    AgentLog.info("입금 처리 취소(사람) " + operator + " ← " + d.get("memo") + " " + d.get("deposit_amount") + "원 #" + id + (note.isEmpty() ? "" : " · " + note));
                    onDeposits.run();
                    send(ex, 200, Map.of("ok", true));
                    return;
                }
            }
        }
        send(ex, 404, Map.of("ok", false, "reason", "not found"));
    }

    /** account_masked → 계좌 이름 붙임 */
    private List<Map<String, Object>> label(List<Map<String, Object>> rows) {
        for (Map<String, Object> r : rows) {
            r.put("account", cfg.accountLabel(Db.str(r.get("account_masked"))));
        }
        return rows;
    }

    public Map<String, Object> summary() throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("today", first(db.query("SELECT COUNT(*) n, IFNULL(SUM(deposit_amount),0) amount FROM bank_deposit WHERE tx_date = CURDATE()")));
        out.put("total", first(db.query("SELECT COUNT(*) n, IFNULL(SUM(approved),0) approved, IFNULL(SUM(approved_by = 'ADMIN'),0) approved_admin, MIN(fetched_at) first_at, MAX(fetched_at) last_at FROM bank_deposit")));
        List<Map<String, Object>> runs = db.query("SELECT run_at, ok, rows_read, inserted, error FROM collect_run ORDER BY id DESC LIMIT 10");
        out.put("runs", runs);
        out.put("stat", first(db.query("SELECT IFNULL(SUM(ok),0) ok_runs, IFNULL(SUM(1-ok),0) fail_runs, MIN(run_at) first_run, MAX(run_at) last_run, MAX(CASE WHEN ok=1 THEN run_at END) last_ok FROM collect_run")));
        int streak = 0;
        for (Map<String, Object> r : runs) {
            if (Db.toLong(r.get("ok")) == 1) {
                break;
            }
            streak++;
        }
        out.put("consecutiveFails", streak);
        List<Map<String, Object>> byAcct = db.query("SELECT account_masked, COUNT(*) n, IFNULL(SUM(deposit_amount),0) amount, SUM(approved) approved, MAX(CONCAT(tx_date,' ',IFNULL(tx_time,''))) last_tx FROM bank_deposit WHERE tx_date = CURDATE() GROUP BY account_masked ORDER BY account_masked");
        for (Map<String, Object> r : byAcct) {
            r.put("label", cfg.accountLabel(Db.str(r.get("account_masked"))));
        }
        out.put("todayByAccount", byAcct);
        List<Map<String, Object>> accts = db.query("SELECT account_masked, COUNT(*) n, MAX(fetched_at) last_fetched FROM bank_deposit GROUP BY account_masked ORDER BY account_masked");
        for (Map<String, Object> r : accts) {
            r.put("label", cfg.accountLabel(Db.str(r.get("account_masked"))));
        }
        out.put("accounts", accts);
        // 수집 연결: config.accounts 의 계좌마다 익스텐션 탭이 붙어 있는지(마지막 보고가 alertNoRunMinutes 안이면 연결)
        List<Map<String, Object>> seen = db.query("SELECT account_masked, ext_version, first_seen_at, last_seen_at, last_run_at, runs FROM collector");
        List<Map<String, Object>> collectors = new java.util.ArrayList<>();
        java.util.Set<String> done = new java.util.HashSet<>();
        for (Config.Account a : cfg.accounts) {
            String last4 = a.last4 == null ? "" : a.last4.replaceAll("[^0-9]", "");
            Map<String, Object> row = null;
            for (Map<String, Object> r : seen) {
                if (!last4.isEmpty() && Db.str(r.get("account_masked")).endsWith(last4)) {
                    row = r;
                }
            }
            collectors.add(collectorRow(a.label, "****" + last4, row));
            if (row != null) {
                done.add(Db.str(row.get("account_masked")));
            }
        }
        for (Map<String, Object> r : seen) {
            if (!done.contains(Db.str(r.get("account_masked")))) {
                collectors.add(collectorRow(null, Db.str(r.get("account_masked")), r));
            }
        }
        out.put("collectors", collectors);
        out.put("claims", db.query("SELECT site_code, status, COUNT(*) n FROM deposit_claim GROUP BY site_code, status"));
        out.put("callbacks", db.query("SELECT callback_status, COUNT(*) n FROM deposit_claim WHERE status = 'MATCHED' GROUP BY callback_status"));
        out.put("sites", matcher.sites().stream().map(s -> s.code).toList());
        return out;
    }

    /** state: CONNECTED(마지막 보고가 alertNoRunMinutes 안) · STALE(그보다 오래됨) · NONE(한 번도 안 붙음) */
    private Map<String, Object> collectorRow(String label, String masked, Map<String, Object> r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("account", masked);
        m.put("label", label == null ? cfg.accountLabel(masked) : label + " (" + masked + ")");
        if (r == null) {
            m.put("state", "NONE");
            return m;
        }
        LocalDateTime last = parseIso(Db.str(r.get("last_seen_at")).replace(' ', 'T'));
        boolean live = last.isAfter(LocalDateTime.now().minusMinutes(cfg.matching.alertNoRunMinutes));
        m.put("state", live ? "CONNECTED" : "STALE");
        m.put("extVersion", r.get("ext_version"));
        m.put("firstSeenAt", Db.str(r.get("first_seen_at")));
        m.put("lastSeenAt", Db.str(r.get("last_seen_at")));
        m.put("lastRunAt", Db.str(r.get("last_run_at")));
        m.put("runs", Db.toLong(r.get("runs")));
        return m;
    }

    private static Map<String, Object> first(List<Map<String, Object>> rows) {
        return rows.isEmpty() ? Map.of() : rows.get(0);
    }

    private static LocalDateTime parseIso(String s) {
        if (s == null || s.isBlank()) {
            return LocalDateTime.now();
        }
        try {
            // 2026-10-29T13:41:00.123Z → 로컬 시각으로
            return java.time.Instant.parse(s).atZone(java.time.ZoneId.systemDefault()).toLocalDateTime();
        } catch (Exception e) {
            try {
                return LocalDateTime.parse(s.length() > 19 ? s.substring(0, 19) : s, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
            } catch (Exception e2) {
                return LocalDateTime.now();
            }
        }
    }

    private static Map<String, Object> readJson(HttpExchange ex) throws IOException {
        byte[] bytes = ex.getRequestBody().readNBytes(2_000_000);
        if (bytes.length == 0) {
            return Map.of();
        }
        return M.readValue(bytes, new TypeReference<Map<String, Object>>() {
        });
    }

    private static void send(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = M.writeValueAsBytes(body);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type");
        ex.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        ex.sendResponseHeaders(status, status == 204 ? -1 : bytes.length);
        if (status != 204) {
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        }
        ex.close();
    }

    static String utf8(byte[] b) {
        return new String(b, StandardCharsets.UTF_8);
    }
}
