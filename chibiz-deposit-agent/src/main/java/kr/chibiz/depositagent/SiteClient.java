package kr.chibiz.depositagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** 사이트(CHIBIZ·SUPER) API 호출 — 키 헤더 X-DEPOSIT-AGENT-KEY · 15초 제한. */
public class SiteClient {
    public record Reply(int status, JsonNode body, String raw) {
    }

    private static final ObjectMapper M = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public Reply get(Config.Site site, String path) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base(site) + path))
                .timeout(Duration.ofSeconds(15))
                .header("X-DEPOSIT-AGENT-KEY", site.key)
                .header("ngrok-skip-browser-warning", "1")
                .GET().build();
        return send(req);
    }

    public Reply post(Config.Site site, String path, Object body) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base(site) + path))
                .timeout(Duration.ofSeconds(15))
                .header("X-DEPOSIT-AGENT-KEY", site.key)
                .header("Content-Type", "application/json")
                .header("ngrok-skip-browser-warning", "1")
                .POST(HttpRequest.BodyPublishers.ofString(M.writeValueAsString(body))).build();
        return send(req);
    }

    private Reply send(HttpRequest req) throws IOException, InterruptedException {
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        JsonNode node = null;
        try {
            node = res.body() == null || res.body().isBlank() ? null : M.readTree(res.body());
        } catch (Exception ignored) {
            // JSON 이 아니면 raw 만
        }
        return new Reply(res.statusCode(), node, res.body() == null ? "" : res.body());
    }

    private static String base(Config.Site s) {
        return s.baseUrl.endsWith("/") ? s.baseUrl.substring(0, s.baseUrl.length() - 1) : s.baseUrl;
    }
}
