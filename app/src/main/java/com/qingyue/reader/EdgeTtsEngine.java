package com.qingyue.reader;

import android.content.Context;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.PowerManager;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * 微软 Edge TTS 在线合成（免费、无需 key）。
 *
 * 鉴权用 Sec-MS-GEC 令牌，算法已升级到 v2（CS64 + 微软变体 SHA256），
 * 旧版 v1（纯 SHA256）目前一律返回 403。实现见 {@link EdgeGec}。
 *
 * 纯 Java + OkHttp + MediaPlayer，不涉及任何 native 库，不会造成进程崩溃。
 *
 * v1.20：引入「会话代际」seq。切句/停止时 seq++，所有在途的 WebSocket 帧、
 * 播放回调、错误回调一律按代际作废；每句话写独立的临时 mp3。
 * 这两点是「有时两个声音一起读」的根因：旧句子合成慢，迟到返回的音频
 * 会被当成当前句播放，与当前句重叠。
 *
 * v1.22：新增预合成缓存（prefetch）。逐句合成时每句都要走一次「建连接 →
 * 合成 → 落盘」，一段念完到下一段出声之间有几百毫秒空档，听感上是明显停顿。
 * 现在当前句播放的同时就把后两句先合成好放到内存/磁盘缓存里，下一句直接
 * 命中缓存开播，句间空档从 300~1500ms 降到几十毫秒。
 *
 * v1.35：缓存从「用完即删的临时文件」改成「内容寻址的持久缓存」。
 * 文件名由 文本+音色+语速 的 hash 决定，播放完不再删，下一句没取到时
 * 先查磁盘再决定是否重新合成；重听同一章、回退再听都是零合成。
 * 同时把「下一句预热」从只重试一次改成小步轮询（最多 2.4 秒），
 * 避免预取稍晚落盘就整个回落到「重新建连合成」的 1~3 秒大空档。
 */
public class EdgeTtsEngine {
    private static final String TAG = "QingyueEdgeTts";

    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String WSS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    // 版本号必须与 v2 令牌配套，否则同样 403
    private static final String CHROMIUM_FULL_VERSION = "143.0.3650.75";
    private static final String SEC_MS_GEC_VERSION = "2-" + CHROMIUM_FULL_VERSION;
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
    private static final String ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    private static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
    private static final String DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

    /** 内存索引上限（key → 磁盘文件）。磁盘文件另按 CACHE_MAX_FILES 裁剪，不受这个数限制 */
    private static final int READY_MAX = 40;

    private final Context ctx;
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build();
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 每次 speak/stop 自增；回调只有代际匹配才生效 */
    private final AtomicInteger seq = new AtomicInteger(0);

    /** 预合成代际：clearPrefetch 时自增，作废所有在途预取请求 */
    private final AtomicInteger pseq = new AtomicInteger(0);
    /**
     * 预取通道（v1.36）：单线程串行 + 复用同一条 WebSocket。
     *
     * 原来用 3 线程池、每段新建一条 WebSocket，在弱网下有两个致命问题：
     *
     * 1) 并发争抢带宽。3 条连接平分瓶颈带宽，每条只拿到 1/3。实测一段约 44KB、
     *    音频时长 7.3 秒；下行 6.71KB/s 时，3 并发平均每段只有 2.2KB/s，
     *    下载要 20 秒，而播放只等 7.3 秒 —— 缓冲持续亏空，每段之间固定卡十几秒。
     *    改成串行后每段独占全部带宽，下载 6.6 秒 < 播放 7.3 秒，余量为正。
     *
     * 2) 每段都要重新做 TLS 握手 + 传证书（约 4KB）。6.71KB/s 下这笔固定开销就是
     *    1 秒以上，正好把串行省下来的余量吃光。实测同一条连接可以连续合成多段
     *    （3 段连续成功），复用后只在首次和断线时付一次握手。
     *
     * 宽带下串行也无害：实测每段合成 500~900ms，深度 4 的缓冲 3 秒内就能填满。
     */
    private static final class PrefetchTask {
        final String text, voice, key;
        final float rate;
        final int pseq;
        PrefetchTask(String text, String voice, float rate, String key, int pseq) {
            this.text = text; this.voice = voice; this.rate = rate;
            this.key = key; this.pseq = pseq;
        }
    }

