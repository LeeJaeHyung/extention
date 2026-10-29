package kr.chibiz.depositagent;

import javafx.application.Application;
import javafx.application.Platform;
import javafx.beans.property.SimpleStringProperty;
import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.Button;
import javafx.scene.control.ButtonType;
import javafx.scene.control.Label;
import javafx.scene.control.Tab;
import javafx.scene.control.TabPane;
import javafx.scene.control.TableColumn;
import javafx.scene.control.TableView;
import javafx.scene.control.TextArea;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.Region;
import javafx.scene.layout.VBox;
import javafx.stage.Stage;

import java.text.NumberFormat;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 차이비즈 입금 에이전트 — JavaFX 창.
 * 디자인: DESIGN-nike.md 토큰(ink #111111 · canvas #ffffff · soft-cloud #f5f5f5 · hairline #cacacb · sale #d30005 · success #007d48,
 * 유틸리티 바 36px · 둥근 알약 버튼 · 그림자 없는 평면 카드 · 8px 간격)을 app.css 로 옮김.
 */
public class App extends Application {
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss");
    private static final NumberFormat WON = NumberFormat.getIntegerInstance(Locale.KOREA);

    private Config cfg;
    private Db db;
    private Matcher matcher;
    private HttpApi api;
    private final ScheduledExecutorService ui = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ui-refresh");
        t.setDaemon(true);
        return t;
    });

    private final Label statusDb = chip("DB 연결 중");
    private final Label statusHttp = chip("HTTP 대기");
    private final Label statusSites = chip("대조 꺼짐");
    private final Label statusMcp = chip("MCP 꺼짐");
    private McpServer mcp;
    private final Label statTodayCount = stat("0건");
    private final Label statTodayAmount = stat("0원");
    private final Label statLastRun = stat("-");
    private final Label statFails = stat("0회");
    private final Label statClaims = stat("-");
    private final Label statLastPoll = stat("-");
    private final ObservableList<Map<String, Object>> deposits = FXCollections.observableArrayList();
    private final ObservableList<Map<String, Object>> runs = FXCollections.observableArrayList();
    private final ObservableList<Map<String, Object>> claims = FXCollections.observableArrayList();
    private final ObservableList<Map<String, Object>> matches = FXCollections.observableArrayList();
    private final TextArea logArea = new TextArea();

    public static void main(String[] args) {
        launch(args);
    }

    @Override
    public void start(Stage stage) {
        stage.setTitle("차이비즈 입금 에이전트");
        BorderPane root = new BorderPane();
        root.getStyleClass().add("canvas");
        root.setTop(new VBox(utilityBar(), nav()));
        root.setCenter(new VBox(0, stats(), tabs()));
        Scene scene = new Scene(root, 1180, 760);
        scene.getStylesheets().add(App.class.getResource("/app.css").toExternalForm());
        stage.setScene(scene);
        stage.setOnCloseRequest(ev -> {
            Alert a = new Alert(Alert.AlertType.CONFIRMATION, "창을 닫으면 입금 수집·대조가 멈춥니다. 닫을까요?", ButtonType.YES, ButtonType.NO);
            a.setHeaderText(null);
            a.getDialogPane().getStylesheets().add(scene.getStylesheets().get(0));
            if (a.showAndWait().orElse(ButtonType.NO) != ButtonType.YES) {
                ev.consume();
            }
        });
        stage.show();
        AgentLog.setListener(line -> Platform.runLater(() -> {
            logArea.appendText(line + "\n");
            if (logArea.getLength() > 200_000) {
                logArea.deleteText(0, 50_000);
            }
        }));
        new Thread(this::boot, "boot").start();
    }

    private void boot() {
        try {
            cfg = Config.load();
        } catch (Exception e) {
            AgentLog.warn("config.json 읽기 실패: " + e.getMessage());
            Platform.runLater(() -> set(statusDb, "config.json 오류", "chip-bad"));
            return;
        }
        db = new Db(cfg.db);
        try {
            db.init();
            AgentLog.setDbSink(db::saveLog);
            Platform.runLater(() -> set(statusDb, "DB " + cfg.db.database + " 연결됨", "chip-ok"));
            AgentLog.info("DB 준비됨 " + cfg.db.database);
        } catch (Exception e) {
            AgentLog.warn("DB 연결 실패 — config.json 의 접속 정보와 MySQL 실행 여부를 확인하세요: " + e.getMessage());
            Platform.runLater(() -> set(statusDb, "DB 연결 실패", "chip-bad"));
            return;
        }
        matcher = new Matcher(cfg, db);
        api = new HttpApi(cfg, db, matcher, this::refreshSoon);
        try {
            api.start();
            Platform.runLater(() -> set(statusHttp, "HTTP 127.0.0.1:" + cfg.port, "chip-ok"));
        } catch (Exception e) {
            AgentLog.warn("HTTP 시작 실패(포트 " + cfg.port + " 사용 중?): " + e.getMessage());
            Platform.runLater(() -> set(statusHttp, "HTTP 시작 실패", "chip-bad"));
            return;
        }
        matcher.start();
        Platform.runLater(() -> set(statusSites, matcher.enabled() ? "대조 켜짐 " + matcher.sites().stream().map(s -> s.code).toList() : "대조 꺼짐(사이트 키 없음)", matcher.enabled() ? "chip-ok" : "chip-muted"));
        mcp = new McpServer(cfg, db, matcher, api);
        if (mcp.enabled()) {
            try {
                mcp.start();
                Platform.runLater(() -> set(statusMcp, "MCP :" + cfg.mcp.port + "/mcp", "chip-ok"));
            } catch (Exception e) {
                AgentLog.warn("MCP 시작 실패(포트 " + cfg.mcp.port + "): " + e.getMessage());
                Platform.runLater(() -> set(statusMcp, "MCP 시작 실패", "chip-bad"));
            }
        } else {
            AgentLog.info("MCP 꺼짐(config.mcp.token 비어 있음)");
            Platform.runLater(() -> set(statusMcp, "MCP 꺼짐(토큰 없음)", "chip-muted"));
        }
        ui.scheduleWithFixedDelay(this::refresh, 1, 30, TimeUnit.SECONDS);
    }

    private void refreshSoon() {
        ui.schedule(this::refresh, 1, TimeUnit.SECONDS);
    }

    private void refresh() {
        if (db == null) {
            return;
        }
        try {
            Map<String, Object> s = api.summary();
            List<Map<String, Object>> dep = db.query("SELECT tx_date, tx_time, kind, memo, deposit_amount, balance, branch, approved, fetched_at FROM bank_deposit ORDER BY tx_date DESC, tx_time DESC, id DESC LIMIT 300");
            List<Map<String, Object>> run = db.query("SELECT run_at, ok, rows_read, inserted, error FROM collect_run ORDER BY id DESC LIMIT 200");
            List<Map<String, Object>> cl = db.query("SELECT site_code, claim_id, claim_type, member_name, depositor_names, amount, tolerance_pct, status, requested_at, expires_at FROM deposit_claim ORDER BY id DESC LIMIT 200");
            List<Map<String, Object>> mt = db.query("SELECT site_code, claim_id, claim_type, amount, matched_depositor, matched_amount, matched_tx_date, matched_tx_time, matched_at, callback_status, callback_tries, callback_last_error FROM deposit_claim WHERE status = 'MATCHED' ORDER BY matched_at DESC LIMIT 200");
            Platform.runLater(() -> {
                Map<String, Object> today = (Map<String, Object>) s.get("today");
                Map<String, Object> stat = (Map<String, Object>) s.get("stat");
                statTodayCount.setText(Db.toLong(today.get("n")) + "건");
                statTodayAmount.setText(WON.format(Db.toLong(today.get("amount"))) + "원");
                statLastRun.setText(stat.get("last_ok") == null ? "-" : Db.str(stat.get("last_ok")).substring(5, 16));
                long fails = Db.toLong(s.get("consecutiveFails"));
                statFails.setText(fails + "회");
                statFails.getStyleClass().removeAll("stat-bad");
                if (fails > 0) {
                    statFails.getStyleClass().add("stat-bad");
                }
                long pending = 0;
                long matched = 0;
                for (Map<String, Object> c : (List<Map<String, Object>>) s.get("claims")) {
                    if ("PENDING".equals(c.get("status"))) {
                        pending += Db.toLong(c.get("n"));
                    }
                    if ("MATCHED".equals(c.get("status"))) {
                        matched += Db.toLong(c.get("n"));
                    }
                }
                statClaims.setText("대기 " + pending + " · 매칭 " + matched);
                statLastPoll.setText(matcher.lastPollAt() == null ? "-" : matcher.lastPollAt().format(TS));
                deposits.setAll(dep);
                runs.setAll(run);
                claims.setAll(cl);
                matches.setAll(mt);
            });
        } catch (Exception e) {
            AgentLog.warn("화면 갱신 실패 " + e.getMessage());
        }
    }

    // ── 화면 조각 ──

    private HBox utilityBar() {
        HBox bar = new HBox(8, statusDb, statusHttp, statusSites, statusMcp);
        bar.getStyleClass().add("utility-bar");
        bar.setAlignment(Pos.CENTER_LEFT);
        return bar;
    }

    private HBox nav() {
        Label title = new Label("차이비즈 입금 에이전트");
        title.getStyleClass().add("heading-xl");
        Label sub = new Label("하나은행 빠른조회 → 로컬 MySQL → 사이트 신청 큐 대조");
        sub.getStyleClass().add("caption-mute");
        VBox left = new VBox(2, title, sub);
        Region spacer = new Region();
        HBox.setHgrow(spacer, Priority.ALWAYS);
        Button refreshBtn = pill("새로고침", "button-secondary", e -> refreshSoon());
        Button matchBtn = pill("지금 대조", "button-primary", e -> {
            if (matcher != null) {
                matcher.runNow();
                refreshSoon();
            }
        });
        HBox nav = new HBox(8, left, spacer, refreshBtn, matchBtn);
        nav.getStyleClass().add("primary-nav");
        nav.setAlignment(Pos.CENTER_LEFT);
        return nav;
    }

    private HBox stats() {
        HBox row = new HBox(8,
                tile("오늘 입금", statTodayCount), tile("오늘 입금액", statTodayAmount), tile("마지막 수집 성공", statLastRun),
                tile("연속 실패", statFails), tile("신청 큐", statClaims), tile("마지막 폴링", statLastPoll));
        row.getStyleClass().add("stats");
        for (var n : row.getChildren()) {
            HBox.setHgrow(n, Priority.ALWAYS);
        }
        return row;
    }

    private TabPane tabs() {
        TabPane tabs = new TabPane();
        tabs.setTabClosingPolicy(TabPane.TabClosingPolicy.UNAVAILABLE);
        tabs.getTabs().addAll(
                tab("입금 내역", table(deposits, "tx_date:거래일자:100", "tx_time:시간:70", "kind:구분:80", "memo:적요(입금자명):220", "deposit_amount:입금액:120:won", "balance:잔액:130:won", "branch:거래점:140", "approved:승인:60:yn", "fetched_at:읽은 시각:150")),
                tab("실행 기록", table(runs, "run_at:실행 시각:160", "ok:결과:70:okfail", "rows_read:읽은 행:80", "inserted:새로 저장:80", "error:실패 사유:600")),
                tab("신청 큐", table(claims, "site_code:사이트:80", "claim_id:신청:80", "claim_type:유형:110", "member_name:회원:110", "depositor_names:입금자명 후보:260", "amount:금액:120:won", "tolerance_pct:오차%:60", "status:상태:90", "requested_at:신청 시각:150", "expires_at:만료:150")),
                tab("매칭·콜백", table(matches, "site_code:사이트:80", "claim_id:신청:80", "claim_type:유형:110", "amount:신청 금액:110:won", "matched_depositor:입금자:160", "matched_amount:입금액:110:won", "matched_tx_date:거래일:100", "matched_tx_time:시간:60", "matched_at:매칭 시각:150", "callback_status:콜백:70", "callback_tries:시도:50", "callback_last_error:콜백 오류:300")),
                tab("로그", logPane()));
        VBox.setVgrow(tabs, Priority.ALWAYS);
        return tabs;
    }

    private Tab tab(String name, javafx.scene.Node content) {
        Tab t = new Tab(name, content);
        return t;
    }

    private TextArea logPane() {
        logArea.setEditable(false);
        logArea.setWrapText(false);
        logArea.getStyleClass().add("log");
        logArea.setText(String.join("\n", AgentLog.recent()) + "\n");
        return logArea;
    }

    /** "key:제목:너비[:형식]" 로 열을 만든다. 형식 won(천단위) · yn(1→승인) · okfail(1→성공, 0→실패 빨강) */
    private TableView<Map<String, Object>> table(ObservableList<Map<String, Object>> items, String... cols) {
        TableView<Map<String, Object>> tv = new TableView<>(items);
        tv.setPlaceholder(new Label("아직 데이터가 없습니다"));
        for (String spec : cols) {
            String[] p = spec.split(":");
            String key = p[0];
            String fmt = p.length > 3 ? p[3] : "";
            TableColumn<Map<String, Object>, String> c = new TableColumn<>(p[1]);
            c.setPrefWidth(Integer.parseInt(p[2]));
            c.setCellValueFactory(cd -> new SimpleStringProperty(format(cd.getValue().get(key), fmt)));
            if ("won".equals(fmt)) {
                c.getStyleClass().add("col-right");
            }
            if ("okfail".equals(fmt)) {
                c.setCellFactory(col -> new javafx.scene.control.TableCell<>() {
                    @Override
                    protected void updateItem(String v, boolean empty) {
                        super.updateItem(v, empty);
                        setText(empty ? null : v);
                        getStyleClass().removeAll("cell-ok", "cell-bad");
                        if (!empty && v != null) {
                            getStyleClass().add("성공".equals(v) ? "cell-ok" : "cell-bad");
                        }
                    }
                });
            }
            tv.getColumns().add(c);
        }
        return tv;
    }

    private static String format(Object v, String fmt) {
        if (v == null) {
            return "";
        }
        switch (fmt) {
            case "won":
                return WON.format(Db.toLong(v));
            case "yn":
                return Db.toLong(v) == 1 ? "승인" : "";
            case "okfail":
                return Db.toLong(v) == 1 ? "성공" : "실패";
            default:
                String s = String.valueOf(v);
                return s.length() > 19 && s.charAt(10) == ' ' ? s.substring(0, 19) : s;
        }
    }

    private static Label chip(String text) {
        Label l = new Label(text);
        l.getStyleClass().addAll("chip", "chip-muted");
        return l;
    }

    private static void set(Label chip, String text, String style) {
        chip.setText(text);
        chip.getStyleClass().removeAll("chip-ok", "chip-bad", "chip-muted");
        chip.getStyleClass().add(style);
    }

    private static Label stat(String text) {
        Label l = new Label(text);
        l.getStyleClass().add("stat-value");
        return l;
    }

    private static VBox tile(String caption, Label value) {
        Label cap = new Label(caption);
        cap.getStyleClass().add("stat-caption");
        VBox box = new VBox(4, cap, value);
        box.getStyleClass().add("stat-tile");
        return box;
    }

    private static Button pill(String text, String style, javafx.event.EventHandler<javafx.event.ActionEvent> h) {
        Button b = new Button(text);
        b.getStyleClass().addAll("pill", style);
        b.setOnAction(h);
        return b;
    }

    @Override
    public void stop() {
        if (api != null) {
            api.stop();
        }
        if (mcp != null) {
            mcp.stop();
        }
        AgentLog.info("입금 에이전트 종료 " + LocalDateTime.now().withNano(0));
        Platform.exit();
        System.exit(0);
    }
}
