package kr.chibiz.depositconfirm;

import javafx.application.Application;
import javafx.application.Platform;
import javafx.beans.property.SimpleStringProperty;
import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.Button;
import javafx.scene.control.ButtonType;
import javafx.scene.control.ComboBox;
import javafx.scene.control.Label;
import javafx.scene.control.Tab;
import javafx.scene.control.TabPane;
import javafx.scene.control.TableCell;
import javafx.scene.control.TableColumn;
import javafx.scene.control.TableView;
import javafx.scene.control.TextField;
import javafx.scene.control.TextInputDialog;
import javafx.scene.image.Image;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.Region;
import javafx.scene.layout.VBox;
import javafx.stage.Stage;

import java.text.NumberFormat;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 차이비즈 입금 처리 확인 — JavaFX 창 (J 2026-11-05).
 * 같은 PC 의 입금 에이전트(127.0.0.1:18080)가 가진 통장 입금 가운데 «처리되지 않은 것» 만 보여 주고,
 * 사람이 [처리] 를 누르면 에이전트 DB 의 그 입금이 승인(MANUAL · 처리자 = 슈퍼아이디) 으로 바뀌어 자동 대조·AI 검토 후보에서 빠진다.
 * 처리한 것은 [취소] 로 되돌릴 수 있다(자동 매칭·관리자 영수증 적립 건은 취소 불가 — 서버 적립과 어긋나므로).
 * 디자인: DESIGN-nike.md 토큰(app.css · 입금 에이전트와 동일).
 */
public class App extends Application {
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss");
    private static final NumberFormat WON = NumberFormat.getIntegerInstance(Locale.KOREA);

    /** 처리자 — SuperID 는 플랫폼 이름(J 2026-11-05). 사람 아이디를 묻지 않고 이 값을 고정으로 남긴다 */
    private static final String OPERATOR = "SuperID";

