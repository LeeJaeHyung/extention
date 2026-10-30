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
 *  POST /deposits · POST /runs · GET /health · GET /summary · GET /claims?status= · GET /matches · POST /match-now
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
                db.saveRun(parseIso(Db.str(body.get("at"))), ok, (int) Db.toLong(body.get("rowsRead")), (int) Db.toLong(body.get("inserted")), Db.str(body.get("error")), Db.str(body.get("extVersion")));
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
            if ("POST".equals(method) && "/match-now".equals(path)) {
                matcher.runNow();
                send(ex, 200, Map.of("ok", true));
                return;
            }
            send(ex, 404, Map.of("ok", false, "reason", "not found"));
        } catch (Exception e) {
            AgentLog.warn("HTTP 오류 " + method + " " + path + " " + e.getMessage());
            send(ex, 500, Map.of("ok", false, "reason", String.valueOf(e.getMessage())));
        }
    }

    public Map<String, Object> summary() throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("today", first(db.query("SELECT COUNT(*) n, IFNULL(SUM(deposit_amount),0) amount FROM bank_deposit WHERE tx_date = CURDATE()")));
        out.put("total", first(db.query("SELECT COUNT(*) n, IFNULL(SUM(approved),0) approved, MIN(fetched_at) first_at, MAX(fetched_at) last_at FROM bank_deposit")));
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
        out.put("claims", db.query("SELECT site_code, status, COUNT(*) n FROM deposit_claim GROUP BY site_code, status"));
        out.put("callbacks", db.query("SELECT callback_status, COUNT(*) n FROM deposit_claim WHERE status = 'MATCHED' GROUP BY callback_status"));
        out.put("sites", matcher.sites().stream().map(s -> s.code).toList());
        return out;
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
