package kr.chibiz.depositagent;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** config.json (jar 옆) — DB 접속 · 포트 · 사이트 키 · 대조 규칙. 비밀번호·키는 이 파일에만 둔다. */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Config {
    public int port = 18080;
    public Db db = new Db();
    public Matching matching = new Matching();
    public List<Site> sites = new ArrayList<>();
    public Mcp mcp = new Mcp();

    /** 사무실 다른 PC 의 Claude 가 붙는 MCP 서버(읽기 전용 + 대조 1회). 토큰이 비어 있으면 켜지지 않는다. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Mcp {
        public boolean enabled = true;
        /** 0.0.0.0 = 사내망에서 접속 허용(윈도우 방화벽 포트 허용 필요) · 127.0.0.1 = 이 PC 만 */
        public String bind = "0.0.0.0";
        public int port = 18081;
        public String token = "";
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Db {
        public String host = "127.0.0.1";
        public int port = 3306;
        public String user = "root";
        public String password = "";
        public String database = "chibiz_bank";
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Matching {
        /** 사이트 신청 큐 폴링(초) */
        public int pollSec = 60;
        /** 대조 주기(분) */
        public int matchMin = 10;
        /** 미승인 입금을 며칠까지 거슬러 볼지 */
        public int lookbackDays = 10;
        /** 신청보다 며칠 전 입금까지 허용 */
        public int beforeRequestDays = 3;
        public int maxCallbackTries = 50;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Site {
        public String code;
        public String baseUrl;
        public String key;

        public boolean enabled() {
            return code != null && !code.isBlank() && baseUrl != null && !baseUrl.isBlank() && key != null && !key.isBlank();
        }
    }

    public static File file() {
        return new File(System.getProperty("agent.home", "."), "config.json");
    }

    public static Config load() throws IOException {
        return new ObjectMapper().readValue(file(), Config.class);
    }
}
