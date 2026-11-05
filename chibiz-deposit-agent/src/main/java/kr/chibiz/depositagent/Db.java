package kr.chibiz.depositagent;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 로컬 MySQL(chibiz_bank) 접근. 표는 schema.sql(리소스)로 만들고, 예전 표엔 열을 보탠다.
 * 연결은 호출마다 새로 연다(동시 접근이 적고, 끊긴 연결로 고생하지 않으려고).
 */
public class Db {
    private final Config.Db c;

    public Db(Config.Db c) {
        this.c = c;
    }

    private String url(String database) {
        return "jdbc:mysql://" + c.host + ":" + c.port + "/" + (database == null ? "" : database)
                + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Seoul&allowPublicKeyRetrieval=true&useSSL=false&connectTimeout=5000&socketTimeout=20000";
    }

    public Connection open() throws SQLException {
        return DriverManager.getConnection(url(c.database), c.user, c.password);
    }

    /** DB·표 준비. 실패하면 예외(화면에 표시). */
    public void init() throws SQLException, IOException {
        try (Connection boot = DriverManager.getConnection(url(null), c.user, c.password); Statement st = boot.createStatement()) {
            st.execute("CREATE DATABASE IF NOT EXISTS `" + c.database + "` DEFAULT CHARACTER SET utf8mb4");
        }
        String schema;
        try (InputStream in = Db.class.getResourceAsStream("/schema.sql")) {
            if (in == null) {
                throw new IOException("schema.sql 리소스 없음");
            }
            schema = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        try (Connection conn = open(); Statement st = conn.createStatement()) {
            for (String stmt : schema.split(";")) {
                String s = stripComments(stmt).trim();
                if (!s.isEmpty()) {
                    st.execute(s);
                }
            }
            if (!hasColumn(conn, "bank_deposit", "approved")) {
                st.execute("ALTER TABLE bank_deposit ADD COLUMN approved TINYINT NOT NULL DEFAULT 0, ADD COLUMN approved_claim_id BIGINT NULL, ADD COLUMN approved_at DATETIME NULL, ADD KEY idx_approved (approved, tx_date)");
            }
            // 0.2.2: 신청마다 대조할 계좌(끝4자리)
            if (!hasColumn(conn, "deposit_claim", "account")) {
                st.execute("ALTER TABLE deposit_claim ADD COLUMN account VARCHAR(8) NULL COMMENT '이 계좌(끝4자리) 입금만 대조' AFTER ref_id");
            }
            // 0.2.4: 서버 송금내역 업데이트 확인(콜백 200 받은 입금)
            // 0.2.5: 실행 기록에 조회 계좌
            if (!hasColumn(conn, "collect_run", "account_masked")) {
                st.execute("ALTER TABLE collect_run ADD COLUMN account_masked VARCHAR(20) NULL COMMENT '이 실행이 조회한 계좌(끝 4자리)' AFTER ext_version");
            }
            // 0.2.6: 계좌별 끊김 보고 시각
            if (!hasColumn(conn, "collector", "alerted_at")) {
                st.execute("ALTER TABLE collector ADD COLUMN alerted_at DATETIME NULL COMMENT '끊김 보고를 보낸 시각(다시 보고가 오면 NULL)'");
            }
            if (!hasColumn(conn, "bank_deposit", "remit_updated")) {
                st.execute("ALTER TABLE bank_deposit ADD COLUMN remit_updated TINYINT NOT NULL DEFAULT 0 COMMENT '1 = 서버 송금내역 업데이트 확인(콜백 200)' AFTER approved_at, ADD COLUMN remit_updated_at DATETIME NULL AFTER remit_updated");
            }
            // 0.2.12: 승인 구분(AUTO 에이전트 매칭 · ADMIN 관리자 영수증 적립) — 예전 승인 행은 전부 자동 매칭
            if (!hasColumn(conn, "bank_deposit", "approved_by")) {
                st.execute("ALTER TABLE bank_deposit ADD COLUMN approved_by VARCHAR(20) NULL COMMENT '승인 구분: AUTO=에이전트 매칭 · ADMIN=관리자 영수증 적립' AFTER approved_at");
                st.execute("UPDATE bank_deposit SET approved_by = 'AUTO' WHERE approved = 1 AND approved_by IS NULL");
            }
            // 0.2.13: 입금 처리 확인 앱 — 처리한 사람·메모
            if (!hasColumn(conn, "bank_deposit", "approved_operator")) {
                st.execute("ALTER TABLE bank_deposit ADD COLUMN approved_operator VARCHAR(50) NULL COMMENT '처리한 사람(입금 처리 확인 앱의 슈퍼아이디)' AFTER approved_by, ADD COLUMN approved_note VARCHAR(200) NULL COMMENT '처리 메모' AFTER approved_operator");
            }
            // 0.2.14 (J 2026-11-05): 에이전트가 승인한 입금의 처리자는 'Chibiz' — 예전 행도 채운다
            st.execute("UPDATE bank_deposit SET approved_operator = 'Chibiz' WHERE approved = 1 AND approved_by IN ('AUTO','ADMIN') AND approved_operator IS NULL");
            if (!hasColumn(conn, "deposit_claim", "amounts")) {
                st.execute("ALTER TABLE deposit_claim ADD COLUMN amounts VARCHAR(600) NULL COMMENT '맞다고 볼 금액 목록(쉼표)' AFTER account");
            }
        }
    }

    private static String stripComments(String sql) {
        StringBuilder sb = new StringBuilder();
        for (String line : sql.split("\n")) {
            if (!line.trim().startsWith("--")) {
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    private static boolean hasColumn(Connection conn, String table, String column) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?")) {
            ps.setString(1, table);
            ps.setString(2, column);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() && rs.getLong(1) > 0;
            }
        }
    }

    // ── 입금 ──

    /** @return [inserted, duplicates] */
    public int[] saveDeposits(List<Map<String, Object>> rows, LocalDateTime fetchedAt, String extVersion) throws SQLException {
        int inserted = 0;
        int dup = 0;
        String sql = "INSERT IGNORE INTO bank_deposit (dedup_key, tx_date, tx_time, kind, memo, deposit_amount, withdraw_amount, balance, branch, account_masked, raw_text, fetched_at, ext_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement(sql)) {
            for (Map<String, Object> r : rows) {
                String txDate = str(r.get("txDate"));
                if (txDate.isEmpty()) {
                    continue;
                }
                long dep = toLong(r.get("depositAmount"));
                long wd = toLong(r.get("withdrawAmount"));
                long bal = toLong(r.get("balance"));
                String memo = str(r.get("memo")).trim();
                String txTime = str(r.get("txTime"));
                // 계좌 두 개 이상을 같이 수집하므로 계좌 끝4자리도 키에 넣는다(다른 계좌의 같은 거래가 겹치지 않게)
                String key = String.join("|", str(r.get("accountMasked")), txDate, txTime, String.valueOf(dep), String.valueOf(wd), String.valueOf(bal), memo);
                ps.setString(1, key);
                ps.setString(2, txDate);
                ps.setString(3, txTime.isEmpty() ? null : txTime);
                ps.setString(4, nul(str(r.get("kind"))));
                ps.setString(5, memo);
                ps.setLong(6, dep);
                ps.setLong(7, wd);
                ps.setLong(8, bal);
                ps.setString(9, nul(str(r.get("branch"))));
                ps.setString(10, nul(str(r.get("accountMasked"))));
                ps.setString(11, left(str(r.get("rawText")), 1000));
                ps.setTimestamp(12, Timestamp.valueOf(fetchedAt));
                ps.setString(13, nul(extVersion));
                if (ps.executeUpdate() > 0) {
                    inserted++;
                } else {
                    dup++;
                }
            }
        }
        return new int[]{inserted, dup};
    }