    /** 待合成队列（预取任务，串行消费） */
    private final LinkedBlockingQueue<PrefetchTask> pq = new LinkedBlockingQueue<>();
    /** 复用的合成连接（仅由串行通道线程读写） */
    private volatile WebSocket streamWs;
    /** 合成通道消费线程 */
    private volatile Thread streamThread;
    /** 当前在途 turn 的完成信号（listener 在 OkHttp 线程 countDown） */
    private volatile CountDownLatch turnLatch;
    private volatile ByteArrayOutputStream turnAudio;
    private volatile boolean turnOk;
    private volatile int turnPseq = -1;
    /** 连接序号：丢弃上一条连接关掉之后才到的迟到帧，避免串到新请求上 */
    private final AtomicInteger connSeq = new AtomicInteger(0);
    private volatile int curConnId = 0;
    /** 最近一次段落吞吐（字节/秒），用于判断是否处于弱网 */
    private final AtomicLong estBps = new AtomicLong(0);
    /** 连续弱网段数：达到 6 段就把「网络追不上码率」的事实上报给网页 */
    private final AtomicInteger slowStreak = new AtomicInteger(0);

    /** 已合成完毕、可直接播放的句子（key -> mp3 文件） */
    private final Map<String, File> ready = new ConcurrentHashMap<>();
    /** 正在预合成的 key，防止重复请求 */
    private final Set<String> inflight = ConcurrentHashMap.newKeySet();

    private volatile WebSocket ws;
    private volatile MediaPlayer player;
    private volatile int playerGen = -1;

    /* ---- 句间无缝接续（v1.29）----
     * 逐句播放时，每句都要 new MediaPlayer → setDataSource → prepare → start，
     * 本地 mp3 的 prepare 也要几十到两百毫秒，加上把上一句 stop/release 的时间，
     * 听感就是每句之间「顿一下」。预合成只解决了「等网络合成」，解决不了这一段。
     * 这里在当前句播放时就把它后面那句 prepare 好放进 nxt，播完直接 start，
     * 中间的 gap 从 200~400ms 降到几十毫秒。
     */
    private volatile MediaPlayer nxt;
    private volatile File nxtFile;
    private volatile String nxtKey = "";
    private volatile int nxtGen = -1;
    private volatile boolean seamless = true;

    private volatile boolean stopRequested = false;
    private volatile String lastError = "";

    public EdgeTtsEngine(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        cleanupCache(this.ctx);
    }

    /** 启动时清一次：旧版按代际命名的临时文件直接删，内容寻址的缓存按量裁剪。详见 TtsCache */
    private static void cleanupCache(Context ctx) {
        TtsCache.prune(ctx);
    }

    /** 已写入的缓存文件计数，用于按批触发运行期裁剪 */
    private final AtomicInteger cacheWrites = new AtomicInteger(0);

    /** 每写 32 个缓存文件触发一次裁剪：连续朗读几十章不裁会吃掉几百 MB */
    private void maybePruneCache() {
        if ((cacheWrites.incrementAndGet() & 31) != 0) return;
        try {
            Thread t = new Thread(() -> TtsCache.prune(ctx), "tts-cache-prune");
            t.setDaemon(true);
            t.start();
        } catch (Throwable ignore) { }
    }

    public String getLastError() {
        return lastError == null ? "" : lastError;
    }

    public interface Callback {
        void onResult(boolean ok);
        /** 真正出声的瞬间回调，带上这段音频的时长（毫秒，0 表示未知）。
         *  合并多句朗读时，上层靠它把高亮在几句之间按时间轴推开。 */
        default void onStart(long durationMs) { }
    }

    /* ===================== 预合成缓存 ===================== */

    private static String cacheKey(String text, String voice, float rate) {
        return voice + "|" + Math.round(rate * 100f) + "|"
                + Integer.toHexString(text.hashCode()) + "|" + text.length();
    }

    private static String voiceOf(String voice) {
        return (voice == null || voice.isEmpty()) ? DEFAULT_VOICE : voice;
    }

    /**
     * 内容寻址的缓存文件：同名 = 同文本同音色同语速，天然可以跨会话复用。
     * 旧版按「代际 + 序号」命名，播完就删，等于每次重听都要重新合成一遍。
     */
    private File cacheFile(String key) {
        return new File(ctx.getCacheDir(), "edge_tts_c" + Integer.toHexString(key.hashCode()) + ".mp3");
    }