    private Config cfg;
    private AgentClient client;
    private final ScheduledExecutorService ui = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ui-refresh");
        t.setDaemon(true);
        return t;
    });

    private final Label statusAgent = chip("에이전트 연결 중");
    private final Label statusOperator = chip("처리자 SuperID");
    private final Label statusRefresh = chip("새로고침 -");
    private final Label statUnprocessed = stat("0건");
    private final Label statUnprocessedAmount = stat("0원");
    private final Label statTodayManual = stat("0건");
    private final Label statProcessed = stat("0건");
    private final Label sub = new Label();

    private final ObservableList<Map<String, Object>> unprocessed = FXCollections.observableArrayList();
    private final ObservableList<Map<String, Object>> processed = FXCollections.observableArrayList();
    private final ObservableList<Map<String, Object>> actions = FXCollections.observableArrayList();
    private List<Map<String, Object>> unprocessedAll = new ArrayList<>();
    private List<Map<String, Object>> processedAll = new ArrayList<>();

    private final ComboBox<String> accountFilter = new ComboBox<>(FXCollections.observableArrayList("전체 계좌"));
    private final ComboBox<String> kindFilter = new ComboBox<>(FXCollections.observableArrayList("전체", "자동 매칭", "관리자 적립", "수동 처리"));
    private final TextField searchField = new TextField();
    private final TextField searchField2 = new TextField();

    public static void main(String[] args) {
        launch(args);
    }

    @Override
    public void start(Stage stage) {
        cfg = Config.load();
        client = new AgentClient(cfg.agentUrl);

        BorderPane root = new BorderPane();
        root.getStyleClass().add("canvas");
        root.setTop(new VBox(utilityBar(), nav(), stats()));
        root.setCenter(tabs());

        Scene scene = new Scene(root, 1280, 760);
        scene.getStylesheets().add(App.class.getResource("/app.css").toExternalForm());
        stage.setTitle("차이비즈 입금 처리 확인");
        try {
            stage.getIcons().add(new Image(App.class.getResourceAsStream("/icon.png")));
        } catch (Exception ignored) {
            // 아이콘 없어도 됨
        }
        stage.setScene(scene);
        stage.setOnCloseRequest(e -> {
            ui.shutdownNow();
            Platform.exit();
        });
        stage.show();

        sub.setText("에이전트 " + cfg.agentUrl.replace("http://", "") + " · 최근 " + cfg.days + "일 · " + cfg.refreshSec + "초마다 새로고침");
        accountFilter.setValue("전체 계좌");
        accountFilter.getStyleClass().add("account-filter");
        accountFilter.setOnAction(e -> applyFilters());
        kindFilter.setValue("전체");
        kindFilter.getStyleClass().add("account-filter");
        kindFilter.setOnAction(e -> applyFilters());
        searchField.setPromptText("입금자명(적요) · 금액");
        searchField.setPrefWidth(220);
        searchField.setOnAction(e -> applyFilters());
        searchField2.setPromptText("입금자명(적요) · 금액 · 처리자");
        searchField2.setPrefWidth(220);
        searchField2.setOnAction(e -> applyFilters());

        ui.scheduleWithFixedDelay(this::refresh, 0, Math.max(10, cfg.refreshSec), TimeUnit.SECONDS);
    }

    // ── 화면 조각 ──

    private HBox utilityBar() {
        HBox bar = new HBox(8, statusAgent, statusOperator, statusRefresh);
        bar.getStyleClass().add("utility-bar");
        bar.setAlignment(Pos.CENTER_LEFT);
        return bar;
    }

    private HBox nav() {
        Label title = new Label("차이비즈 입금 처리 확인");
        title.getStyleClass().add("heading-xl");
        sub.getStyleClass().add("caption-mute");
        VBox left = new VBox(2, title, sub);
        Region spacer = new Region();
        HBox.setHgrow(spacer, Priority.ALWAYS);
        Button refreshBtn = pill("새로고침", "button-primary", e -> ui.execute(this::refresh));
        HBox nav = new HBox(8, left, spacer, refreshBtn);
        nav.getStyleClass().add("primary-nav");
        nav.setAlignment(Pos.CENTER_LEFT);
        return nav;
    }

    private HBox stats() {
        HBox row = new HBox(8,
                tile("미처리 입금", statUnprocessed), tile("미처리 금액", statUnprocessedAmount),
                tile("오늘 처리(사람)", statTodayManual), tile("처리 내역(기간)", statProcessed));
        row.getStyleClass().add("stats");
        for (Node n : row.getChildren()) {
            HBox.setHgrow(n, Priority.ALWAYS);
        }
        return row;
    }

    private TabPane tabs() {
        TabPane tabs = new TabPane();
        tabs.setTabClosingPolicy(TabPane.TabClosingPolicy.UNAVAILABLE);

        TableView<Map<String, Object>> t1 = table(unprocessed, "account:계좌:170", "tx_date:거래일자:110", "tx_time:시간:70",
                "memo:적요(입금자명):280", "deposit_amount:입금액:140:won", "balance:잔액:130:won", "branch:거래점:120");
        t1.getColumns().add(0, buttonColumn("처리", "button-info", 90, this::processRow, r -> true));
        Label l1 = new Label("계좌");
        l1.getStyleClass().add("stat-caption");
        Label l2 = new Label("검색");
        l2.getStyleClass().add("stat-caption");
        Button s1 = new Button("검색");
        s1.setOnAction(e -> applyFilters());
        HBox bar1 = new HBox(8, l1, accountFilter, l2, searchField, s1);
        bar1.setAlignment(Pos.CENTER_LEFT);
        bar1.setPadding(new Insets(8, 0, 8, 0));
        VBox box1 = new VBox(0, bar1, t1);
        VBox.setVgrow(t1, Priority.ALWAYS);

        TableView<Map<String, Object>> t2 = table(processed, "account:계좌:170", "tx_date:거래일자:100", "tx_time:시간:70", "memo:적요(입금자명):220",
                "deposit_amount:입금액:130:won", "approved_by:구분:100:by", "approved_operator:처리자:110", "approved_note:메모:200", "approved_claim_id:신청:70", "approved_at:처리 시각:150");
        t2.getColumns().add(0, buttonColumn("취소", "button-secondary", 90, this::cancelRow, r -> "MANUAL".equals(String.valueOf(r.get("approved_by")))));
        Label l3 = new Label("구분");
        l3.getStyleClass().add("stat-caption");
        Label l4 = new Label("검색");
        l4.getStyleClass().add("stat-caption");
        Button s2 = new Button("검색");
        s2.setOnAction(e -> applyFilters());
        HBox bar2 = new HBox(8, l3, kindFilter, l4, searchField2, s2);
        bar2.setAlignment(Pos.CENTER_LEFT);
        bar2.setPadding(new Insets(8, 0, 8, 0));
        VBox box2 = new VBox(0, bar2, t2);
        VBox.setVgrow(t2, Priority.ALWAYS);

        TableView<Map<String, Object>> t3 = table(actions, "acted_at:시각:150", "action:동작:80:act", "operator:처리자:110", "memo:적요(입금자명):220", "amount:입금액:130:won", "note:메모:300", "bank_deposit_id:입금 번호:90");

        tabs.getTabs().addAll(new Tab("미처리 입금", box1), new Tab("처리 내역", box2), new Tab("처리·취소 기록", t3));
        VBox.setVgrow(tabs, Priority.ALWAYS);
        return tabs;
    }

    // ── 데이터 ──

    private void refresh() {
        try {
            client.health();
            List<Map<String, Object>> u = client.unprocessed(cfg.days);
            List<Map<String, Object>> p = client.processed(cfg.days);
            List<Map<String, Object>> a = client.actions(cfg.days);
            Platform.runLater(() -> {
                unprocessedAll = u;
                processedAll = p;
                actions.setAll(a);
                Set<String> accts = new LinkedHashSet<>();
                accts.add("전체 계좌");
                for (Map<String, Object> r : u) {
                    accts.add(String.valueOf(r.get("account")));
                }
                String keep = accountFilter.getValue();
                if (!accts.equals(new LinkedHashSet<>(accountFilter.getItems()))) {
                    accountFilter.setItems(FXCollections.observableArrayList(accts));
                    accountFilter.setValue(accts.contains(keep) ? keep : "전체 계좌");
                }
                applyFilters();
                long amount = 0;
                for (Map<String, Object> r : u) {
                    amount += toLong(r.get("deposit_amount"));
                }
                String today = LocalDate.now().toString();
                long todayManual = a.stream().filter(x -> "PROCESS".equals(String.valueOf(x.get("action"))) && String.valueOf(x.get("acted_at")).startsWith(today)).count();
                statUnprocessed.setText(u.size() + "건");
                statUnprocessedAmount.setText(WON.format(amount) + "원");
                statTodayManual.setText(todayManual + "건");
                statProcessed.setText(p.size() + "건");
                setChip(statusAgent, "에이전트 연결됨", "chip-ok");
                setChip(statusRefresh, "새로고침 " + LocalDateTime.now().format(TS), null);
            });
        } catch (Exception e) {
            Platform.runLater(() -> {
                setChip(statusAgent, "에이전트 연결 안 됨 — " + cfg.agentUrl.replace("http://", "") + " (" + e.getMessage() + ")", "chip-bad");
                setChip(statusRefresh, "새로고침 실패 " + LocalDateTime.now().format(TS), null);
            });
        }
    }

    private void applyFilters() {
        String acct = accountFilter.getValue() == null ? "전체 계좌" : accountFilter.getValue();
        String q = searchField.getText() == null ? "" : searchField.getText().trim();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : unprocessedAll) {
            if (!"전체 계좌".equals(acct) && !acct.equals(String.valueOf(r.get("account")))) {
                continue;
            }
            if (!q.isEmpty() && !String.valueOf(r.get("memo")).contains(q) && !String.valueOf(r.get("deposit_amount")).contains(q.replace(",", ""))) {
                continue;
            }
            out.add(r);
        }
        unprocessed.setAll(out);

        String kind = kindFilter.getValue() == null ? "전체" : kindFilter.getValue();
        String q2 = searchField2.getText() == null ? "" : searchField2.getText().trim();
        List<Map<String, Object>> out2 = new ArrayList<>();
        for (Map<String, Object> r : processedAll) {
            String by = String.valueOf(r.get("approved_by"));
            if ("자동 매칭".equals(kind) && !"AUTO".equals(by)) {
                continue;
            }
            if ("관리자 적립".equals(kind) && !"ADMIN".equals(by)) {
                continue;
            }
            if ("수동 처리".equals(kind) && !"MANUAL".equals(by)) {
                continue;
            }
            if (!q2.isEmpty() && !String.valueOf(r.get("memo")).contains(q2) && !String.valueOf(r.get("deposit_amount")).contains(q2.replace(",", ""))
                    && !String.valueOf(r.get("approved_operator")).contains(q2)) {
                continue;
            }
            out2.add(r);
        }
        processed.setAll(out2);
    }

    // ── 처리·취소 ──

    private void processRow(Map<String, Object> r) {
        String what = String.valueOf(r.get("memo")) + " · " + WON.format(toLong(r.get("deposit_amount"))) + "원 · " + r.get("tx_date") + " " + r.get("tx_time") + " · " + r.get("account");
        TextInputDialog d = dialog("입금 처리", what + "\n\n처리자 SuperID 로 «처리» 표시합니다. 이 입금은 자동 대조·AI 검토 후보에서 빠집니다.\n메모(선택):", "");
        Optional<String> note = d.showAndWait();
        if (note.isEmpty()) {
            return;
        }
        long id = toLong(r.get("id"));
        ui.execute(() -> {
            String err = null;
            try {
                err = client.process(id, OPERATOR, note.get());
            } catch (Exception e) {
                err = e.getMessage();
            }
            String fin = err;
            Platform.runLater(() -> {
                if (fin != null) {
                    alert(Alert.AlertType.WARNING, "처리하지 못했습니다", fin);
                }
            });
            refresh();
        });
    }

    private void cancelRow(Map<String, Object> r) {
        String what = String.valueOf(r.get("memo")) + " · " + WON.format(toLong(r.get("deposit_amount"))) + "원 · " + r.get("tx_date") + " " + r.get("tx_time")
                + " · 처리자 " + r.get("approved_operator");
        TextInputDialog d = dialog("처리 취소", what + "\n\n처리를 취소해 다시 «미처리» 로 돌립니다. 자동 대조 후보가 됩니다.\n사유(선택):", "");
        Optional<String> note = d.showAndWait();
        if (note.isEmpty()) {
            return;
        }
        long id = toLong(r.get("id"));
        ui.execute(() -> {
            String err = null;
            try {
                err = client.cancel(id, OPERATOR, note.get());
            } catch (Exception e) {
                err = e.getMessage();
            }
            String fin = err;
            Platform.runLater(() -> {
                if (fin != null) {
                    alert(Alert.AlertType.WARNING, "취소하지 못했습니다", fin);
                }
            });
            refresh();
        });
    }



    // ── 공통 위젯 ──

    private TextInputDialog dialog(String title, String content, String initial) {
        TextInputDialog d = new TextInputDialog(initial);
        d.setTitle(title);
        d.setHeaderText(null);
        d.setContentText(content);
        d.getDialogPane().getStylesheets().add(App.class.getResource("/app.css").toExternalForm());
        d.getDialogPane().setMinWidth(560);
        return d;
    }

    private void alert(Alert.AlertType type, String title, String text) {
        Alert a = new Alert(type, text, ButtonType.OK);
        a.setTitle(title);
        a.setHeaderText(null);
        a.getDialogPane().getStylesheets().add(App.class.getResource("/app.css").toExternalForm());
        a.showAndWait();
    }

    private static Label chip(String text) {
        Label l = new Label(text);
        l.getStyleClass().add("chip");
        return l;
    }

    private static void setChip(Label l, String text, String cls) {
        l.setText(text);
        l.getStyleClass().removeAll("chip-ok", "chip-bad", "chip-muted");
        if (cls != null) {
            l.getStyleClass().add(cls);
        }
    }

    private static Label stat(String text) {
        Label l = new Label(text);
        l.getStyleClass().add("stat-value");
        return l;
    }

    private static VBox tile(String caption, Label value) {
        Label c = new Label(caption);
        c.getStyleClass().add("stat-caption");
        VBox v = new VBox(4, c, value);
        v.getStyleClass().add("stat-tile");
        return v;
    }

    private static Button pill(String text, String cls, javafx.event.EventHandler<javafx.event.ActionEvent> h) {
        Button b = new Button(text);
        b.getStyleClass().addAll("pill", cls);
        b.setOnAction(h);
        return b;
    }

    /** "key:제목:너비[:형식]" — won(천단위) · by(승인 구분) · act(동작) */
    private TableView<Map<String, Object>> table(ObservableList<Map<String, Object>> items, String... cols) {
        TableView<Map<String, Object>> tv = new TableView<>(items);
        tv.setPlaceholder(new Label("표시할 입금이 없습니다"));
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
            tv.getColumns().add(c);
        }
        return tv;
    }

    private TableColumn<Map<String, Object>, Void> buttonColumn(String text, String cls, int width, java.util.function.Consumer<Map<String, Object>> onClick,
                                                                 java.util.function.Predicate<Map<String, Object>> enabled) {
        TableColumn<Map<String, Object>, Void> c = new TableColumn<>("");
        c.setPrefWidth(width);
        c.setSortable(false);
        c.setCellFactory(col -> new TableCell<>() {
            private final Button b = new Button(text);
            {
                b.getStyleClass().addAll("pill", "pill-sm", cls);
                b.setOnAction(e -> {
                    Map<String, Object> row = getTableView().getItems().get(getIndex());
                    onClick.accept(row);
                });
            }

            @Override
            protected void updateItem(Void item, boolean empty) {
                super.updateItem(item, empty);
                if (empty || getIndex() < 0 || getIndex() >= getTableView().getItems().size()) {
                    setGraphic(null);
                    return;
                }
                Map<String, Object> row = getTableView().getItems().get(getIndex());
                setGraphic(enabled.test(row) ? b : null);
            }
        });
        return c;
    }

    private static String format(Object v, String fmt) {
        if (v == null) {
            return "";
        }
        switch (fmt) {
            case "won":
                return WON.format(toLong(v));
            case "by":
                return "ADMIN".equals(String.valueOf(v)) ? "관리자 적립" : "AUTO".equals(String.valueOf(v)) ? "자동 매칭" : "MANUAL".equals(String.valueOf(v)) ? "수동 처리" : String.valueOf(v);
            case "act":
                return "PROCESS".equals(String.valueOf(v)) ? "처리" : "CANCEL".equals(String.valueOf(v)) ? "취소" : String.valueOf(v);
            default:
                String s = String.valueOf(v);
                return s.length() > 19 && s.charAt(10) == ' ' ? s.substring(0, 19) : s.length() > 19 && s.charAt(10) == 'T' ? s.substring(0, 19).replace('T', ' ') : s;
        }
    }

    private static long toLong(Object o) {
        if (o instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(o).trim());
        } catch (Exception e) {
            return 0;
        }
    }
}
