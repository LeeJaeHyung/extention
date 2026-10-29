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
    /** 입금 받는 계좌 목록(끝4자리 → 이름). 화면·MCP 에서 계좌를 구분해 보여 준다. 비우면 끝4자리만 표시 */
    public List<Account> accounts = new ArrayList<>();

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Account {
        public String last4;
        public String label;
    }

    /** 끝4자리 → "이름(****7304)" · 없으면 "****7304" */
    public String accountLabel(String masked) {
        String m = masked == null ? "" : masked;
        String d = m.replaceAll("[^0-9]", "");
        for (Account a : accounts) {
            if (a.last4 != null && d.endsWith(a.last4.replaceAll("[^0-9]", "")) && a.label != null && !a.label.isBlank()) {
                return a.label + " (" + m + ")";
            }
        }
        return m.isEmpty() ? "-" : m;
    }

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
        /** (선택) 이 사이트 신청과 대조할 계좌 끝4자리(예 "7304"). 비우면 모든 계좌 */
        public String account;

        public boolean enabled() {
            return code != null && !code.isBlank() && baseUrl != null && !baseUrl.isBlank() && key != null && !key.isBlank();
        }
    }

    public static File file() {
        return new File(System.getProperty("agent.home", "."), "config.json");
    }

    public static Config load() throws IOException {
        File f = file();
        if (!f.exists()) {
            // 설치 직후: config.json 이 없으면 config.example.json 을 복사해 시작한다(설치형 exe 배포용)
            File ex = new File(f.getAbsoluteFile().getParentFile(), "config.example.json");
            if (ex.exists()) {
                java.nio.file.Files.copy(ex.toPath(), f.toPath());
            }
        }
        return new ObjectMapper().readValue(f, Config.class);
    }
}
