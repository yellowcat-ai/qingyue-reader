package com.qingyue.reader;

import android.content.Context;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 百度翻译的语音合成接口（免费、无需 key），作为 Edge TTS 之外的第二条在线音色。
 * 纯 HTTP GET 返回 mp3，再用系统 MediaPlayer 播放，不涉及 native 库。
 *
 * v1.20：与 Edge 引擎一致引入会话代际 seq + 独立临时文件，
 * 避免慢请求迟到后被当成当前句播放（两路声音重叠）。
 *
 * v1.35：补齐两条「连续性」能力，此前这个引擎只有裸同步下载，是「换段必停顿」的重灾区。
 * 1) 预取 + 内容寻址磁盘缓存：当前段在播时就把后面几段下载好，播到直接命中，零网络等待；
 * 2) 下一段 MediaPlayer 预热接棒：本地 mp3 的 prepare 也要几十到两百毫秒，
 *    提前 prepare 好，段间空档从 200~400ms 降到几十毫秒。
 * 没有这两条时，每段都是「HTTP GET → 全量下载 mp3 → prepare → start」，
 * 弱网下一次要等 1~3 秒，听感就是超出正常换气的停顿。
 */
public class BaiduTtsEngine {
    private static final String TAG = "QingyueBaiduTts";
    private static final String BASE = "https://fanyi.baidu.com/gettts";

    /** 内存索引上限（key → 磁盘文件） */
    private static final int READY_MAX = 40;
    /** 预热轮询次数上限：8 次 × 250~400ms ≈ 2.4 秒 */
    private static final int NEXT_TRIES_MAX = 8;

    private final Context ctx;
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build();
    private final Handler main = new Handler(Looper.getMainLooper());