    /**
     * 提前把某一句合成好放进缓存。播放到它时直接命中，句间就没有合成等待的停顿。
     * 失败无副作用：真正播到这句时还会走正常合成流程。
     */
    public void prefetch(final String text, final String voice, final float rate) {
        final String clean = text == null ? "" : text.trim();
        // 太长的句子不预取：单个请求耗时长，等它不如等播放到再合成
        if (clean.isEmpty() || clean.length() > 300) return;
        final String v = voiceOf(voice);
        final String key = cacheKey(clean, v, rate);
        if (ready.containsKey(key)) return;
        // 磁盘上已经有这一段（上次听过 / 刚预取完）：直接登记进索引，不再发请求
        final File cf = cacheFile(key);
        if (cf.exists() && cf.length() > 512) { ready.put(key, cf); return; }
        if (!inflight.add(key)) return;
        final int my = pseq.get();
        try {
            ensureStreamThread();
            pq.offer(new PrefetchTask(clean, v, rate, key, my));
        } catch (Throwable t) {
            inflight.remove(key);
        }
    }

    /** 懒启动串行合成通道线程（只有真正要预取时才起） */
    private void ensureStreamThread() {
        if (streamThread != null) return;
        synchronized (this) {
            if (streamThread != null) return;
            Thread t = new Thread(this::streamLoop, "edge-synth");
            t.setDaemon(true);
            t.start();
            streamThread = t;
        }
    }

    /** 串行合成通道：一次只合成一段，独占带宽，连接复用 */
    private void streamLoop() {
        while (true) {
            PrefetchTask task;
            try {
                task = pq.poll(45, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                return;
            }
            if (task == null) {
                // 空闲久了主动断开：服务端会踢空闲连接，留一条半死连接不如重连
                closeStream();
                continue;
            }
            if (task.pseq != pseq.get()) {           // 已被 clearPrefetch 作废
                inflight.remove(task.key);
                continue;
            }
            byte[] mp3 = synthSerial(task);
            if (mp3 != null) storeReady(mp3, task.key);
            else inflight.remove(task.key);
        }
    }

    /** 在串行通道上合成一段；连接断了就重连重试一次 */
    private byte[] synthSerial(PrefetchTask task) {
        for (int attempt = 0; attempt < 2; attempt++) {
            final long t0 = System.nanoTime();
            WebSocket sock = ensureStream();
            if (sock == null) continue;
            final ByteArrayOutputStream audio = new ByteArrayOutputStream();
            final CountDownLatch latch = new CountDownLatch(1);
            turnAudio = audio;
            turnOk = false;
            turnPseq = pseq.get();
            turnLatch = latch;
            try {
                if (!sendSsml(sock, task.text, task.voice, task.rate)) {
                    // 连接已失效：立刻丢弃重连，不要等满 25 秒合成超时
                    Log.w(TAG, "stream send failed, reconnecting");
                    closeStream();
                    continue;
                }
            } catch (Throwable t) {
                closeStream();
                continue;
            }
            boolean done;
            try {
                done = latch.await(25, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                done = false;
            }
            turnLatch = null;
            if (done && turnOk && audio.size() > 512) {
                recordThroughput(audio.size(), (System.nanoTime() - t0) / 1_000_000L);
                return audio.toByteArray();
            }
            // 超时或连接异常：这条连接的状态不再可信，丢掉重来
            Log.w(TAG, "synth retry, done=" + done + " ok=" + turnOk + " bytes=" + audio.size());
            closeStream();
        }
        return null;
    }

    /** 拿到可用的复用连接（首次或断线后新建，并先发配置帧） */
    private WebSocket ensureStream() {
        WebSocket cur = streamWs;
        if (cur != null) return cur;
        final CountDownLatch open = new CountDownLatch(1);
        final WebSocket[] ref = {null};
        final int cid = connSeq.incrementAndGet();
        client.newWebSocket(buildRequest(), new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                ref[0] = socket;
                curConnId = cid;
                sendConfig(socket);
                open.countDown();
            }

            @Override public void onMessage(WebSocket socket, String t) {
                if (cid != curConnId) return;            // 上一条连接的迟到帧
                if (t == null || !t.contains("Path:turn.end")) return;
                turnOk = true;
                CountDownLatch l = turnLatch;
                if (l != null) l.countDown();
            }

            @Override public void onMessage(WebSocket socket, okio.ByteString bytes) {
                if (cid != curConnId) return;            // 上一条连接的迟到帧
                if (turnPseq != pseq.get()) return;      // 已作废，别污染当前段
                ByteArrayOutputStream out = turnAudio;
                if (out != null) collectAudio(bytes, out);
            }

            @Override public void onFailure(WebSocket socket, Throwable t, Response response) {
                if (streamWs == socket) streamWs = null;
                open.countDown();
                if (cid != curConnId) return;
                CountDownLatch l = turnLatch;
                if (l != null) l.countDown();
            }

            @Override public void onClosed(WebSocket socket, int code, String reason) {
                if (streamWs == socket) streamWs = null;
                open.countDown();
                if (cid != curConnId) return;
                CountDownLatch l = turnLatch;
                if (l != null) l.countDown();
            }
        });
        try {
            if (!open.await(15, TimeUnit.SECONDS)) return null;
        } catch (InterruptedException e) {
            return null;
        }
        WebSocket s = ref[0];
        if (s == null) return null;
        streamWs = s;
        return s;
    }