    /** 익스텐션 탭이 알려 온 조회 계좌. isRun=true 면 실행 보고(횟수·last_run_at 갱신) */
    public void upsertCollector(String accountMasked, String extVersion, LocalDateTime at, boolean isRun) throws SQLException {
        if (accountMasked == null || accountMasked.isBlank()) {
            return;
        }
        String sql = "INSERT INTO collector (account_masked, ext_version, first_seen_at, last_seen_at, last_run_at, runs) VALUES (?,?,?,?,?,?)"
                + " ON DUPLICATE KEY UPDATE ext_version = VALUES(ext_version), last_seen_at = VALUES(last_seen_at),"
                + " last_run_at = IFNULL(VALUES(last_run_at), last_run_at), runs = runs + VALUES(runs), alerted_at = NULL";
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement(sql)) {
            Timestamp ts = Timestamp.valueOf(at);
            ps.setString(1, accountMasked);
            ps.setString(2, nul(extVersion));
            ps.setTimestamp(3, ts);
            ps.setTimestamp(4, ts);
            ps.setTimestamp(5, isRun ? ts : null);
            ps.setInt(6, isRun ? 1 : 0);
            ps.executeUpdate();
        }
    }

    public void markCollectorAlerted(String accountMasked) throws SQLException {
        update("UPDATE collector SET alerted_at = NOW() WHERE account_masked = ?", accountMasked);
    }

    public void saveRun(LocalDateTime at, boolean ok, int rowsRead, int inserted, String error, String extVersion, String accountMasked) throws SQLException {
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement("INSERT INTO collect_run (run_at, ok, rows_read, inserted, error, ext_version, account_masked) VALUES (?,?,?,?,?,?,?)")) {
            ps.setTimestamp(1, Timestamp.valueOf(at));
            ps.setInt(2, ok ? 1 : 0);
            ps.setInt(3, rowsRead);
            ps.setInt(4, inserted);
            ps.setString(5, nul(left(error, 500)));
            ps.setString(6, nul(extVersion));
            ps.setString(7, nul(accountMasked));
            ps.executeUpdate();
        }
    }

    /** 동작 로그 1줄(AgentLog 의 DB sink) */
    public void saveLog(LocalDateTime at, String level, String message) throws SQLException {
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement("INSERT INTO agent_log (logged_at, level, message) VALUES (?,?,?)")) {
            ps.setTimestamp(1, Timestamp.valueOf(at));
            ps.setString(2, level);
            ps.setString(3, left(message, 1000));
            ps.executeUpdate();
        }
    }

    // ── 신청 큐 ──

    public void upsertClaim(String site, String claimId, String memberId, String memberName, String names, long amount, double tol, String type, String refId,
                            String account, String amounts, LocalDateTime requestedAt, LocalDateTime expiresAt) throws SQLException {
        String sql = "INSERT INTO deposit_claim (site_code, claim_id, member_id, member_name, depositor_names, amount, tolerance_pct, claim_type, ref_id, account, amounts, requested_at, expires_at, status)"
                + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')"
                + " ON DUPLICATE KEY UPDATE depositor_names = VALUES(depositor_names), amount = VALUES(amount), tolerance_pct = VALUES(tolerance_pct), account = VALUES(account), amounts = VALUES(amounts), expires_at = VALUES(expires_at),"
                + " status = IF(status = 'CANCELLED', 'PENDING', status)";
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, site);
            ps.setString(2, claimId);
            ps.setString(3, memberId);
            ps.setString(4, memberName);
            ps.setString(5, left(names, 500));
            ps.setLong(6, amount);
            ps.setDouble(7, tol);
            ps.setString(8, type);
            ps.setString(9, refId);
            ps.setString(10, account == null || account.isBlank() ? null : account.replaceAll("[^0-9]", ""));
            ps.setString(11, amounts == null || amounts.isBlank() ? null : left(amounts, 600));
            ps.setTimestamp(12, Timestamp.valueOf(requestedAt));
            ps.setTimestamp(13, Timestamp.valueOf(expiresAt));
            ps.executeUpdate();
        }
    }

    public List<String> pendingClaimIds(String site) throws SQLException {
        List<String> out = new ArrayList<>();
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement("SELECT claim_id FROM deposit_claim WHERE site_code = ? AND status = 'PENDING'")) {
            ps.setString(1, site);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(rs.getString(1));
                }
            }
        }
        return out;
    }

    public void cancelClaim(String site, String claimId) throws SQLException {
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement("UPDATE deposit_claim SET status = 'CANCELLED', updated_at = NOW() WHERE site_code = ? AND claim_id = ? AND status = 'PENDING'")) {
            ps.setString(1, site);
            ps.setString(2, claimId);
            ps.executeUpdate();
        }
    }

    public List<Map<String, Object>> query(String sql, Object... args) throws SQLException {
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                int n = rs.getMetaData().getColumnCount();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= n; i++) {
                        Object v = rs.getObject(i);
                        // 날짜·시각은 문자열로 통일(JSON 응답·화면 표·매칭 계산 모두 문자열 기준)
                        if (v instanceof Timestamp ts) {
                            v = ts.toLocalDateTime().withNano(0).toString().replace('T', ' ');
                        } else if (v instanceof LocalDateTime ldt) {
                            v = ldt.withNano(0).toString().replace('T', ' ');
                        } else if (v instanceof java.sql.Date d) {
                            v = d.toLocalDate().toString();
                        } else if (v instanceof java.time.LocalDate ld) {
                            v = ld.toString();
                        }
                        row.put(rs.getMetaData().getColumnLabel(i), v);
                    }
                    out.add(row);
                }
            }
        }
        return out;
    }

    public int update(String sql, Object... args) throws SQLException {
        try (Connection conn = open(); PreparedStatement ps = conn.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            return ps.executeUpdate();
        }
    }

    // ── 도우미 ──

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    static String nul(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    static String left(String s, int n) {
        return s == null ? null : (s.length() > n ? s.substring(0, n) : s);
    }

    static long toLong(Object o) {
        if (o instanceof Number n) {
            return Math.round(n.doubleValue());
        }
        String s = str(o).replaceAll("[^0-9.-]", "");
        if (s.isEmpty() || s.equals("-") || s.equals(".")) {
            return 0;
        }
        try {
            return Math.round(Double.parseDouble(s));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
