package kr.chibiz.depositconfirm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;

/** config.json (jar 옆) — 에이전트 주소 · 처리자(슈퍼아이디) · 조회 기간. 비밀번호·키는 없다. */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Config {
    /** 같은 PC 의 입금 에이전트 HTTP */
    public String agentUrl = "http://127.0.0.1:18080";
    /** 처리·취소에 남길 사람(슈퍼아이디). 비어 있으면 시작할 때 묻는다 */
    public String operator = "";
    /** 미처리·처리 내역을 며칠까지 볼지 */
    public int days = 14;
    /** 자동 새로고침(초) */
    public int refreshSec = 30;

    public static Config load() {
        File f = new File(System.getProperty("app.home", "."), "config.json");
        if (!f.exists()) {
            return new Config();
        }
        try {
            return new ObjectMapper().readValue(f, Config.class);
        } catch (IOException e) {
            System.err.println("config.json 읽기 실패: " + e.getMessage());
            return new Config();
        }
    }

    public void save() {
        File f = new File(System.getProperty("app.home", "."), "config.json");
        try {
            new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(f, this);
        } catch (IOException e) {
            System.err.println("config.json 저장 실패: " + e.getMessage());
        }
    }
}