    private void closeStream() {
        WebSocket s = streamWs;
        streamWs = null;
        curConnId = 0;              // 旧连接的迟到回调一律失效
        if (s != null) {
            try { s.close(1000, "idle"); } catch (Throwable ignore) { }
        }
    }

    /**
     * 记录实际吞吐并判断是否处于弱网。
     * 阈值取 48kbps 码率（约 6KB/s）的 1.25 倍：吞吐低于它意味着下载速度追不上播放速度，
     * 无论怎么优化缓冲都会被吃空，只能建议换离线音色。
     */
    private void recordThroughput(int bytes, long ms) {
        if (ms <= 0) return;
        final long bps = bytes * 1000L / ms;
        long prev = estBps.get();
        estBps.set(prev == 0 ? bps : (prev * 3 + bps) / 4);      // EWMA，避免单次抖动就下结论
        if (bps < 7500) {
            if (slowStreak.incrementAndGet() == 6) notifySlowNetwork();
        } else {
            slowStreak.set(0);
        }
    }

    /** 网速持续低于码率：告知网页层，由前端提示用户改用离线音色 */
    private void notifySlowNetwork() {
        try {
            Log.w(TAG, "network below bitrate: est=" + estBps.get() + " B/s");
            if (onSlowNetwork != null) onSlowNetwork.run();
        } catch (Throwable ignore) { }
    }

    /** 弱网回调（NativeTTS 注入，用于向网页层推送提示） */
    private volatile Runnable onSlowNetwork;
    public void setOnSlowNetwork(Runnable r) { this.onSlowNetwork = r; }

    private void storeReady(byte[] mp3, String key) {
        try {
            if (mp3 == null || mp3.length < 512) return;
            final File out = writeAtomically(mp3, key);
            if (out == null) return;
            maybePruneCache();
            trimIndex();
            ready.put(key, out);
        } finally {
            inflight.remove(key);
        }
    }

    /**
     * 只裁剪内存索引，不动磁盘文件。
     * 磁盘文件是内容寻址的，下次 lookup 还会把它们捞回来，删了等于白合成一遍。
     */
    private void trimIndex() {
        if (ready.size() < READY_MAX) return;
        List<String> keys = new ArrayList<>(ready.keySet());
        for (int i = 0; i < keys.size() - READY_MAX + 1 && i < keys.size(); i++) {
            ready.remove(keys.get(i));
        }
    }

    /**
     * 取可播放的音频文件（v1.35：取用不删）。
     * 先查内存索引，再查磁盘——磁盘命中说明上次已经合成过，直接用，零网络。
     */
    private File lookup(String text, String voice, float rate) {
        final String key = cacheKey(text, voiceOf(voice), rate);
        File f = ready.get(key);
        if (f != null && f.exists() && f.length() > 512) return f;
        if (f != null) ready.remove(key);                       // 索引失效，清掉
        final File cf = cacheFile(key);
        if (cf.exists() && cf.length() > 512) {
            ready.put(key, cf);
            return cf;
        }
        return null;
    }

    /** 换队列/切换音色/停止朗读时调用：丢掉内存索引与在途预取。磁盘缓存保留，可继续复用 */
    public void clearPrefetch() {
        pseq.incrementAndGet();
        pq.clear();                 // 排空待合成队列，作废的任务由 pseq 兜住
        inflight.clear();
        ready.clear();
        slowStreak.set(0);
        main.post(this::releaseNxt);
    }

