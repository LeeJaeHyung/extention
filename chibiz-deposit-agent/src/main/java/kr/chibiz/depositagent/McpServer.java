package kr.chibiz.depositagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * MCP 서버(Streamable HTTP · JSON-RPC 2.0) — 사무실 다른 PC 의 Claude 가 입금 내역·승인(매칭) 내역을 읽고 원인을 조사하게 한다.
 *
 *  - 주소: http://<수집 PC IP>:{mcp.port}/mcp  (0.0.0.0 바인드 · 윈도우 방화벽에서 포트 허용 필요)
 *  - 인증: 헤더 Authorization: Bearer {mcp.token}  (config.json)
 *  - 읽기 전용 도구 + match_now(대조 1회) 만. 쓰기(승인 취소·수동 매칭)는 두지 않는다.
 *
 * Claude Code 연결: claude mcp add --transport http chibiz-deposit http://IP:18081/mcp --header "Authorization: Bearer 토큰"
 */
public class McpServer {
    private static final ObjectMapper M = new ObjectMapper();
    private static final String PROTOCOL = "2025-03-26";
    private final Config cfg;
    private final Db db;
    private final Matcher matcher;
    private final HttpApi api;
    private HttpServer server;

    public McpServer(Config cfg, Db db, Matcher matcher, HttpApi api) {
        this.cfg = cfg;
        this.db = db;
        this.matcher = matcher;
        this.api = api;
    }

