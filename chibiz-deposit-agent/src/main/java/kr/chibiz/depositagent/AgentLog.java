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
import java.util.function.Consumer;

/** agent.log 파일 + 화면 로그 탭. 어느 쪽 실패도 흐름을 막지 않는다. */
public final class AgentLog {
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final Deque<String> recent = new ArrayDeque<>();
    private static volatile Consumer<String> listener;

    private AgentLog() {
    }

    public static void setListener(Consumer<String> l) {
        listener = l;
    }

    public static synchronized void info(String msg) {
        String line = LocalDateTime.now().format(TS) + " " + msg;
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
    }

    public static void warn(String msg) {
        info("[경고] " + msg);
    }

    public static synchronized List<String> recent() {
        return List.copyOf(recent);
    }
}
