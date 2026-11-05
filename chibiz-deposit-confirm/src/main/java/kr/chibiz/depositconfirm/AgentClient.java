package kr.chibiz.depositconfirm;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/** 입금 에이전트 HTTP(127.0.0.1:18080) — 미처리·처리 내역 읽기, 처리·취소 쓰기 */
public class AgentClient {
    private static final ObjectMapper M = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final String base;
    private final String key;

    public AgentClient(String base, String key) {
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        this.key = key == null ? "" : key.trim();
    }

    private HttpRequest.Builder req(String path) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(15));
        if (!key.isEmpty()) {
            b.header("X-AGENT-KEY", key);
        }
        return b;
    }

    public Map<String, Object> health() throws IOException, InterruptedException {
        return M.readValue(get("/health"), new TypeReference<Map<String, Object>>() { });
    }

    public List<Map<String, Object>> unprocessed(int days) throws IOException, InterruptedException {
        return M.readValue(get("/deposits/unprocessed?days=" + days), new TypeReference<List<Map<String, Object>>>() { });
    }

    public List<Map<String, Object>> processed(int days) throws IOException, InterruptedException {
        return M.readValue(get("/deposits/processed?days=" + days), new TypeReference<List<Map<String, Object>>>() { });
    }

    public List<Map<String, Object>> actions(int days) throws IOException, InterruptedException {
        return M.readValue(get("/deposits/actions?days=" + days), new TypeReference<List<Map<String, Object>>>() { });
    }

    /** 처리 — 성공이면 null, 아니면 사유 */
    public String process(long id, String operator, String note) throws IOException, InterruptedException {
        return post("/deposits/" + id + "/process", Map.of("operator", operator, "note", note == null ? "" : note));
    }

    /** 취소 — 성공이면 null, 아니면 사유 */
    public String cancel(long id, String operator, String note) throws IOException, InterruptedException {
        return post("/deposits/" + id + "/cancel", Map.of("operator", operator, "note", note == null ? "" : note));
    }

    private String get(String path) throws IOException, InterruptedException {
        HttpRequest req = req(path).GET().build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (res.statusCode() != 200) {
            throw new IOException("HTTP " + res.statusCode() + " " + path);
        }
        return res.body();
    }

    private String post(String path, Map<String, Object> body) throws IOException, InterruptedException {
        HttpRequest req = req(path)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(M.writeValueAsString(body), StandardCharsets.UTF_8)).build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (res.statusCode() == 200) {
            return null;
        }
        try {
            Map<String, Object> m = M.readValue(res.body(), new TypeReference<Map<String, Object>>() { });
            Object r = m.get("reason");
            return r == null ? "HTTP " + res.statusCode() : String.valueOf(r);
        } catch (Exception e) {
            return "HTTP " + res.statusCode();
        }
    }
}