    /**
     * 先写临时文件再原子改名到缓存路径。
     * 预取线程和按需合成线程可能同时合成同一段文本，直接覆盖同一个文件会写出半截音频；
     * 改名（Linux rename）是原子的，谁后完成谁生效，永远不会出现坏文件。
     */
    private File writeAtomically(byte[] mp3, String key) {
        final File dst = cacheFile(key);
        final File tmp = new File(ctx.getCacheDir(),
                "edge_tts_tmp" + Integer.toHexString(key.hashCode()) + "_" + System.nanoTime() + ".mp3");
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(mp3); }
            if (!tmp.renameTo(dst)) {
                try (FileOutputStream out = new FileOutputStream(dst)) { out.write(mp3); }
                deleteQuiet(tmp);
            }
            return dst;
        } catch (Throwable t) {
            deleteQuiet(tmp);
            return null;
        }
    }

    /* ===================== 合成与播放 ===================== */

    /** 一次朗读任务：当前句 + 可选的「下一句」（提前 prepare 好，无缝接上） */
    private final class Job {
        final String text, next, voice;
        final float rate;
        final Callback cb;
        final int my;
        /** 预热轮询已尝试次数（见 prepareNext 的 NEXT_TRIES_MAX） */
        int nextTries = 0;
        // 合成超时用：同一次 speak 可能因 403 重连，gen 每次连都递增，旧定时器自然失效
        int gen = 0;
        volatile boolean finished = false;
        /** 已被判失败（超时/上层切走）：之后迟到的音频一律不许出声，否则会和降级后的百度/系统语音叠在一起 */
        volatile boolean aborted = false;

        Job(String text, String next, String voice, float rate, Callback cb, int my) {
            this.text = text;
            this.next = next;
            this.voice = voice;
            this.rate = rate;
            this.cb = cb;
            this.my = my;
        }
    }

    /** 单次合成的最长等待：超过就判失败，交给上层降级，绝不让队列无声干等 */
    private static final long SYNTH_TIMEOUT_MS = 10_000L;

    /** 开关：句间无缝接续（关掉就退回每句完整新建播放器的老路径） */
    public void setSeamless(boolean on) {
        seamless = on;
        if (!on) main.post(this::releaseNxt);
    }

    public boolean isSeamless() {
        return seamless;
    }

    /** 合成并朗读一句；voice 传空用晓晓 */
    public void speak(String text, String voice, float rate, Callback cb) {
        speak(text, null, voice, rate, cb);
    }

    /**
     * 合成并朗读一句，同时把 nextText 那句提前 prepare 好，播完直接接上。
     * 下一句必须已经预合成（命中缓存）才会预热，否则不占用网络，行为等同单句。
     */
    public void speak(String text, String nextText, String voice, float rate, Callback cb) {
        final int my = seq.incrementAndGet();
        stopRequested = false;
        lastError = "";
        final String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) { cb.onResult(true); return; }

        final Job j = new Job(clean, nextText, voice, rate, cb, my);
        // 上一句播放时已经把这句 prepare 好了：直接 start，省掉整段建播放器的时间
        if (seamless && nxt != null && cacheKey(clean, voiceOf(voice), rate).equals(nxtKey)) {
            startPrepared(j);
            return;
        }
        File hit = lookup(clean, voice, rate);
        if (hit != null) {
            playFile(hit, cacheKey(clean, voiceOf(voice), rate), j);
            return;
        }
        connect(j, false);
    }

    private Request buildRequest() {
        final String url = WSS_URL + "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN
                + "&Sec-MS-GEC=" + EdgeGec.generateSecMsGec(System.currentTimeMillis())
                + "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION
                + "&ConnectionId=" + UUID.randomUUID().toString().replace("-", "");
        return new Request.Builder()
                .url(url)
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Origin", ORIGIN)
                .header("Sec-WebSocket-Version", "13")
                .header("User-Agent", UA)
                .header("Accept-Encoding", "gzip, deflate, br")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Cookie", "muid=" + randomHex32() + ";")
                .build();
    }

    /** 1) 配置帧（Path 必须是 speech.config，写成 ssml 会被服务端判为非法请求） */
    private static void sendConfig(WebSocket ws) {
        String ts = dateStr();
        String cfg = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},"
                + "\"outputFormat\":\"" + OUTPUT_FORMAT + "\"}}}}";
        ws.send("X-Timestamp:" + ts + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n" + cfg);
    }

    /**
     * 2) 文本帧。返回 false 表示这条连接已经不可用（OkHttp 在连接关闭时 send 只返回 false
     * 而不抛异常），调用方应立即重连，否则要白等一次合成超时。
     */
    private static boolean sendSsml(WebSocket ws, String text, String voice, float rate) {
        int pct = Math.round((rate - 1f) * 100);
        String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='+0Hz' rate='" + (pct >= 0 ? "+" : "") + pct + "%' volume='+0%'>"
                + escapeXml(text) + "</prosody></voice></speak>";
        return ws.send("X-RequestId:" + UUID.randomUUID().toString().replace("-", "") + "\r\n"
                + "X-Timestamp:" + dateStr() + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "Path:ssml\r\n\r\n" + ssml);
    }

    /** 二进制帧：2 字节 header 长度 + header + mp3 分片 */
    private static void collectAudio(okio.ByteString bytes, ByteArrayOutputStream out) {
        byte[] arr = bytes == null ? null : bytes.toByteArray();
        if (arr == null || arr.length <= 2) return;
        int headerLen = ((arr[0] & 0xff) << 8) | (arr[1] & 0xff);
        if (arr.length < 2 + headerLen) return;
        String header = new String(arr, 2, headerLen, StandardCharsets.UTF_8);
        if (!header.contains("Path:audio")) return;
        out.write(arr, 2 + headerLen, arr.length - 2 - headerLen);
    }

    private void connect(final Job j, boolean retried) {
        stopRequested = false;
        lastError = "";
        final String v = voiceOf(j.voice);
        final ByteArrayOutputStream audio = new ByteArrayOutputStream();
        if (j.text.isEmpty()) { j.cb.onResult(true); return; }

        final int gen = ++j.gen;
        final WebSocket[] sock = { null };
        // 合成卡住（服务端不回 turn.end、网络半断）时队列会一直干等，这里兜一刀
        final Runnable timeout = () -> {
            if (j.my != seq.get() || j.gen != gen || j.finished) return;
            lastError = "EdgeTts:timeout";
            j.aborted = true;
            Log.w(TAG, "synth timeout after " + SYNTH_TIMEOUT_MS + "ms, len=" + j.text.length());
            try { if (sock[0] != null) sock[0].close(1000, "timeout"); } catch (Throwable ignore) { }
            if (!stopRequested) j.cb.onResult(false);
        };
        main.postDelayed(timeout, SYNTH_TIMEOUT_MS);

        client.newWebSocket(buildRequest(), new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                if (j.my != seq.get()) { try { webSocket.close(1000, "stale"); } catch (Exception ignore) {} return; }
                sock[0] = webSocket;
                ws = webSocket;
                sendConfig(webSocket);
                sendSsml(webSocket, j.text, v, j.rate);
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                if (j.my != seq.get()) return;                  // 过期会话，丢弃
                if (text != null && text.contains("Path:turn.end")) {
                    j.finished = true;
                    webSocket.close(1000, "done");
                    playBytes(audio.toByteArray(), j);
                }
            }

            @Override public void onMessage(WebSocket webSocket, okio.ByteString bytes) {
                if (j.my != seq.get()) return;
                collectAudio(bytes, audio);
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (j.my != seq.get()) return;
                if (j.finished) return;                         // 已由超时判过，别重复回调
                j.finished = true;
                int code = response != null ? response.code() : 0;
                // 403 常见于本机时间不准：令牌按 5 分钟窗口计算，偏差过大会被拒。
                // 用服务端 Date 头校正后重试一次。
                if (code == 403 && !retried && correctClock(response)) {
                    Log.w(TAG, "403, clock corrected by " + EdgeGec.getClockSkew() + "s, retry");
                    j.finished = false;
                    connect(j, true);
                    return;
                }
                lastError = "EdgeTts:" + (code > 0 ? String.valueOf(code) : String.valueOf(t));
                Log.w(TAG, "ws failure " + lastError);
                if (!stopRequested) j.cb.onResult(false);
            }
        });
    }

    /** 用响应头里的服务端时间校正本地时钟偏差；成功返回 true */
    private static boolean correctClock(Response response) {
        try {
            String date = response.header("Date");
            if (date == null || date.isEmpty()) return false;
            SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
            long server = f.parse(date).getTime();
            double skew = (server - System.currentTimeMillis()) / 1000.0;
            if (Math.abs(skew) < 1) return false;
            EdgeGec.adjustClockSkew(skew);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "clock correct failed: " + t);
            return false;
        }
    }

    private void playBytes(byte[] mp3, final Job j) {
        if (j.aborted || j.my != seq.get()) return;
        if (mp3 == null || mp3.length == 0) { j.cb.onResult(false); return; }
        // v1.35：直接写成内容寻址的缓存文件，播完保留，下次同段文本零合成
        final String key = cacheKey(j.text, voiceOf(j.voice), j.rate);
        final File f = writeAtomically(mp3, key);
        if (f == null) {
            lastError = "write:failed";
            j.cb.onResult(false);
            return;
        }
        ready.put(key, f);
        maybePruneCache();
        playFile(f, key, j);
    }

    private void setupPlayer(MediaPlayer p, File f) throws Exception {
        try { p.setWakeMode(ctx, PowerManager.PARTIAL_WAKE_LOCK); } catch (Throwable ignore) { }
        try {
            p.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
        } catch (Throwable ignore) { }
        p.setDataSource(f.getAbsolutePath());
    }

    private void attachListeners(final MediaPlayer p, final File f, final Job j) {
        p.setOnCompletionListener(mp -> {
            if (j.my != seq.get()) return;                // 旧句播完，不要推进队列
            releasePlayer();
            // v1.35：播完不删文件——它是内容寻址的缓存，重听这一段可以直接复用
            j.cb.onResult(true);
        });
        p.setOnErrorListener((mp, what, extra) -> {
            lastError = "MediaPlayer:" + what + "/" + extra;
            if (j.my == seq.get()) releasePlayer();
            deleteQuiet(f);                               // 打开失败多半是文件坏了，删掉让它重新合成
            if (j.my == seq.get()) j.cb.onResult(false);
            return true;
        });
    }

    /** 播放一个已落盘的 mp3（正常合成与预取缓存共用的唯一出声入口） */
    private void playFile(final File f, final String key, final Job j) {
        if (j.my != seq.get()) return;
        main.post(() -> {
            if (j.my != seq.get()) return;                  // 排队期间已被切句，文件留作缓存
            try {
                releasePlayer();                                // 先停掉上一代，绝不允许两路同时出声
                MediaPlayer p = new MediaPlayer();
                player = p;
                playerGen = j.my;
                setupPlayer(p, f);
                attachListeners(p, f, j);
                p.prepare();
                p.start();
                notifyStart(p, j);
            } catch (Throwable t) {
                lastError = "play:" + t;
                Log.w(TAG, "play failed " + t);
                releasePlayer();
                deleteQuiet(f);
                if (j.my == seq.get()) j.cb.onResult(false);
                return;
            }
            // 出声之后再去预热下一句，别拖慢起播
            main.postDelayed(() -> prepareNext(j), 80);   // 让音频先稳住再预热，避免起播抖动
        });
    }

    /** 上一句播放时已经 prepare 好的那句：直接 start，几乎零空档 */
    private void startPrepared(final Job j) {
        main.post(() -> {
            final MediaPlayer p = nxt;
            final File pf = nxtFile;
            nxt = null; nxtFile = null; nxtKey = ""; nxtGen = -1;
            if (p == null) { speakFallback(j); return; }
            if (j.my != seq.get() || j.aborted) { releaseOne(p); return; }   // 文件留作缓存
            try {
                if (player != null) releasePlayer();   // 上一句理论上已释放，这里是兜底：绝不允许两路同时出声
                player = p;
                playerGen = j.my;
                attachListeners(p, pf, j);
                p.start();
                notifyStart(p, j);
            } catch (Throwable t) {
                lastError = "play2:" + t;
                Log.w(TAG, "prepared start failed " + t);
                releaseOne(p);
                deleteQuiet(pf);
                speakFallback(j);
                return;
            }
            main.postDelayed(() -> prepareNext(j), 80);   // 让音频先稳住再预热，避免起播抖动
        });
    }

    /** 预热的播放器没接上（竞态/异常）：退回正常取缓存或重新合成 */
    private void speakFallback(final Job j) {
        File hit = lookup(j.text, j.voice, j.rate);
        if (hit != null) { playFile(hit, cacheKey(j.text, voiceOf(j.voice), j.rate), j); return; }
        connect(j, false);
    }

    /** 预热轮询次数上限：8 次 × 250~400ms ≈ 2.4 秒，足够覆盖一次慢合成 */
    private static final int NEXT_TRIES_MAX = 8;

    /**
     * 把下一句 prepare 好放在 nxt 里等接棒。
     * 只吃已经合成好的缓存：现去合成会跟当前这句抢带宽，反而更容易卡。
     *
     * v1.35：没取到不再「只重试一次就放弃」，改成小步轮询到 2.4 秒。
     * 原来预取稍晚落盘就直接退回 connect() 重新建连合成，那一段就是 1~3 秒的明显空档。
     */
    private void prepareNext(final Job j) {
        if (!seamless) return;
        final String nt = j.next == null ? "" : j.next.trim();
        if (nt.isEmpty()) return;
        final String nkey = cacheKey(nt, voiceOf(j.voice), j.rate);
        if (nxt != null && nkey.equals(nxtKey)) return;
        final File f = lookup(nt, j.voice, j.rate);
        if (f == null) {
            if (j.nextTries < NEXT_TRIES_MAX && j.my == seq.get() && !j.aborted) {
                j.nextTries++;
                final long delay = j.nextTries <= 4 ? 250L : 400L;
                main.postDelayed(() -> {
                    if (j.my == seq.get() && !j.aborted) prepareNext(j);
                }, delay);
            }
            return;
        }
        MediaPlayer p = null;
        try {
            p = new MediaPlayer();
            setupPlayer(p, f);
            p.prepare();
        } catch (Throwable t) {
            if (p != null) { try { p.release(); } catch (Exception ignore) { } }
            deleteQuiet(f);
            return;
        }
        releaseNxt();
        nxt = p; nxtFile = f; nxtKey = nkey; nxtGen = j.my;
    }

    private void releaseNxt() {
        MediaPlayer p = nxt;
        nxt = null; nxtFile = null; nxtKey = ""; nxtGen = -1;
        if (p != null) releaseOne(p);          // 文件是磁盘缓存，不删
    }

    /** 起播回调（带真实音频时长），供上层按时间轴推进合并朗读的高亮 */
    private void notifyStart(MediaPlayer p, Job j) {
        long dur = 0;
        try { dur = p.getDuration(); } catch (Throwable ignore) { }
        if (dur < 0) dur = 0;
        try { j.cb.onStart(dur); } catch (Throwable ignore) { }
    }

    private void releaseOne(MediaPlayer p) {
        try {
            try { if (p.isPlaying()) p.stop(); } catch (Exception ignore) { }
            p.reset();
            p.release();
        } catch (Exception ignore) { }
    }

    private void releasePlayer() {
        try {
            MediaPlayer p = player;
            player = null;
            playerGen = -1;
            if (p != null) releaseOne(p);
        } catch (Exception ignore) {}
    }

    private static void deleteQuiet(File f) {
        try { if (f != null && f.exists()) f.delete(); } catch (Throwable ignore) {}
    }

    /** 立即作废当前会话：在途的合成、迟到的音频、旧的播放器全部不再生效 */
    public void stop() {
        seq.incrementAndGet();
        stopRequested = true;
        final WebSocket old = ws;
        ws = null;
        try { if (old != null) old.close(1000, "stop"); } catch (Exception ignore) {}
        main.post(() -> {
            // 只停掉旧代际的播放器（stop 之后立刻开新句时，新播放器不能被误停）
            if (playerGen >= 0 && playerGen < seq.get()) releasePlayer();
            else if (playerGen < 0) releasePlayer();
            releaseNxt();
        });
    }

    public void shutdown() {
        stop();
        clearPrefetch();
        main.post(() -> { releasePlayer(); releaseNxt(); });
        closeStream();
        Thread t = streamThread;
        streamThread = null;
        if (t != null) t.interrupt();
    }

    private static String randomHex32() {
        StringBuilder sb = new StringBuilder(32);
        java.util.Random r = new java.util.Random();
        for (int i = 0; i < 32; i++) sb.append(Integer.toHexString(r.nextInt(16)).toUpperCase(Locale.US));
        return sb.toString();
    }

    private static String dateStr() {
        SimpleDateFormat f = new SimpleDateFormat(
                "EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("GMT"));
        return f.format(new Date());
    }

    private static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