    public boolean enabled() {
        return cfg.mcp != null && cfg.mcp.enabled && cfg.mcp.token != null && !cfg.mcp.token.isBlank();
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(cfg.mcp.bind == null ? "0.0.0.0" : cfg.mcp.bind, cfg.mcp.port), 16);
        server.createContext("/mcp", this::handle);
        server.createContext("/", ex -> send(ex, 404, "{}"));
        server.setExecutor(Executors.newFixedThreadPool(4, r -> {
            Thread t = new Thread(r, "mcp");
            t.setDaemon(true);
            return t;
        }));
        server.start();
        AgentLog.info("MCP 서버 시작 http://" + (cfg.mcp.bind == null ? "0.0.0.0" : cfg.mcp.bind) + ":" + cfg.mcp.port + "/mcp");
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        if ("OPTIONS".equals(method)) {
            send(ex, 204, "");
            return;
        }
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !auth.equals("Bearer " + cfg.mcp.token)) {
            AgentLog.warn("MCP 인증 실패 " + ex.getRemoteAddress());
            send(ex, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        if ("GET".equals(method)) {
            // SSE 스트림은 쓰지 않는다(응답은 전부 JSON 한 번)
            send(ex, 405, "{\"error\":\"GET not supported\"}");
            return;
        }
        if ("DELETE".equals(method)) {
            send(ex, 200, "{}");
            return;
        }
        if (!"POST".equals(method)) {
            send(ex, 405, "{}");
            return;
        }
        byte[] bytes = ex.getRequestBody().readNBytes(1_000_000);
        JsonNode req;
        try {
            req = M.readTree(bytes);
        } catch (Exception e) {
            send(ex, 400, "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"parse error\"}}");
            return;
        }
        if (req.isArray()) {
            ArrayNode out = M.createArrayNode();
            for (JsonNode one : req) {
                JsonNode r = dispatch(one);
                if (r != null) {
                    out.add(r);
                }
            }
            send(ex, 200, out.size() == 0 ? "" : M.writeValueAsString(out));
            return;
        }
        JsonNode res = dispatch(req);
        send(ex, res == null ? 202 : 200, res == null ? "" : M.writeValueAsString(res));
    }

    /** 알림(id 없음)은 null 을 돌려 202 로 끝낸다 */
    private JsonNode dispatch(JsonNode req) {
        String method = req.path("method").asText("");
        JsonNode id = req.get("id");
        try {
            if (method.startsWith("notifications/")) {
                return null;
            }
            switch (method) {
                case "initialize": {
                    ObjectNode result = M.createObjectNode();
                    result.put("protocolVersion", req.path("params").path("protocolVersion").asText(PROTOCOL));
                    ObjectNode caps = result.putObject("capabilities");
                    caps.putObject("tools");
                    ObjectNode info = result.putObject("serverInfo");
                    info.put("name", "chibiz-deposit-agent");
                    info.put("version", "0.2.0");
                    result.put("instructions", "차이비즈 입금 에이전트. 하나은행 빠른조회에서 수집한 입금(bank_deposit), 수집 실행 기록(collect_run), 사이트 신청 큐·매칭·콜백(deposit_claim)을 읽는다. "
                            + "매칭 규칙: 입금자명 정규화(공백·법인표기·특수문자 제거) 완전 일치 + 금액 ±오차% + 입금 시각 ≥ 신청−" + cfg.matching.beforeRequestDays + "일, 신청 오래된 순. "
                            + "왜 안 맞았는지는 find_candidates 로 본다. 금액 단위 원.");
                    return ok(id, result);
                }
                case "ping":
                    return ok(id, M.createObjectNode());
                case "tools/list":
                    return ok(id, M.createObjectNode().set("tools", tools()));
                case "tools/call":
                    return ok(id, call(req.path("params").path("name").asText(""), req.path("params").path("arguments")));
                default:
                    return err(id, -32601, "method not found: " + method);
            }
        } catch (Exception e) {
            AgentLog.warn("MCP 오류 " + method + " " + e.getMessage());
            return err(id, -32603, String.valueOf(e.getMessage()));
        }
    }

    // ── 도구 정의 ──

    private ArrayNode tools() {
        ArrayNode arr = M.createArrayNode();
        arr.add(tool("summary", "오늘 입금 건수·금액, 수집 실행 통계(마지막 성공·연속 실패), 신청 큐·콜백 상태 요약", obj()));
        arr.add(tool("list_deposits", "수집된 입금 내역. 날짜 범위·입금자명(부분 일치)·금액 범위·승인 여부로 거른다. 최신순.",
                obj("from", "string", "시작일 yyyy-MM-dd (기본 7일 전)", "to", "string", "종료일 yyyy-MM-dd (기본 오늘)", "memo", "string", "입금자명 부분 일치",
                        "min_amount", "integer", "최소 입금액(원)", "max_amount", "integer", "최대 입금액(원)", "approved", "boolean", "true=매칭된 것만 · false=미매칭만", "limit", "integer", "최대 건수(기본 100, 최대 500)")));
        arr.add(tool("list_runs", "수집 실행 기록(10~15분 회차). 실패 원인·세션 끊김 시점 조사용.", obj("only_fail", "boolean", "실패만", "limit", "integer", "최대 건수(기본 100)")));
        arr.add(tool("list_claims", "사이트 신청 큐(병합본). 상태·사이트로 거른다.", obj("status", "string", "PENDING | MATCHED | CANCELLED", "site", "string", "CHIBIZ | SUPER", "limit", "integer", "최대 건수(기본 100)")));
        arr.add(tool("list_matches", "매칭(승인)된 신청과 붙은 입금, 콜백 결과.", obj("limit", "integer", "최대 건수(기본 100)")));
        arr.add(tool("find_candidates", "특정 신청이 왜 안 맞았는지: 같은 이름(정규화)·같은 금액 범위·시각 조건별로 후보 입금과 탈락 사유를 보여준다.",
                obj("site", "string", "사이트 코드", "claim_id", "string", "사이트 쪽 claimId")));
        arr.add(tool("match_now", "지금 바로 폴링→대조→콜백을 1회 실행(비동기). 결과는 잠시 뒤 list_matches 로 확인.", obj()));
        return arr;
    }

    private ObjectNode tool(String name, String desc, ObjectNode props) {
        ObjectNode t = M.createObjectNode();
        t.put("name", name);
        t.put("description", desc);
        ObjectNode schema = t.putObject("inputSchema");
        schema.put("type", "object");
        schema.set("properties", props);
        return t;
    }

    /** name,type,desc 묶음으로 properties 를 만든다 */
    private ObjectNode obj(String... triples) {
        ObjectNode p = M.createObjectNode();
        for (int i = 0; i + 2 < triples.length; i += 3) {
            ObjectNode f = p.putObject(triples[i]);
            f.put("type", triples[i + 1]);
            f.put("description", triples[i + 2]);
        }
        return p;
    }

    // ── 도구 실행 ──

    private ObjectNode call(String name, JsonNode a) throws Exception {
        Object data;
        switch (name) {
            case "summary":
                data = api.summary();
                break;
            case "list_deposits": {
                String from = text(a, "from", java.time.LocalDate.now().minusDays(7).toString());
                String to = text(a, "to", java.time.LocalDate.now().toString());
                List<Object> args = new ArrayList<>(List.of(from, to));
                StringBuilder sql = new StringBuilder("SELECT id, tx_date, tx_time, kind, memo, deposit_amount, withdraw_amount, balance, branch, approved, approved_claim_id, approved_at, fetched_at FROM bank_deposit WHERE tx_date BETWEEN ? AND ?");
                if (!text(a, "memo", "").isEmpty()) {
                    sql.append(" AND memo LIKE ?");
                    args.add("%" + text(a, "memo", "") + "%");
                }
                if (a.hasNonNull("min_amount")) {
                    sql.append(" AND deposit_amount >= ?");
                    args.add(a.get("min_amount").asLong());
                }
                if (a.hasNonNull("max_amount")) {
                    sql.append(" AND deposit_amount <= ?");
                    args.add(a.get("max_amount").asLong());
                }
                if (a.hasNonNull("approved")) {
                    sql.append(" AND approved = ?");
                    args.add(a.get("approved").asBoolean() ? 1 : 0);
                }
                sql.append(" ORDER BY tx_date DESC, tx_time DESC, id DESC LIMIT ").append(limit(a, 100));
                data = db.query(sql.toString(), args.toArray());
                break;
            }
            case "list_runs":
                data = db.query("SELECT run_at, ok, rows_read, inserted, error, ext_version FROM collect_run " + (a.path("only_fail").asBoolean(false) ? "WHERE ok = 0 " : "") + "ORDER BY id DESC LIMIT " + limit(a, 100));
                break;
            case "list_claims": {
                List<Object> args = new ArrayList<>();
                StringBuilder sql = new StringBuilder("SELECT * FROM deposit_claim WHERE 1=1");
                if (!text(a, "status", "").isEmpty()) {
                    sql.append(" AND status = ?");
                    args.add(text(a, "status", ""));
                }
                if (!text(a, "site", "").isEmpty()) {
                    sql.append(" AND site_code = ?");
                    args.add(text(a, "site", ""));
                }
                sql.append(" ORDER BY id DESC LIMIT ").append(limit(a, 100));
                data = db.query(sql.toString(), args.toArray());
                break;
            }
            case "list_matches":
                data = db.query("SELECT c.site_code, c.claim_id, c.claim_type, c.member_name, c.amount, c.matched_depositor, c.matched_amount, c.matched_tx_date, c.matched_tx_time, c.matched_at, c.callback_status, c.callback_tries, c.callback_last_error, c.bank_deposit_id"
                        + " FROM deposit_claim c WHERE c.status = 'MATCHED' ORDER BY c.matched_at DESC LIMIT " + limit(a, 100));
                break;
            case "find_candidates":
                data = candidates(text(a, "site", ""), text(a, "claim_id", ""));
                break;
            case "match_now":
                matcher.runNow();
                data = Map.of("ok", true, "note", "폴링→대조→콜백을 시작했습니다. 잠시 뒤 list_matches / summary 로 확인하세요.");
                break;
            default:
                throw new IllegalArgumentException("unknown tool " + name);
        }
        ObjectNode result = M.createObjectNode();
        ArrayNode content = result.putArray("content");
        ObjectNode c = content.addObject();
        c.put("type", "text");
        c.put("text", M.writerWithDefaultPrettyPrinter().writeValueAsString(data));
        return result;
    }

    /** 신청 1건에 대해 후보 입금과 탈락 사유 */
    private Object candidates(String site, String claimId) throws Exception {
        List<Map<String, Object>> cl = db.query("SELECT * FROM deposit_claim WHERE site_code = ? AND claim_id = ?", site, claimId);
        if (cl.isEmpty()) {
            return Map.of("error", "신청 없음 " + site + "/" + claimId);
        }
        Map<String, Object> c = cl.get(0);
        List<String> names = new ArrayList<>();
        for (String n : Db.str(c.get("depositor_names")).split(",")) {
            String nn = Matcher.normName(n);
            if (!nn.isEmpty()) {
                names.add(nn);
            }
        }
        long amount = Db.toLong(c.get("amount"));
        double tolPct = c.get("tolerance_pct") instanceof Number n ? n.doubleValue() : 0;
        long tol = Math.round(amount * tolPct / 100.0);
        String requestedAt = Db.str(c.get("requested_at"));
        List<Map<String, Object>> deps = db.query("SELECT id, tx_date, tx_time, memo, deposit_amount, approved, approved_claim_id FROM bank_deposit WHERE tx_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY tx_date DESC, tx_time DESC", cfg.matching.lookbackDays + 20);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> d : deps) {
            boolean nameOk = names.contains(Matcher.normName(Db.str(d.get("memo"))));
            boolean amountOk = Math.abs(Db.toLong(d.get("deposit_amount")) - amount) <= tol;
            if (!nameOk && !amountOk) {
                continue;
            }
            List<String> why = new ArrayList<>();
            if (!nameOk) {
                why.add("입금자명 다름(정규화 '" + Matcher.normName(Db.str(d.get("memo"))) + "' ∉ " + names + ")");
            }
            if (!amountOk) {
                why.add("금액 차이 " + (Db.toLong(d.get("deposit_amount")) - amount) + "원 (허용 ±" + tol + ")");
            }
            String txAt = Db.str(d.get("tx_date")) + " " + Db.str(d.get("tx_time"));
            String earliest = requestedAt.isEmpty() ? "" : java.time.LocalDateTime.parse(requestedAt.replace(' ', 'T')).minusDays(cfg.matching.beforeRequestDays).toString().replace('T', ' ');
            if (!earliest.isEmpty() && txAt.compareTo(earliest) < 0) {
                why.add("입금이 너무 이름(" + txAt + " < 신청−" + cfg.matching.beforeRequestDays + "일 " + earliest + ")");
            }
            if (Db.toLong(d.get("approved")) == 1) {
                why.add("이미 다른 신청(" + d.get("approved_claim_id") + ")에 승인됨");
            }
            Map<String, Object> row = new java.util.LinkedHashMap<>(d);
            row.put("would_match", why.isEmpty());
            row.put("reasons", why);
            out.add(row);
        }
        Map<String, Object> res = new java.util.LinkedHashMap<>();
        res.put("claim", c);
        res.put("normalized_names", names);
        res.put("amount_window", Map.of("min", amount - tol, "max", amount + tol));
        res.put("candidates", out);
        return res;
    }

    private static String text(JsonNode a, String k, String def) {
        return a == null || !a.hasNonNull(k) ? def : a.get(k).asText(def);
    }

    private static int limit(JsonNode a, int def) {
        int n = a == null || !a.hasNonNull("limit") ? def : a.get("limit").asInt(def);
        return Math.max(1, Math.min(n, 500));
    }

    private static ObjectNode ok(JsonNode id, JsonNode result) {
        ObjectNode r = M.createObjectNode();
        r.put("jsonrpc", "2.0");
        r.set("id", id);
        r.set("result", result);
        return r;
    }

    private static ObjectNode err(JsonNode id, int code, String message) {
        ObjectNode r = M.createObjectNode();
        r.put("jsonrpc", "2.0");
        r.set("id", id);
        ObjectNode e = r.putObject("error");
        e.put("code", code);
        e.put("message", message);
        return r;
    }

    private static void send(HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
        ex.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        if (bytes.length == 0) {
            ex.sendResponseHeaders(status == 200 ? 202 : status, -1);
        } else {
            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        }
        ex.close();
    }
}
