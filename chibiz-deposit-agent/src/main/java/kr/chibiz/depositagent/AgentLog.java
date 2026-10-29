package kr.chibiz.depositagent;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * 동작 로그 — agent.log 파일 + 화면 로그 탭 + DB(agent_log, MCP list_logs 로 조회).
 * 어느 쪽 실패도 흐름을 막지 않는다. DB 저장은 별도 스레드이며, DB 저장 실패는 다시 로그로 남기지 않는다(되풀이 방지).
 */
public final class AgentLog {
    /** DB 에 한 줄 저장하는 쪽(App 이 DB 준비 뒤 등록) */
    public interface DbSink {
        void save(LocalDateTime at, String level, String message) throws Exception;
    }

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final Deque<String> recent = new ArrayDeque<>();
    private static volatile Consumer<String> listener;
    private static volatile DbSink dbSink;
    private static final ExecutorService dbWriter = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "log-db");
        t.setDaemon(true);
        return t;
    });

    private AgentLog() {
    }

    public static void setListener(Consumer<String> l) {
        listener = l;
    }

    public static void setDbSink(DbSink s) {
        dbSink = s;
    }

    public static void info(String msg) {
        write("INFO", msg);
    }

    public static void warn(String msg) {
        write("WARN", msg);
    }

    private static synchronized void write(String level, String msg) {
        LocalDateTime now = LocalDateTime.now().withNano(0);
        String line = now.format(TS) + " " + ("WARN".equals(level) ? "[경고] " : "") + msg;
        System.out.println(line);
        recent.addLast(line);
        while (recent.size() > 500) {
            recent.removeFirst();
        }
        try (PrintWriter w = new PrintWriter(new FileWriter(new File(System.getProperty("agent.home", "."), "agent.log"), true))) {
            w.println(line);
        } catch (IOException ignored) {
            // 로그 파일 실패는 무시
        }
        Consumer<String> l = listener;
        if (l != null) {
            try {
                l.accept(line);
            } catch (Exception ignored) {
                // 화면 갱신 실패 무시
            }
        }
        DbSink s = dbSink;
        if (s != null) {
            dbWriter.execute(() -> {
                try {
                    s.save(now, level, msg.length() > 1000 ? msg.substring(0, 1000) : msg);
                } catch (Exception e) {
                    System.err.println("agent_log 저장 실패: " + e.getMessage());
                }
            });
        }
    }

    public static synchronized List<String> recent() {
        return List.copyOf(recent);
    }
}