    private final AtomicInteger seq = new AtomicInteger(0);
    /** 预取代际：clearPrefetch 时自增，作废在途的预取请求 */
    private final AtomicInteger pseq = new AtomicInteger(0);
    private final Map<String, File> ready = new ConcurrentHashMap<>();
    private final Set<String> inflight = ConcurrentHashMap.newKeySet();
    /**
     * 预取通道（v1.36）：改成单线程串行。
     * 原来 3 并发在弱网下会被平分带宽：一段约 40KB、音频 7 秒，下行 6.7KB/s 时
     * 每条连接只分到 2.2KB/s，下载要 18 秒 > 播放 7 秒，缓冲持续亏空，
     * 表现就是每段之间固定卡十几秒。串行后每段独占带宽，下载 6 秒 < 播放 7 秒。
     * 百度是单次 HTTP GET，OkHttp 连接池会复用 TCP，串行不会反复握手。
     */
    private final ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "baidu-synth");
        t.setDaemon(true);
        return t;
    });

    private volatile MediaPlayer player;
    private volatile int playerGen = -1;
    private volatile boolean stopRequested = false;
    private volatile String lastError = "";

    /* ---- 段间无缝接棒 ---- */
    private volatile MediaPlayer nxt;
    private volatile File nxtFile;
    private volatile String nxtKey = "";
    private volatile int nxtGen = -1;
    private volatile boolean seamless = true;

    public BaiduTtsEngine(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    public String getLastError() {
        return lastError == null ? "" : lastError;
    }

    public interface Callback {
        void onResult(boolean ok);

        /** 真正出声的瞬间回调，带这段音频的时长（毫秒） */
        default void onStart(long durationMs) { }
    }

    public void setSeamless(boolean on) {
        seamless = on;
        if (!on) main.post(this::releaseNxt);
    }

    /* ===================== 缓存 ===================== */

    private static int spdOf(float rate) {
        return Math.max(1, Math.min(15, Math.round(5 * (rate <= 0 ? 1f : rate))));
    }

    private static String cacheKey(String text, float rate) {
        return "b|" + spdOf(rate) + "|" + Integer.toHexString(text.hashCode()) + "|" + text.length();
    }

    /** 内容寻址：同名即同文本同语速，天生可以跨会话复用 */
    private File cacheFile(String key) {
        return new File(ctx.getCacheDir(), "baidu_tts_c" + Integer.toHexString(key.hashCode()) + ".mp3");
    }

    private void trimIndex() {
        if (ready.size() < READY_MAX) return;
        List<String> keys = new ArrayList<>(ready.keySet());
        for (int i = 0; i < keys.size() - READY_MAX + 1 && i < keys.size(); i++) {
            ready.remove(keys.get(i));      // 只裁索引，磁盘文件留给 lookup 复用
        }
    }

    /** 已写入的缓存文件计数，用于按批触发运行期裁剪 */
    private final AtomicInteger cacheWrites = new AtomicInteger(0);

    /** 每写 32 个缓存文件触发一次裁剪，避免长时间连播把 cacheDir 撑爆 */
    private void maybePruneCache() {
        if ((cacheWrites.incrementAndGet() & 31) != 0) return;
        try {
            // 缓存裁剪单独起线程：不能占用串行合成通道，否则会拖慢下一段的预取
            Thread t = new Thread(() -> TtsCache.prune(ctx), "baidu-cache-prune");
            t.setDaemon(true);
            t.start();
        } catch (Throwable ignore) { }
    }

    private File lookup(String text, float rate) {
        final String key = cacheKey(text, rate);
        File f = ready.get(key);
        if (f != null && f.exists() && f.length() > 1000) return f;
        if (f != null) ready.remove(key);
        final File cf = cacheFile(key);
        if (cf.exists() && cf.length() > 1000) {
            ready.put(key, cf);
            return cf;
        }
        return null;
    }

    /** 换队列/切音色/停止时调用：丢索引与在途请求，磁盘缓存保留 */
    public void clearPrefetch() {
        pseq.incrementAndGet();
        inflight.clear();
        ready.clear();
        main.post(this::releaseNxt);
    }

    /* ===================== 预取 ===================== */

    /** 提前把某一段下载好放进缓存。失败无副作用：真正播到时还会正常下载 */
    public void prefetch(final String text, final float rate) {
        final String clean = text == null ? "" : text.trim();
        if (clean.isEmpty() || clean.length() > 200) return;
        final String key = cacheKey(clean, rate);
        if (ready.containsKey(key)) return;
        final File cf = cacheFile(key);
        if (cf.exists() && cf.length() > 1000) { ready.put(key, cf); return; }
        if (!inflight.add(key)) return;
        final int my = pseq.get();
        try {
            pool.execute(() -> {
                try {
                    if (my != pseq.get()) return;
                    if (!fetchTo(clean, rate, key)) return;
                    if (my != pseq.get()) return;
                    maybePruneCache();
                    trimIndex();
                    ready.put(key, cacheFile(key));
                } finally {
                    inflight.remove(key);
                }
            });
        } catch (Throwable t) {
            inflight.remove(key);
        }
    }

    /* ===================== 下载 ===================== */

    private static String urlOf(String text, float rate) throws Exception {
        return BASE + "?lan=zh&text=" + URLEncoder.encode(text, "UTF-8")
                + "&spd=" + spdOf(rate) + "&source=web";
    }

    private static Request requestOf(String url) {
        return new Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                        + " (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
                .header("Referer", "https://fanyi.baidu.com/")
                .build();
    }

    /** 同步下载到内容寻址缓存文件；返回是否成功 */
    private boolean fetchTo(String text, float rate, String key) {
        final File out = cacheFile(key);
        try {
            final String url = urlOf(text, rate);
            try (Response resp = client.newCall(requestOf(url)).execute()) {
                ResponseBody body = resp.body();
                String type = resp.header("Content-Type", "");
                if (!resp.isSuccessful() || body == null) {
                    lastError = "BaiduTts:" + resp.code();
                    return false;
                }
                if (type != null && type.contains("json")) {
                    lastError = "BaiduTts:文本过长";
                    return false;
                }
                byte[] mp3 = body.bytes();
                if (mp3.length < 1000) {
                    lastError = "BaiduTts:音频为空";
                    return false;
                }
                // 先写临时文件再原子改名：预取和按需下载可能同时拿同一段，直接覆盖会写出半截音频
                final File tmp = new File(ctx.getCacheDir(),
                        "baidu_tts_tmp" + Integer.toHexString(key.hashCode()) + "_" + System.nanoTime() + ".mp3");
                try {
                    try (FileOutputStream fos = new FileOutputStream(tmp)) { fos.write(mp3); }
                    if (!tmp.renameTo(out)) {
                        try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(mp3); }
                        deleteQuiet(tmp);
                    }
                } catch (Throwable t) {
                    deleteQuiet(tmp);
                    lastError = "write:" + t;
                    return false;
                }
                return true;
            }
        } catch (Throwable t) {
            lastError = "BaiduTts:" + t;
            Log.w(TAG, "fetch failed " + t);
            return false;
        }
    }

    /* ===================== 朗读 ===================== */

    public void speak(String text, float rate, Callback cb) {
        speak(text, null, rate, cb);
    }

    /**
     * 朗读一段，同时把 nextText 那段提前 prepare 好接棒。
     * 下一段只有已经在缓存里才会预热，否则不占带宽（与 Edge 引擎同策略）。
     */
    public void speak(String text, String nextText, float rate, Callback cb) {
        final int my = seq.incrementAndGet();
        stopRequested = false;
        lastError = "";
        final String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) { cb.onResult(true); return; }

        final String nkey = cacheKey(clean, rate);
        if (seamless && nxt != null && nkey.equals(nxtKey)) {
            startPrepared(clean, nextText, rate, cb, my);
            return;
        }
        playOrFetch(clean, nextText, rate, cb, my);
    }

    private void playOrFetch(final String text, final String nextText, final float rate,
                             final Callback cb, final int my) {
        File hit = lookup(text, rate);
        if (hit != null) { playFile(hit, nextText, rate, cb, my); return; }
        download(text, nextText, rate, cb, my);
    }

    private void download(final String text, final String nextText, final float rate,
                          final Callback cb, final int my) {
        final String key = cacheKey(text, rate);
        new Thread(() -> {
            final boolean ok = fetchTo(text, rate, key);
            if (my != seq.get() || stopRequested) return;
            if (!ok) {
                if (my == seq.get()) cb.onResult(false);
                return;
            }
            final File f = cacheFile(key);
            maybePruneCache();
            trimIndex();
            ready.put(key, f);
            main.post(() -> {
                if (my != seq.get() || stopRequested) return;
                playFile(f, nextText, rate, cb, my);
            });
        }, "qingyue-baidu-tts").start();
    }

    /** 唯一的出声入口：正常下载与缓存命中都走这里 */
    private void playFile(final File f, final String nextText, final float rate,
                          final Callback cb, final int my) {
        if (my != seq.get()) return;
        main.post(() -> {
            if (my != seq.get() || stopRequested) return;
            try {
                release();                                   // 先停旧的一路，绝不允许重叠
                MediaPlayer p = new MediaPlayer();
                player = p;
                playerGen = my;
                setupPlayer(p, f);
                attach(p, f, cb, my);
                p.prepare();
                p.start();
                notifyStart(p, cb);
            } catch (Throwable t) {
                lastError = "play:" + t;
                Log.w(TAG, "play failed " + t);
                release();
                deleteQuiet(f);
                if (my == seq.get()) cb.onResult(false);
                return;
            }
            main.postDelayed(() -> prepareNext(nextText, rate, my, 0), 80);
        });
    }

    /** 上一段播放时已经 prepare 好的这段：直接 start，几乎零空档 */
    private void startPrepared(final String text, final String nextText, final float rate,
                               final Callback cb, final int my) {
        main.post(() -> {
            final MediaPlayer p = nxt;
            final File pf = nxtFile;
            nxt = null; nxtFile = null; nxtKey = ""; nxtGen = -1;
            if (p == null) { playOrFetch(text, nextText, rate, cb, my); return; }
            if (my != seq.get() || stopRequested) { releaseOne(p); return; }   // 文件留作缓存
            try {
                release();
                player = p;
                playerGen = my;
                attach(p, pf, cb, my);
                p.start();
                notifyStart(p, cb);
            } catch (Throwable t) {
                lastError = "play2:" + t;
                Log.w(TAG, "prepared start failed " + t);
                releaseOne(p);
                playOrFetch(text, nextText, rate, cb, my);
                return;
            }
            main.postDelayed(() -> prepareNext(nextText, rate, my, 0), 80);
        });
    }

    /**
     * 预热下一段。没取到就小步轮询到 2.4 秒——只试一次的话，
     * 预取稍晚落盘就会退回「重新下载」，那一段就是 1~3 秒空档。
     */
    private void prepareNext(final String nextText, final float rate, final int my, final int tries) {
        if (!seamless) return;
        final String nt = nextText == null ? "" : nextText.trim();
        if (nt.isEmpty()) return;
        final String nkey = cacheKey(nt, rate);
        if (nxt != null && nkey.equals(nxtKey)) return;
        final File f = lookup(nt, rate);
        if (f == null) {
            if (tries < NEXT_TRIES_MAX && my == seq.get() && !stopRequested) {
                final int t = tries + 1;
                main.postDelayed(() -> {
                    if (my == seq.get() && !stopRequested) prepareNext(nextText, rate, my, t);
                }, t <= 4 ? 250L : 400L);
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
        nxt = p; nxtFile = f; nxtKey = nkey; nxtGen = my;
    }

    private void releaseNxt() {
        MediaPlayer p = nxt;
        nxt = null; nxtFile = null; nxtKey = ""; nxtGen = -1;
        if (p != null) releaseOne(p);        // 文件是磁盘缓存，不删
    }

    private void setupPlayer(MediaPlayer p, File f) throws Exception {
        // 播放期间由 MediaPlayer 自己持 PARTIAL_WAKE_LOCK：
        // 比服务层的 WakeLock 更贴合，锁屏后音频回调不容易被系统掐断
        try { p.setWakeMode(ctx, PowerManager.PARTIAL_WAKE_LOCK); } catch (Throwable ignore) { }
        try {
            p.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
        } catch (Throwable ignore) { }
        if (f != null) p.setDataSource(f.getAbsolutePath());
    }

    private void attach(final MediaPlayer p, final File f, final Callback cb, final int my) {
        p.setOnCompletionListener(mp -> {
            if (my != seq.get()) return;
            release();
            cb.onResult(true);              // v1.35：文件保留作缓存，不再播完即删
        });
        p.setOnErrorListener((mp, what, extra) -> {
            lastError = "MediaPlayer:" + what + "/" + extra;
            if (my == seq.get()) release();
            deleteQuiet(f);                 // 打开失败多半文件坏了
            if (my == seq.get()) cb.onResult(false);
            return true;
        });
    }

    private void notifyStart(MediaPlayer p, Callback cb) {
        long dur = 0;
        try { dur = p.getDuration(); } catch (Throwable ignore) { }
        if (dur < 0) dur = 0;
        try { cb.onStart(dur); } catch (Throwable ignore) { }
    }

    private void release() {
        releaseOne(player);
        player = null;
        playerGen = -1;
    }

    private void releaseOne(MediaPlayer p) {
        try {
            if (p == null) return;
            try { if (p.isPlaying()) p.stop(); } catch (Exception ignore) { }
            p.reset();
            p.release();
        } catch (Exception ignore) { }
    }

    private static void deleteQuiet(File f) {
        try { if (f != null && f.exists()) f.delete(); } catch (Throwable ignore) { }
    }

    public void stop() {
        seq.incrementAndGet();
        stopRequested = true;
        main.post(() -> {
            release();
            releaseNxt();       // 预热中的那段播放器也要放掉，文件保留
        });
    }

    public void shutdown() {
        stop();
        main.post(this::release);
    }
}
