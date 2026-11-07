package com.qingyue.reader;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 原生朗读桥接：把 Android TextToSpeech 暴露给网页 JS（window.AndroidTTS）。
 * 网页侧仍负责逐句切分与高亮，Java 侧只负责「说一句 + 回调完成事件」。
 *
 * 引擎策略：先用系统默认 TTS 引擎；若它不支持中文，自动遍历已安装的其它
 * TTS 引擎找到第一个支持中文的并切换；把「当前引擎 / 中文可用性 / 音色数」
 * 通过 window.__ttsState 推给网页展示与引导。
 */
public class NativeTTS {

    private static final String TAG = "NativeTTS";

    private final Activity activity;
    private final WebView webView;
    private final Context appContext;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private volatile boolean ready = false;
    private volatile boolean zhAvailable = false;
    private String engineName = "";        // 当前使用的引擎包名
    private float rate = 1.0f;
    private float pitch = 1.0f;
    private String voiceName = null;
    private boolean engineProbing = false; // 防止重复探测

    /* 内置离线引擎（sherpa-onnx + 小燕中文女声）：优先使用 */
    private final OfflineTtsEngine builtin = new OfflineTtsEngine();
    private volatile boolean builtinReady = false;
    private volatile String builtinErr = "";   // 内置引擎初始化失败原因（诊断用）
    private static final String BUILTIN_NAME = "小燕 · 离线女声";
    private static final String APP_VER = "v1.33";

    /* ---------------- 朗读进度落盘 ----------------
     * 后台连播时网页被系统冻结，它没法保存进度；App 被划掉/被杀时网页更没机会保存。
     * 所以原生这边每次推进都写一份「书 + 章 + 句」到 SharedPreferences，
     * 下次进阅读页时网页可以取回这份位置（比库里的新就用它）。
     */
    private String qBookId = "";
    private long posSavedAt = 0;
    private int posSavedChapter = -1, posSavedIndex = -1;

    private android.content.SharedPreferences posPrefs() {
        return appContext.getSharedPreferences("qingyue_pos", Context.MODE_PRIVATE);
    }

    private void saveQueuePos(boolean force) {
        try {
            if (qBookId == null || qBookId.isEmpty()) return;
            long now = System.currentTimeMillis();
            if (!force && qChapter == posSavedChapter && qIndex == posSavedIndex) return;
            if (!force && now - posSavedAt < 8000) return;
            if (qChapter < 0) return;
            posPrefs().edit()
                    .putString("book", qBookId)
                    .putInt("chapter", qChapter)
                    .putInt("index", qIndex)
                    .putInt("total", queue.size())
                    .putString("title", qTitle == null ? "" : qTitle)
                    .putLong("ts", now)
                    .apply();
            posSavedAt = now;
            posSavedChapter = qChapter;
            posSavedIndex = qIndex;
        } catch (Throwable ignore) { }
    }

    /** 网页在开播前告知是哪本书，进度才知道该记给谁 */
    @JavascriptInterface
    public void setBookId(String id) {
        qBookId = id == null ? "" : id;
    }

    /** 网页重置进度 / 重新分章时清掉，免得下次又被旧位置顶回去 */
    @JavascriptInterface
    public void clearLastPos() {
        try { posPrefs().edit().clear().apply(); } catch (Throwable ignore) { }
        posSavedAt = 0;
        posSavedChapter = -1;
        posSavedIndex = -1;
    }

    /** 上一次朗读落盘的位置（网页被冻结/App 被杀后用它找回位置） */
    @JavascriptInterface
    public String lastPos() {
        try {
            android.content.SharedPreferences p = posPrefs();
            long ts = p.getLong("ts", 0);
            if (ts <= 0) return "{}";
            JSONObject o = new JSONObject();
            o.put("book", p.getString("book", ""));
            o.put("chapter", p.getInt("chapter", 0));
            o.put("index", p.getInt("index", 0));
            o.put("total", p.getInt("total", 0));
            o.put("title", p.getString("title", ""));
            o.put("ts", ts);
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    /* 在线音色：微软 Edge TTS（免费、无需 key；纯 Java 实现，不碰 native） */
    private EdgeTtsEngine edge;
    private volatile boolean edgeOn = true;      // 与当前音色联动：选在线音色时为 true
    private volatile String edgeErr = "";
    private static final String EDGE_VOICE = "zh-CN-XiaoxiaoNeural";

    /* 第二在线引擎：百度翻译语音接口（免费、无需 key） */
    private BaiduTtsEngine baidu;

    /* 当前音色 id，格式 engine:voice，例如 edge:zh-CN-XiaoxiaoNeural / baidu:zh / system */
    private static final String DEFAULT_VOICE_ID = "edge:zh-CN-XiaoxiaoNeural";
    private volatile String voiceId = DEFAULT_VOICE_ID;

    /** 音色表：id、显示名、说明、分组（online / system） */
    private static final String[][] VOICE_TABLE = {
            {"edge:zh-CN-XiaoxiaoNeural", "晓晓", "温柔女声 · 推荐", "online"},
            {"edge:zh-CN-XiaoyiNeural", "晓伊", "甜美少女音", "online"},
            {"edge:zh-CN-YunxiNeural", "云希", "青年男声 · 自然", "online"},
            {"edge:zh-CN-YunjianNeural", "云健", "浑厚男声 · 解说风", "online"},
            {"edge:zh-CN-YunyangNeural", "云扬", "新闻播报 · 沉稳", "online"},
            {"edge:zh-CN-YunxiaNeural", "云夏", "少年音 · 轻快", "online"},
            {"edge:zh-CN-liaoning-XiaobeiNeural", "晓北", "东北女声 · 幽默", "online"},
            {"edge:zh-CN-shaanxi-XiaoniNeural", "晓妮", "陕西女声 · 接地气", "online"},
            {"edge:zh-TW-HsiaoChenNeural", "晓臻", "台湾腔女声", "online"},
            {"edge:zh-HK-HiuMaanNeural", "晓曼", "粤语女声", "online"},
            {"baidu:zh", "百度女声", "备用在线引擎 · 稳定", "online"},
    };

    /* 离线语音包下载（模型不打进 APK） */
    private final ModelDownloader downloader = new ModelDownloader();
    private volatile int modelProgress = -1;     // -1 未在下载；0~100 进度
    private volatile String modelMsg = "";
    private volatile boolean modelInstalled = false;

    /* ---------------- 原生朗读队列（锁屏 / 后台续播的核心） ----------------
     * v1.18：朗读不再由网页逐句驱动。JS 一次性把整章句子交给原生，
     * 原生自己合成 → 播放 → 推进下一句，网页即使被系统冻结也不影响播放。
     * 网页只在前台时接收进度回调用于高亮。 */
    private static volatile NativeTTS INSTANCE;
    private final List<String> queue = new ArrayList<>();

    /** 已排队待播的后续章节（原生自主跨章用） */
    private static class Seg {
        final String title;
        final List<String> s;
        Seg(String t, List<String> s) { this.title = t == null ? "" : t; this.s = s; }
    }
    private final List<Seg> qPending = new ArrayList<>();
    private volatile int qChapter = 0;           // 当前章节的全局序号（与书籍目录一致）
    private volatile int qNeedWait = 0;          // 等待网页补章节的重试次数

    private volatile int qIndex = 0;
    private volatile boolean qPlaying = false;
    private volatile boolean qPaused = false;
    private volatile String qTitle = "";
    private volatile String qBook = "";
    private long qTimerEndAt = 0;                // 定时关闭时间点（0 = 不定时）
    private final Runnable qTimerTick = new Runnable() {
        @Override public void run() {
            if (!qPlaying) return;
            if (qTimerEndAt > 0 && System.currentTimeMillis() >= qTimerEndAt) {
                stopQueue();
                evalJs("window.__ttsTimerEnd&&window.__ttsTimerEnd()");
                return;
            }
            main.postDelayed(this, 1000);
        }
    };
    private volatile int qErrStreak = 0;
    private volatile int qErrSent = 0;           // 连续失败的「句数」累计（合并单元一次可能丢多句）
    private volatile int qLastNotified = -1;
    private volatile long qLastAdvanceAt = 0;    // 上次真正推进句子/章节的时间

    /**
     * 卡死自恢复：锁屏 / Doze 时联网合成偶发无响应，回调永远不来，队列就僵在当前句。
     * 每 20 秒检查一次，超过 120 秒没有任何推进就重读当前句。
     */
    private final Runnable qWatchdog = new Runnable() {
        @Override public void run() {
            if (!qPlaying) return;
            if (!qPaused && qLastAdvanceAt > 0
                    && System.currentTimeMillis() - qLastAdvanceAt > 120_000L) {
                Log.w(TAG, "watchdog: 队列停滞超过 120s，重读当前句");
                qLastAdvanceAt = System.currentTimeMillis();
                qToken++;
                stopPlaybackInternal();
                playAt(qIndex);
            }
            main.postDelayed(this, 20_000);
        }
    };

    public static NativeTTS instance() {
        return INSTANCE;
    }

    public NativeTTS(Activity activity, WebView webView) {
        INSTANCE = this;
        this.activity = activity;
        this.webView = webView;
        this.appContext = activity.getApplicationContext();
        edge = new EdgeTtsEngine(this.appContext);
        // 网速持续低于音频码率时告知网页层，由前端提示改用离线音色
        edge.setOnSlowNetwork(() -> fire("slownet", ""));
        baidu = new BaiduTtsEngine(this.appContext);
        android.content.SharedPreferences spVoice =
                appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE);
        String savedVoice = spVoice.getString("voice_id", DEFAULT_VOICE_ID);
        voiceId = (savedVoice == null || savedVoice.isEmpty()) ? DEFAULT_VOICE_ID : savedVoice;
        edgeOn = voiceId.startsWith("edge:");

        // 崩溃熔断：被自动停用时跳过内置引擎（系统语音兜底），把原因透给页面
        boolean ttsEnabled = TtsGuard.isEnabled(appContext);
        android.content.SharedPreferences sp =
                appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE);
        if (!ttsEnabled) {
            builtinErr = TtsGuard.getReason(appContext);
            // 上次崩过：离线引擎强制回到关闭态，下次打开绝不自动加载
            sp.edit().putBoolean("builtin_mode", false).apply();
        }
        // 离线 native 引擎已移除（v1.16），这里不再有任何自动加载动作
        modelInstalled = false;
        builtinErr = "";
        publishState();

        // 系统引擎初始化（作为在线音色的兜底）
        initEngine(null);
    }

    /** 页面加载完成 / 回到前台时由 Activity 调用：重推状态，并同步一次朗读队列进度 */
    public void notifyPageReady() {
        main.post(this::publishState);
        if (qPlaying) main.post(() -> notifyProgress(true));
    }

    /** JS 可同步拉取的完整诊断状态（解决一切时序竞争） */
    @JavascriptInterface
    public String getDiag() {
        try {
            JSONObject o = new JSONObject();
            o.put("ver", APP_VER);
            o.put("builtinReady", builtinReady);
            o.put("builtinErr", builtinErr == null ? "" : builtinErr);
            o.put("engine", builtinReady ? "内置离线语音（小燕）" : safeStr(engineName));
            o.put("zh", builtinReady || zhAvailable);
            o.put("voices", builtinReady ? 1 : systemVoiceCount());
            o.put("ready", builtinReady || ready);
            o.put("modelInstalled", ModelStore.isInstalled(appContext));
            o.put("modelProgress", modelProgress);
            o.put("modelMsg", safeStr(modelMsg));
            o.put("modelMB", Math.round(ModelStore.usedBytes(appContext) / 1048576.0));
            o.put("builtinMode", appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE)
                    .getBoolean("builtin_mode", false));
            o.put("edgeOn", edgeOn);
            o.put("edgeErr", edgeErr == null ? "" : edgeErr);
            o.put("voiceId", voiceId == null ? DEFAULT_VOICE_ID : voiceId);
            o.put("voiceName", voiceDisplayName(voiceId == null ? DEFAULT_VOICE_ID : voiceId));
            o.put("fgs", PlaybackService.foregroundOk);
            o.put("fgsErr", safeStr(PlaybackService.lastError));
            o.put("batteryOk", isIgnoringBattery());
            return o.toString();
        } catch (Exception e) {
            return "{\"ver\":\"" + APP_VER + "\",\"builtinReady\":false,\"builtinErr\":\"diag error\",\"engine\":\"\",\"zh\":false,\"voices\":0,\"ready\":false,\"modelInstalled\":false,\"modelProgress\":-1,\"modelMsg\":\"\"}";
        }
    }

    /* ---------------- 锁屏保活：电池优化白名单 ---------------- */

    /** 是否已忽略电池优化（未忽略时，锁屏一段时间后系统可能冻结进程，听起来就是"停一下"） */
    @JavascriptInterface
    public boolean isIgnoringBattery() {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            android.os.PowerManager pm =
                    (android.os.PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(appContext.getPackageName());
        } catch (Throwable t) {
            return true;
        }
    }

    /** 弹系统「忽略电池优化」授权框；个别 ROM 不支持时退到应用详情页 */
    @JavascriptInterface
    public void requestIgnoreBattery() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + appContext.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(i);
                return;
            }
        } catch (Throwable ignore) { }
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + appContext.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Throwable ignore) { }
    }

    /* ---------------- 离线语音包下载 ---------------- */

    /** 触发下载离线语音包（约 78MB），进度通过 window.__onModel 回调网页 */
    @JavascriptInterface
    public void downloadModel() {
        if (modelProgress >= 0) return;              // 已在下载
        if (ModelStore.isInstalled(appContext)) { modelInstalled = true; return; }
        modelProgress = 0;
        modelMsg = "准备下载…";
        pushModel();
        downloader.start(appContext, new ModelDownloader.Listener() {
            @Override public void onProgress(int percent, long bytes, long total) {
                modelProgress = percent < 0 ? 0 : percent;
                if (total > 0) {
                    modelMsg = "下载中 " + (bytes / 1048576) + "/" + (total / 1048576) + " MB";
                } else {
                    modelMsg = "下载中 " + (bytes / 1048576) + " MB";
                }
                pushModel();
            }

            @Override public void onDone(boolean ok, String message) {
                modelMsg = message == null ? "" : message;
                modelProgress = -1;
                if (ok) {
                    modelInstalled = true;
                    modelMsg = "语音包已就绪，可在面板手动开启离线语音";
                    // 注意：这里绝不自动加载引擎——原生加载在部分机型上直接崩溃，
                    // 必须由用户在面板点「开启离线语音」触发（enableBuiltin）
                } else {
                    modelInstalled = ModelStore.isInstalled(appContext);
                }
                publishState();
                pushModel();
            }
        });
    }

    /** 查询离线语音包状态 */
    @JavascriptInterface
    public String modelStatus() {
        try {
            JSONObject o = new JSONObject();
            o.put("installed", ModelStore.isInstalled(appContext));
            o.put("progress", modelProgress);
            o.put("msg", safeStr(modelMsg));
            o.put("ready", builtinReady);
            o.put("mb", Math.round(ModelStore.usedBytes(appContext) / 1048576.0));
            return o.toString();
        } catch (Exception e) {
            return "{\"installed\":false,\"progress\":-1,\"msg\":\"\",\"ready\":false,\"mb\":0}";
        }
    }

    /** 读取崩溃日志尾部（页面上的「复制崩溃日志」按钮用），帮助定位 Java 崩溃 */
    @JavascriptInterface
    public String getCrashLog() {
        try {
            String s = CrashLogger.read(appContext);
            return s == null ? "" : s.replace("\n", "⏎").replace("'", "’");
        } catch (Throwable t) {
            return "";
        }
    }

    /** 删除已下载的语音包（文件损坏/空间不足时用） */
    @JavascriptInterface
    public void resetModel() {        try { builtin.shutdown(); } catch (Throwable ignore) {}
        builtinReady = false;
        builtinErr = "";
        ModelStore.clear(appContext);
        modelInstalled = false;
        modelProgress = -1;
        modelMsg = "";
        TtsGuard.enable(appContext);
        pushModel();
        publishState();
    }

    private void pushModel() {
        main.post(() -> {
            try {
                if (webView == null) return;
                String js = "window.__onModel && window.__onModel(" + modelStatus() + ");";
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignore) {}
        });
    }

    private String safeStr(String s) { return s == null ? "" : s; }

    private int systemVoiceCount() {
        try {
            Set<Voice> vs = tts != null ? tts.getVoices() : null;
            return vs == null ? 0 : vs.size();
        } catch (Exception ignore) { return 0; }
    }

    /* ---------------- 引擎初始化与选择 ---------------- */

    private void initEngine(final String preferEngine) {
        try {
            engineProbing = true;
            ready = false;
            if (preferEngine == null) {
                tts = new TextToSpeech(appContext, this::onInit);
            } else {
                engineName = preferEngine;
                tts = new TextToSpeech(appContext, this::onInit, preferEngine);
            }
        } catch (Exception e) {
            Log.w(TAG, "tts create: " + e.getMessage());
            ready = false;
            publishState();
        }
    }

    private void onInit(int status) {
        engineProbing = false;
        if (status != TextToSpeech.SUCCESS || tts == null) {
            Log.w(TAG, "tts init failed");
            publishState();
            return;
        }
        engineName = safeEngineName(tts);
        zhAvailable = isChineseAvailable(tts);
        if (zhAvailable) {
            applyEngineConfig();
            ready = true;
            publishState();
            return;
        }
        // 默认引擎不支持中文 → 尝试其它引擎
        probeNextEngine(0);
    }

    private void probeNextEngine(final int index) {
        try {
            List<TextToSpeech.EngineInfo> engines = tts.getEngines();
            if (engines == null || index >= engines.size()) {
                // 没有可用中文引擎：保留默认引擎（部分引擎 isLanguageAvailable 不可靠，仍尝试朗读）
                applyEngineConfig();
                ready = true;
                publishState();
                return;
            }
            final TextToSpeech.EngineInfo ei = engines.get(index);
            if (ei.name == null || ei.name.equals(engineName)) {
                probeNextEngine(index + 1);
                return;
            }
            final TextToSpeech[] holder = new TextToSpeech[1];
            holder[0] = new TextToSpeech(appContext, status -> {
                TextToSpeech probe = holder[0];
                boolean ok = status == TextToSpeech.SUCCESS && probe != null && isChineseAvailable(probe);
                try { if (probe != null) probe.shutdown(); } catch (Exception ignore) {}
                if (ok) {
                    Log.i(TAG, "switch to engine: " + ei.name);
                    try { tts.shutdown(); } catch (Exception ignore) {}
                    initEngine(ei.name);   // 用该引擎重建主实例（onInit 中会置 ready）
                } else {
                    probeNextEngine(index + 1);
                }
            }, ei.name);
            if (holder[0] == null) probeNextEngine(index + 1);
        } catch (Exception e) {
            Log.w(TAG, "probe: " + e.getMessage());
            applyEngineConfig();
            ready = true;
            publishState();
        }
    }

    private void applyEngineConfig() {
        try {
            int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(Locale.getDefault());
            }
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            tts.setOnUtteranceProgressListener(progressListener);
        } catch (Exception e) {
            Log.w(TAG, "applyEngineConfig: " + e.getMessage());
        }
    }

    private boolean isChineseAvailable(TextToSpeech t) {
        try {
            int r = t.isLanguageAvailable(Locale.SIMPLIFIED_CHINESE);
            if (r < TextToSpeech.LANG_AVAILABLE) r = t.isLanguageAvailable(new Locale("zh", "CN"));
            if (r < TextToSpeech.LANG_AVAILABLE) r = t.isLanguageAvailable(Locale.CHINESE);
            if (r < TextToSpeech.LANG_AVAILABLE) r = t.isLanguageAvailable(new Locale("zh"));
            if (r >= TextToSpeech.LANG_AVAILABLE) return true;
            // 引擎申报的默认语言可能不是中文（如 VoxEngine 默认英文声音），
            // 但音色列表里可能有中文音色——扫描一遍，有就算可用
            try {
                java.util.Set<android.speech.tts.Voice> voices = t.getVoices();
                if (voices != null) {
                    for (android.speech.tts.Voice v : voices) {
                        Locale loc = v.getLocale();
                        if (loc != null && loc.getLanguage() != null
                                && loc.getLanguage().toLowerCase().startsWith("zh")) {
                            return true;
                        }
                    }
                }
            } catch (Exception ignore) {}
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private String safeEngineName(TextToSpeech t) {
        try { return String.valueOf(t.getDefaultEngine()); } catch (Exception e) { return ""; }
    }

    /** 把引擎状态推给网页：window.__ttsState(engine, zhAvailable, voiceCount, ready) */
    private void publishState() {
        final String eng;
        final boolean zh;
        final int cnt;
        final boolean rdy;
        if (builtinReady) {
            eng = "内置离线语音（小燕）"; zh = true; cnt = 1; rdy = true;
        } else {
            int n = 0;
            try {
                Set<Voice> vs = tts != null ? tts.getVoices() : null;
                n = vs == null ? 0 : vs.size();
            } catch (Exception ignore) {}
            eng = engineName == null ? "" : engineName;
            zh = zhAvailable || edgeOn;
            cnt = edgeOn ? Math.max(1, n) : n;
            rdy = ready || edgeOn;
        }
        main.post(() -> {
            if (webView == null) return;
            webView.evaluateJavascript(
                    "window.__ttsState&&window.__ttsState(" +
                            "'" + esc(eng) + "'," + zh + "," + cnt + "," + rdy + ")", null);
        });
    }

    /** 安全执行一段 JS（页面可能已销毁 / 在后台） */
    private void evalJs(final String js) {
        main.post(() -> {
            if (webView == null) return;
            try { webView.evaluateJavascript(js, null); } catch (Throwable ignore) { }
        });
    }

    private String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("'", "\\'")
                .replace("\n", " ").replace("\r", " ").replace("\t", " ");
    }

    /** 试听结果回调 JS：window.__ttsTest(ok) */
    private void fireTest(final boolean ok) {
        main.post(() -> {
            if (webView == null) return;
            webView.evaluateJavascript("window.__ttsTest&&window.__ttsTest(" + ok + ")", null);
        });
    }

    /** 音色目录 JSON：[{id,name,desc,group}]，供网页侧渲染音色面板（与系统音色 getVoices 区分） */
    @JavascriptInterface
    public String getVoiceList() {
        try {
            JSONArray arr = new JSONArray();
            for (String[] v : VOICE_TABLE) {
                JSONObject o = new JSONObject();
                o.put("id", v[0]);
                o.put("name", v[1]);
                o.put("desc", v[2]);
                o.put("group", v[3]);
                arr.put(o);
            }
            // 系统语音：仅当真的装了中文引擎时才列出，避免点了没声音
            if (zhAvailable && tts != null) {
                JSONObject o = new JSONObject();
                o.put("id", "system");
                o.put("name", "系统语音");
                o.put("desc", safeStr(engineName).isEmpty() ? "手机自带引擎" : safeStr(engineName));
                o.put("group", "system");
                arr.put(o);
            }
            return arr.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public String getVoiceId() {
        return voiceId == null ? DEFAULT_VOICE_ID : voiceId;
    }

    /** 切换音色；id 形如 edge:zh-CN-XiaoxiaoNeural / baidu:zh / system */
    @JavascriptInterface
    public void setVoiceId(final String id) {
        try {
            if (id == null || id.isEmpty()) return;
            voiceId = id;
            edgeOn = id.startsWith("edge:");
            edgeErr = "";
            appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE)
                    .edit().putString("voice_id", id).apply();
            try { if (edge != null) edge.stop(); } catch (Throwable ignore) {}
            try { if (edge != null) edge.clearPrefetch(); } catch (Throwable ignore) {}   // 旧音色预取作废
            try { if (baidu != null) baidu.stop(); } catch (Throwable ignore) {}
            try { if (baidu != null) baidu.clearPrefetch(); } catch (Throwable ignore) {}
            Log.i(TAG, "voice -> " + id);
            publishState();
        } catch (Throwable t) {
            Log.w(TAG, "setVoiceId: " + t);
        }
    }

    private static String voiceShortName(String vid) {
        int i = vid.indexOf(':');
        return i >= 0 ? vid.substring(i + 1) : "zh-CN-XiaoxiaoNeural";
    }

    private static String voiceDisplayName(String vid) {
        for (String[] v : VOICE_TABLE) if (v[0].equals(vid)) return v[1];
        if ("system".equals(vid)) return "系统语音";
        return "晓晓";
    }

    /** 试读一句，验证当前引擎是否真的能出声 */
    @JavascriptInterface
    public void testSpeak() {
        final String vid = voiceId == null ? DEFAULT_VOICE_ID : voiceId;
        // 正在朗读整章时不要另起试听，否则会出现两路声音重叠：
        // 直接用新音色重读当前这一句即可，效果一样且不会叠音
        if (qPlaying) {
            main.post(() -> {
                qToken++;
                stopPlaybackInternal();
                playAt(qIndex);
            });
            fireTest(true);
            return;
        }
        final String sample = "你好，这里是轻阅的语音试听，正在用「" + voiceDisplayName(vid) + "」为你朗读小说。";
        if (vid.startsWith("baidu:")) {
            baidu.speak(sample, rate, ok -> {
                if (!ok) edgeErr = baidu.getLastError();
                fireTest(ok);
                publishState();
            });
            return;
        }
        if (vid.startsWith("edge:")) {
            edge.speak(sample, voiceShortName(vid), rate, ok -> {
                if (ok) { fireTest(true); publishState(); return; }
                edgeErr = edge.getLastError();
                // Edge 不通时用百度兜底试听，让用户立刻知道是引擎问题还是网络问题
                baidu.speak(sample, rate, ok2 -> {
                    if (!ok2) edgeErr = edgeErr + " / " + baidu.getLastError();
                    fireTest(ok2);
                    publishState();
                });
            });
            return;
        }
        main.post(() -> {
            if (tts == null || !ready) { fireTest(false); return; }
            try {
                tts.setSpeechRate(rate);
                tts.setPitch(pitch);
                Bundle params = new Bundle();
                params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, "test");
                int r = tts.speak(sample, TextToSpeech.QUEUE_FLUSH, params, "test");
                if (r != TextToSpeech.SUCCESS) fireTest(false);
            } catch (Exception e) {
                fireTest(false);
            }
        });
    }

    /** 开启/关闭在线音色（Edge TTS 晓晓） */
    @JavascriptInterface
    public void setEdge(boolean on) {
        setVoiceId(on ? DEFAULT_VOICE_ID : "system");
    }

    /** 列出已安装的 TTS 引擎 JSON：[{name,label}]；内置引擎可用时只返回它 */
    @JavascriptInterface
    public String getEngines() {
        try {
            JSONArray arr = new JSONArray();
            if (builtinReady) {
                JSONObject o = new JSONObject();
                o.put("name", "builtin");
                o.put("label", "内置离线语音（小燕）");
                arr.put(o);
                return arr.toString();
            }
            if (tts != null) {
                List<TextToSpeech.EngineInfo> list = tts.getEngines();
                if (list != null) {
                    for (TextToSpeech.EngineInfo ei : list) {
                        JSONObject o = new JSONObject();
                        o.put("name", ei.name);
                        o.put("label", ei.label == null || ei.label.isEmpty() ? ei.name : ei.label);
                        arr.put(o);
                    }
                }
            }
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /** 切换到指定引擎（异步重建，完成后推 __ttsState） */
    @JavascriptInterface
    public void useEngine(final String name) {
        if (name == null || name.isEmpty()) return;
        if ("builtin".equals(name)) {
            main.post(this::publishState);   // 内置引擎始终可用，切回它即可
            return;
        }
        main.post(() -> {
            if (name.equals(engineName)) return;
            try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignore) {}
            tts = null;
            initEngine(name);
        });
    }

    /** 弹出系统风格的单选对话框让用户挑引擎 */
    @JavascriptInterface
    public void chooseEngine() {
        main.post(() -> {
            try {
                List<TextToSpeech.EngineInfo> list = tts != null ? tts.getEngines() : null;
                if (list == null || list.isEmpty()) { fireTest(false); return; }
                final String[] names = new String[list.size()];
                final String[] labels = new String[list.size()];
                int cur = 0;
                for (int i = 0; i < list.size(); i++) {
                    names[i] = list.get(i).name;
                    labels[i] = (list.get(i).label == null || list.get(i).label.isEmpty()
                            ? list.get(i).name : list.get(i).label)
                            + (names[i].equals(engineName) ? "（当前）" : "");
                    if (names[i].equals(engineName)) cur = i;
                }
                new android.app.AlertDialog.Builder(activity)
                        .setTitle("选择语音引擎")
                        .setSingleChoiceItems(labels, cur, (d, w) -> {
                            d.dismiss();
                            if (names[w] != null && !names[w].equals(engineName)) {
                                useEngine(names[w]);
                            }
                        })
                        .setNegativeButton("取消", null)
                        .show();
            } catch (Exception e) {
                Log.w(TAG, "chooseEngine: " + e.getMessage());
            }
        });
    }

    /* ---------------- 朗读事件 ---------------- */

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override public void onStart(String utteranceId) {
            if (utteranceId != null && utteranceId.startsWith("q")) return;   // 队列句不推给网页
            if ("test".equals(utteranceId)) return;
            fire("start", utteranceId);
        }
        @Override public void onDone(String utteranceId) {
            if (utteranceId != null && utteranceId.startsWith("q")) {
                Once cb = sysOnceCb;
                sysOnceCb = null;
                if (cb != null) cb.onResult(true);
                return;
            }
            if ("test".equals(utteranceId)) { fireTest(true); return; }
            fire("done", utteranceId);
        }
        @Override public void onError(String utteranceId) {
            if (utteranceId != null && utteranceId.startsWith("q")) {
                Once cb = sysOnceCb;
                sysOnceCb = null;
                if (cb != null) cb.onResult(false);
                return;
            }
            if ("test".equals(utteranceId)) { fireTest(false); return; }
            fire("error", utteranceId);
        }
    };

    private void fire(String type, String id) {
        main.post(() -> {
            if (webView == null) return;
            webView.evaluateJavascript("window.__ttsEvent&&window.__ttsEvent('" + type + "','" + id + "')", null);
        });
    }

    /* ================= 原生朗读队列（后台 / 锁屏续播） ================= */

    /** 播放一句的统一入口：按当前音色 Edge → 百度 → 系统 依次降级，回调只表示「这句念完了」 */
    private interface Once {
        void onResult(boolean ok);
        /** 真正出声时回调，durMs 为这段音频时长（0 = 未知，由上层估算） */
        default void onStart(long durMs) { }
    }

    private void playOnce(final String text, final String nextText, final Once cb, final int token) {
        final String vid = voiceId == null ? DEFAULT_VOICE_ID : voiceId;
        final String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) { cb.onResult(true); return; }

        if (vid.startsWith("baidu:")) {
            // v1.35：百度音色也带上下一段接棒，此前这里是纯单段调用，段间必然空档
            baidu.speak(clean, nextText, rate, new BaiduTtsEngine.Callback() {
                @Override public void onStart(long durMs) { cb.onStart(durMs); }

                @Override public void onResult(boolean ok) {
                    if (ok) { cb.onResult(true); return; }
                    edgeErr = baidu.getLastError();
                    main.post(() -> systemSpeakOnce(clean, cb, token));
                }
            });
            return;
        }
        if (vid.startsWith("edge:")) {
            // 带上下一句：当前句还在念的时候，原生层就把下一句 prepare 好接棒
            edge.speak(clean, nextText, voiceShortName(vid), rate, new EdgeTtsEngine.Callback() {
                @Override public void onStart(long durMs) { cb.onStart(durMs); }

                @Override public void onResult(boolean ok) {
                    if (ok) { cb.onResult(true); return; }
                    edgeErr = edge.getLastError();
                    Log.w(TAG, "queue edge failed: " + edgeErr + ", try baidu");
                    baidu.speak(clean, rate, ok2 -> {
                        if (ok2) { cb.onResult(true); return; }
                        edgeErr = edgeErr + " / " + baidu.getLastError();
                        main.post(() -> systemSpeakOnce(clean, cb, token));
                    });
                }
            });
            return;
        }
        main.post(() -> systemSpeakOnce(clean, cb, token));
    }

    /* 系统 TTS 只支持「一个 utterance 一个回调」，用序号区分队列句 */
    private volatile Once sysOnceCb;
    private volatile int sysOnceToken = -1;

    private void systemSpeakOnce(final String text, final Once cb, final int token) {
        if (tts == null || !ready) { cb.onResult(false); return; }
        try {
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            applyVoice();
            sysOnceCb = cb;
            sysOnceToken = token;
            String uid = "q" + token;
            Bundle params = new Bundle();
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, uid);
            int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uid);
            if (res != TextToSpeech.SUCCESS) { sysOnceCb = null; cb.onResult(false); }
        } catch (Exception e) {
            sysOnceCb = null;
            cb.onResult(false);
        }
    }

    /** 开始原生队列朗读。sentencesJson 为整章句子数组（单章模式，保留兼容） */
    @JavascriptInterface
    public void startQueue(final String sentencesJson, final int startIndex,
                           final String chapterTitle, final String bookTitle, final int timerMin) {
        main.post(() -> {
            List<String> list = new ArrayList<>();
            try {
                JSONArray arr = new JSONArray(sentencesJson == null ? "[]" : sentencesJson);
                for (int i = 0; i < arr.length(); i++) {
                    String s = arr.optString(i, "");
                    list.add(s == null ? "" : s);
                }
            } catch (Throwable t) {
                Log.w(TAG, "startQueue parse: " + t);
            }
            if (list.isEmpty()) { evalJs("window.__ttsQueueError&&window.__ttsQueueError('本章没有可朗读的内容')"); return; }
            List<Seg> one = new ArrayList<>();
            one.add(new Seg(chapterTitle, list));
            startSegs(one, startIndex, bookTitle, 0, timerMin);
        });
    }

    /**
     * 多章朗读：json 形如 [{"t":"第一章","s":["句1","句2"]}, ...]，第 0 段为起始章。
     * 原生按段推进，一段念完自动进入下一段；段全部念完才回网页要新章节。
     * 这样锁屏/后台（网页被冻结）也能连续跨章。
     */
    @JavascriptInterface
    public void startChapters(final String json, final int startIndex, final String bookTitle,
                              final int baseChapter, final int timerMin) {
        main.post(() -> {
            List<Seg> segs = parseSegs(json);
            if (segs.isEmpty() || segs.get(0).s.isEmpty()) {
                evalJs("window.__ttsQueueError&&window.__ttsQueueError('本章没有可朗读的内容')");
                return;
            }
            startSegs(segs, startIndex, bookTitle, baseChapter, timerMin);
        });
    }

    /** 网页补充后续章节（前台时提前/prefetch 或原生索要时调用） */
    @JavascriptInterface
    public void appendChapters(final String json) {
        main.post(() -> {
            List<Seg> segs = parseSegs(json);
            if (segs.isEmpty()) return;
            qPending.addAll(segs);
            qNeedWait = 0;
            Log.i(TAG, "appendChapters +" + segs.size() + ", pending=" + qPending.size());
            if (qPlaying && !qPaused && qIndex + 1 >= queue.size()) {
                main.removeCallbacks(qMoreWait);   // 正在等章节，立刻续上
                advanceChapter();
            }
        });
    }

    private List<Seg> parseSegs(String json) {
        List<Seg> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(json == null ? "[]" : json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                JSONArray ss = o.optJSONArray("s");
                List<String> list = new ArrayList<>();
                if (ss != null) {
                    for (int j = 0; j < ss.length(); j++) {
                        String s = ss.optString(j, "");
                        list.add(s == null ? "" : s);
                    }
                }
                if (!list.isEmpty()) out.add(new Seg(o.optString("t", ""), list));
            }
        } catch (Throwable t) {
            Log.w(TAG, "parseSegs: " + t);
        }
        return out;
    }

    private void startSegs(List<Seg> segs, int startIndex, String bookTitle, int baseChapter, int timerMin) {
        stopPlaybackInternal();          // 先静音旧的（不重置队列状态）
        qPending.clear();
        if (segs.size() > 1) qPending.addAll(segs.subList(1, segs.size()));
        queue.clear();
        queue.addAll(segs.get(0).s);
        qTitle = segs.get(0).title;
        qChapter = Math.max(0, baseChapter);
        qBook = bookTitle == null ? "" : bookTitle;
        qIndex = Math.max(0, Math.min(startIndex, queue.size() - 1));
        qPlaying = true;
        qPaused = false;
        saveQueuePos(true);
        qErrStreak = 0;
        qLastNotified = -1;
        qNeedWait = 0;
        qTimerEndAt = timerMin > 0 ? System.currentTimeMillis() + timerMin * 60000L : 0;

        PlaybackService.start(appContext);
        main.removeCallbacks(qTimerTick);
        if (qTimerEndAt > 0) main.postDelayed(qTimerTick, 1000);
        qLastAdvanceAt = System.currentTimeMillis();
        main.removeCallbacks(qWatchdog);
        main.postDelayed(qWatchdog, 20_000);

        edge.clearPrefetch();            // 新的朗读会话，旧预取一律作废
        try { if (baidu != null) baidu.clearPrefetch(); } catch (Throwable ignore) {}

        Log.i(TAG, "queue start: ch" + qChapter + " " + queue.size() + " 句, from " + qIndex
                + ", 预排 " + qPending.size() + " 章");
        notifyProgress(true);
        playAt(qIndex);
    }

    /** 当前章念完：有预排章节就切过去，没有就回网页索要 */
    private void advanceChapter() {
        if (!qPlaying || qPaused) return;
        if (qPending.isEmpty()) {
            qNeedWait++;
            if (qNeedWait > 2 || qChapter + 1 >= 9999) { finishQueue(); return; }
            final int from = qChapter + 1;
            evalJs("window.__ttsNeedChapters&&window.__ttsNeedChapters(" + from + ",8)");
            main.removeCallbacks(qMoreWait);
            main.postDelayed(qMoreWait, 1500);
            return;
        }
        Seg seg = qPending.remove(0);
        queue.clear();
        queue.addAll(seg.s);
        qTitle = seg.title;
        qChapter++;
        qIndex = 0;
        qErrStreak = 0;
        qLastNotified = -1;
        saveQueuePos(true);           // 跨章立刻落盘：这一步最容易丢进度
        Log.i(TAG, "-> ch" + qChapter + " " + qTitle + " (" + queue.size() + " 句)");
        notifyProgress(true);
        playAt(0);
    }

    private final Runnable qMoreWait = new Runnable() {
        @Override public void run() {
            if (!qPlaying || qPaused) return;
            if (!qPending.isEmpty()) { advanceChapter(); return; }
            finishQueue();          // 网页在后台补不上新章节，视为读完
        }
    };

    /* ---------------- 短句合并（v1.30） ----------------
     * 每句单独合成时，换句都要重走「建连/取缓存 → 建播放器 → 起播」，
     * 遇到对话体那种七八个字的短句，一句一两秒就要换一次，顿挫非常明显。
     * 这里把相邻短句凑成一个「朗读单元」一次合成播放，句间只剩音频自身的停顿。
     * 队列结构不变（仍按句索引），单元内高亮按字数比例随时间轴推进。 */
    private static final int UNIT_TARGET = 34;        // 目标字数：凑到这么多就停
    private static final int UNIT_MAX_SENT = 5;       // 一个单元最多几句
    private static final int UNIT_MAX_CHARS = 120;    // 单次合成上限，避免长段合成过慢
    private static final int PREFETCH_DEPTH = 4;      // 提前合成的单元数（v1.35 由 3 提到 4）

    /** 短句合并开关（关闭即退回一句一合成，v1.29 行为） */
    private volatile boolean joinShort = true;

    private static String sOf(List<String> list, int i) {
        if (i < 0 || i >= list.size()) return "";
        String s = list.get(i);
        return s == null ? "" : s.trim();
    }

    /** 从 i 起的一个朗读单元结束位置（exclusive）。joinShort 关闭时恒为 i+1 */
    private int unitEndIn(List<String> list, int i) {
        final int size = list.size();
        if (i >= size) return i;
        if (!joinShort) return i + 1;
        int end = i, chars = 0;
        while (end < size && end - i < UNIT_MAX_SENT) {
            int l = sOf(list, end).length();
            if (l == 0) { if (end == i) end++; break; }   // 空句自己占一个单元，交给 playAt 跳过
            if (end > i && chars + l > UNIT_TARGET + 16) break;
            if (end > i && chars + l > UNIT_MAX_CHARS) break;
            chars += l;
            end++;
            if (chars >= UNIT_TARGET) break;
        }
        return end <= i ? i + 1 : end;
    }

    private int unitEnd(int i) { return unitEndIn(queue, i); }

    /** 把 [from,to) 拼成一段合成文本；句子自带标点就直接接，缺了就补个逗号 */
    private static String unitTextIn(List<String> list, int from, int to) {
        StringBuilder sb = new StringBuilder();
        for (int k = from; k < to; k++) {
            String s = sOf(list, k);
            if (s.isEmpty()) continue;
            if (sb.length() > 0 && !endsWithPunct(sb)) sb.append('，');
            sb.append(s);
        }
        return sb.toString();
    }

    private static boolean endsWithPunct(CharSequence s) {
        if (s.length() == 0) return false;
        char c = s.charAt(s.length() - 1);
        return c == '。' || c == '！' || c == '？' || c == '…' || c == '，' || c == '；'
                || c == '：' || c == '”' || c == '」' || c == '』' || c == '.' || c == '!'
                || c == '?' || c == ',' || c == ';' || c == ':';
    }

    /** 估算一段文本的朗读时长（毫秒）：中文约 4.6 字/秒，随语速缩放 */
    private long estimateMs(String text, int chars) {
        float r = rate <= 0 ? 1f : rate;
        double cps = 4.6 * r;
        if (cps <= 0.1) cps = 0.1;
        int n = chars > 0 ? chars : (text == null ? 0 : text.length());
        return Math.max(600, (long) (n / cps * 1000));
    }

    /**
     * 单元内高亮推进：按每句字数比例把 qIndex 从 from 推到 to-1。
     * 只影响高亮与进度上报，单元播完一定会跳到 to（见 playAt 的 onResult）。
     */
    private void pushUnitHighlight(final int from, final int to, final long durMs, final int token) {
        if (to - from <= 1 || durMs <= 0) return;
        int total = 0;
        final int n = to - from;
        final int[] cum = new int[n];
        for (int k = from; k < to; k++) {
            cum[k - from] = total;
            total += Math.max(1, sOf(queue, k).length());
        }
        if (total <= 0) return;
        for (int k = from + 1; k < to; k++) {
            final int idx = k;
            long at = (long) (durMs * (cum[k - from] / (double) total));
            main.postDelayed(() -> {
                if (token != qToken) return;        // 已切句/暂停/停止
                if (!qPlaying || qPaused) return;
                if (qIndex >= idx) return;
                qIndex = idx;
                notifyProgress(true);
                saveQueuePos(false);
            }, Math.max(0, at));
        }
    }

    private void playAt(final int i) {
        if (!qPlaying || qPaused) return;
        if (i >= queue.size()) { advanceChapter(); return; }

        final int token = ++qToken;
        final int end = Math.min(unitEnd(i), queue.size());      // 本朗读单元的结束（exclusive）
        final String text = unitTextIn(queue, i, end);
        // 下一个单元也一并交给原生层提前 prepare，播完直接接棒（跨章不接，跨章要整段换队列）
        final int nextEnd = end < queue.size() ? Math.min(unitEnd(end), queue.size()) : end;
        final String nextText = nextEnd > end ? unitTextIn(queue, end, nextEnd) : null;
        qIndex = i;
        saveQueuePos(false);          // 后台/被杀也留个位置（有节流，不会频繁写盘）

        if (text.isEmpty()) {
            notifyProgress(true);
            main.postDelayed(() -> { if (token == qToken) playAt(Math.max(end, i + 1)); }, 10);
            return;
        }

        // 单元内高亮：优先用真实音频时长（起播回调给），拿不到就用字数估算
        final int chars = text.length();
        final long[] durBox = { 0 };
        final boolean[] pushed = { false };
        final Runnable push = () -> {
            if (pushed[0] || token != qToken) return;
            pushed[0] = true;
            pushUnitHighlight(i, end, durBox[0] > 0 ? durBox[0] : estimateMs(null, chars), token);
        };
        main.postDelayed(push, 400);

        playOnce(text, nextText, new Once() {
            @Override public void onStart(long durMs) {
                if (token != qToken) return;
                if (durMs > 0) durBox[0] = durMs;
                push.run();
            }

            @Override public void onResult(boolean ok) {
                if (token != qToken) return;             // 已被手动切句/停止
                if (!qPlaying || qPaused) return;
                if (ok) {
                    qErrStreak = 0;
                    qErrSent = 0;
                    if (end - 1 > qIndex) qIndex = end - 1;   // 整个单元念完，进度落到末句
                    // 上一段快念完了，下一段（多半已准备就绪）几乎可以立刻接上，不留空窗
                    main.post(() -> { if (token == qToken) playAt(end); });
                } else {
                    // 三个引擎（Edge → 百度 → 系统）都失败才会走到这里。
                    // 只跳过一句而不是整个单元：合并单元最多 5 句，跳整段会一口气丢一大段内容，
                    // 下一轮 playAt 会自动把剩下的重新合并，损失最小。
                    qErrStreak++;
                    qErrSent += Math.max(1, end - i);
                    if (qErrSent >= 10) {
                        stopQueue();
                        evalJs("window.__ttsQueueError&&window.__ttsQueueError('语音朗读连续失败：" + esc(safeStr(edgeErr)) + "')");
                        return;
                    }
                    final int next = Math.min(i + 1, queue.size());
                    main.postDelayed(() -> { if (token == qToken) playAt(next); }, 80);
                }
            }
        }, token);

        // 出声之后再更新高亮/进度：把主线程让给音频启动，少几十毫秒也是几十毫秒
        main.post(() -> { if (token == qToken) notifyProgress(true); });

        // 当前单元已经在念了，趁这段时间把后面几个单元合成好（命中缓存的直接复用）
        prefetchAhead(i);
    }

    /**
     * 预取后面几个朗读单元。逐段在线合成时，每段都要「建连接 → 合成 → 落盘」，
     * 一段念完到下一段出声之间会空几百毫秒，听感就是明显停顿。
     * 提前合成好后，下一段直接命中缓存开播，段间几乎无缝。
     * 注意：这里必须用和 playAt 完全相同的合并规则，否则永远命不中缓存。
     *
     * v1.35：接入百度音色。原来只有 edge: 才预取，用百度音色的人等于完全没有预取，
     * 每段都要现下载，弱网下停顿 1~3 秒——这是「换个音色就好了」的真正原因。
     */
    private void prefetchAhead(final int i) {
        final String vid = voiceId == null ? DEFAULT_VOICE_ID : voiceId;
        final boolean isEdge = vid.startsWith("edge:");
        final boolean isBaidu = vid.startsWith("baidu:");
        if (!isEdge && !isBaidu) return;             // 系统语音本地合成，无需预取
        final String v = voiceShortName(vid);
        // 一个单元通常 20~40 字（约 5~9 秒），预取 4 个就是半分钟上下，够扛住网络抖动
        int k = unitEnd(i);
        int n = 0;
        while (n < PREFETCH_DEPTH && k < queue.size()) {
            int e = Math.min(unitEnd(k), queue.size());
            prefetchUnit(unitTextIn(queue, k, e), v, isEdge);
            k = e;
            n++;
        }
        // 跨到下一章的前几个单元，章末切换时就不会再等合成
        if (n < PREFETCH_DEPTH && !qPending.isEmpty()) {
            List<String> nx = qPending.get(0).s;
            int j = Math.max(0, k - queue.size());
            int m = 0;
            while (m < PREFETCH_DEPTH - n && j < nx.size()) {
                int e = Math.min(unitEndIn(nx, j), nx.size());
                prefetchUnit(unitTextIn(nx, j, e), v, isEdge);
                j = e;
                m++;
            }
        }
    }

    /** 按当前音色投递到对应引擎的预取通道 */
    private void prefetchUnit(String text, String voiceShort, boolean isEdge) {
        if (text == null || text.isEmpty()) return;
        try {
            if (isEdge) edge.prefetch(text, voiceShort, rate);
            else baidu.prefetch(text, rate);
        } catch (Throwable ignore) { }
    }

    private volatile int qToken = 0;

    private void finishQueue() {
        qPlaying = false;
        qPaused = false;
        qPending.clear();
        main.removeCallbacks(qMoreWait);
        main.removeCallbacks(qWatchdog);
        main.removeCallbacks(qTimerTick);
        qTimerEndAt = 0;
        PlaybackService.stop(appContext);
        notifyProgress(true);
        evalJs("window.__ttsQueueEnd&&window.__ttsQueueEnd()");
    }

    /** 通知栏 + 网页高亮同步 */
    private void notifyProgress(final boolean force) {
        final int idx = qIndex;
        final int total = queue.size();
        if (!force && idx == qLastNotified) return;
        qLastNotified = idx;
        qLastAdvanceAt = System.currentTimeMillis();
        final boolean playing = qPlaying && !qPaused;
        if (qPlaying) {
            try {
                String head = qBook.isEmpty() ? (qTitle.isEmpty() ? "轻阅" : qTitle)
                        : (qTitle.isEmpty() ? qBook : qBook + " · " + qTitle);
                String line = playing
                        ? "正在朗读 " + (idx + 1) + "/" + total
                        : "已暂停 " + (idx + 1) + "/" + total;
                PlaybackService.update(appContext, head, line, playing);
            } catch (Throwable ignore) { }
        }
        main.post(() -> {
            if (webView == null) return;
            try {
                webView.evaluateJavascript("window.__ttsQueueProgress&&window.__ttsQueueProgress("
                        + idx + "," + total + "," + playing + "," + qChapter + ",'" + esc(qTitle) + "')", null);
            } catch (Throwable ignore) { }
        });
    }

    @JavascriptInterface
    public void pauseQueue() {
        main.post(() -> {
            if (!qPlaying || qPaused) return;
            qPaused = true;
            qToken++;
            stopPlaybackInternal();
            notifyProgress(true);
        });
    }

    /**
     * 耳机拔出 / 蓝牙断开时由 PlaybackService 的广播接收器调用：暂停并通知页面。
     *
     * 与 pauseQueue 的区别只有两点：多回调一次 __ttsNoisyPause（让页面弹出原因提示），
     * 且可以在任意线程调用（内部自己 post 到主线程）。
     */
    public void pauseForNoisy() {
        main.post(() -> {
            if (!qPlaying || qPaused) return;
            qPaused = true;
            qToken++;                       // 让在途的合成 / 播放回调全部作废
            stopPlaybackInternal();
            saveQueuePos(true);             // 立刻落盘，避免暂停位置丢失
            notifyProgress(true);           // 通知栏 + 网页状态一起切成「已暂停」
            evalJs("window.__ttsNoisyPause&&window.__ttsNoisyPause()");
        });
    }

    @JavascriptInterface
    public void resumeQueue() {
        main.post(() -> {
            if (!qPlaying) return;
            qPaused = false;
            notifyProgress(true);
            playAt(qIndex);
        });
    }

    @JavascriptInterface
    public void stopQueue() {
        stopQueueFromService();
        main.post(() -> {
            try { PlaybackService.stop(appContext); } catch (Throwable ignore) { }
        });
    }

    /** 只停播放、不回调服务（供 PlaybackService 的通知栏「停止」调用，避免循环） */
    public void stopQueueFromService() {
        main.post(() -> {
            if (!qPlaying && queue.isEmpty()) return;
            qPlaying = false;
            qPaused = false;
            qToken++;
            qErrStreak = 0;
            qTimerEndAt = 0;
            qPending.clear();
            qNeedWait = 0;
            main.removeCallbacks(qMoreWait);
            main.removeCallbacks(qWatchdog);
            main.removeCallbacks(qTimerTick);
            stopPlaybackInternal();
            edge.clearPrefetch();          // 停止朗读后预取内容作废
            try { if (baidu != null) baidu.clearPrefetch(); } catch (Throwable ignore) {}
            notifyProgress(true);
            evalJs("window.__ttsQueueStopped&&window.__ttsQueueStopped()");
        });
    }

    @JavascriptInterface
    public void queueNext() {
        main.post(() -> {
            if (!qPlaying) return;
            qToken++;
            stopPlaybackInternal();
            int n = Math.min(qIndex + 1, Math.max(0, queue.size() - 1));
            qIndex = n;
            notifyProgress(true);
            main.postDelayed(() -> playAt(n), 40);
        });
    }

    @JavascriptInterface
    public void queuePrev() {
        main.post(() -> {
            if (!qPlaying) return;
            qToken++;
            stopPlaybackInternal();
            int n = Math.max(qIndex - 1, 0);
            qIndex = n;
            notifyProgress(true);
            main.postDelayed(() -> playAt(n), 40);
        });
    }

    @JavascriptInterface
    public void queueSeek(int i) {
        main.post(() -> {
            if (!qPlaying || queue.isEmpty()) return;
            qToken++;
            stopPlaybackInternal();
            qIndex = Math.max(0, Math.min(i, queue.size() - 1));
            notifyProgress(true);
            main.postDelayed(() -> playAt(qIndex), 40);
        });
    }

    /** 播放中修改语速/音色后重读当前句 */
    @JavascriptInterface
    public void queueRestartCurrent() {
        main.post(() -> {
            if (!qPlaying) return;
            qToken++;
            stopPlaybackInternal();
            playAt(qIndex);
        });
    }

    @JavascriptInterface
    public void setQueueTimer(final int min) {
        main.post(() -> {
            main.removeCallbacks(qTimerTick);
            qTimerEndAt = min > 0 ? System.currentTimeMillis() + min * 60000L : 0;
            if (qPlaying && qTimerEndAt > 0) main.postDelayed(qTimerTick, 1000);
        });
    }

    /** 队列状态 JSON：{playing,paused,index,total,chapter,title,timerLeft} */
    @JavascriptInterface
    public String queueState() {
        try {
            JSONObject o = new JSONObject();
            o.put("playing", qPlaying);
            o.put("paused", qPaused);
            o.put("index", qIndex);
            o.put("total", queue.size());
            o.put("chapter", qChapter);
            o.put("title", qTitle);
            o.put("book", qBook);
            o.put("bookId", qBookId == null ? "" : qBookId);
            long left = qTimerEndAt > 0 ? Math.max(0, (qTimerEndAt - System.currentTimeMillis()) / 1000) : 0;
            o.put("timerLeft", left);
            return o.toString();
        } catch (Throwable t) {
            return "{\"playing\":false,\"paused\":false,\"index\":0,\"total\":0,\"timerLeft\":0}";
        }
    }

    private void stopPlaybackInternal() {
        try { if (edge != null) edge.stop(); } catch (Throwable ignore) { }
        try { if (baidu != null) baidu.stop(); } catch (Throwable ignore) { }
        try { sysOnceCb = null; if (tts != null) tts.stop(); } catch (Throwable ignore) { }
    }

    /** 朗读一句；id 为递增序号，用于与网页侧的播放会话校验。按当前音色路由，失败逐级降级 */
    @JavascriptInterface
    public void speak(final String text, final String id) {
        try {
            final String vid = voiceId == null ? DEFAULT_VOICE_ID : voiceId;
            final boolean hasText = text != null && !text.trim().isEmpty();
            if (vid.startsWith("baidu:") && hasText) {
                baidu.speak(text, rate, ok -> {
                    if (ok) { fire("start", id); fire("done", id); return; }
                    edgeErr = baidu.getLastError();
                    Log.w(TAG, "baidu speak failed: " + edgeErr + ", fallback to system tts");
                    main.post(() -> { publishState(); systemSpeak(text, id); });
                });
                return;
            }
            if (vid.startsWith("edge:") && hasText) {
                edge.speak(text, voiceShortName(vid), rate, ok -> {
                    if (ok) { fire("start", id); fire("done", id); return; }
                    edgeErr = edge.getLastError();
                    Log.w(TAG, "edge speak failed: " + edgeErr + ", try baidu");
                    // 首选 Edge 失败 → 百度兜底 → 系统语音
                    baidu.speak(text, rate, ok2 -> {
                        if (ok2) { fire("start", id); fire("done", id); return; }
                        edgeErr = edgeErr + " / " + baidu.getLastError();
                        Log.w(TAG, "baidu speak failed too, fallback to system tts");
                        main.post(() -> { publishState(); systemSpeak(text, id); });
                    });
                });
                return;
            }
        } catch (Throwable t) {
            Log.w(TAG, "speak: " + t);
        }
        main.post(() -> systemSpeak(text, id));
    }

    private void systemSpeak(final String text, final String id) {
        if (tts == null || !ready || text == null || text.isEmpty()) {
            fire("error", id);
            return;
        }
        try {
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            applyVoice();
            Bundle params = new Bundle();
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
            int res = tts.speak(text, TextToSpeech.QUEUE_ADD, params, id);
            if (res != TextToSpeech.SUCCESS) fire("error", id);
        } catch (Exception e) {
            fire("error", id);
        }
    }

    @JavascriptInterface
    public void stop() {
        stopQueue();
        try { if (edge != null) edge.stop(); } catch (Throwable ignore) {}
        try { if (baidu != null) baidu.stop(); } catch (Throwable ignore) {}
        if (builtinReady && builtin.isReady()) { builtin.stop(); return; }
        main.post(() -> {
            try { if (tts != null) tts.stop(); } catch (Exception e) { /* ignore */ }
        });
    }

    @JavascriptInterface
    public boolean isEdgeOn() {
        return edgeOn;
    }

    @JavascriptInterface
    public void setRate(float r) {
        rate = r;
        main.post(() -> { try { if (tts != null) tts.setSpeechRate(rate); } catch (Exception e) { /* ignore */ } });
    }

    /** 句间无缝接续开关（默认开）：关掉就退回每句重新建播放器的老行为 */
    @JavascriptInterface
    public void setSeamless(boolean on) {
        main.post(() -> {
            try { edge.setSeamless(on); } catch (Throwable ignore) { }
            try { if (baidu != null) baidu.setSeamless(on); } catch (Throwable ignore) { }
        });
    }

    @JavascriptInterface
    public boolean isSeamless() {
        return edge.isSeamless();
    }

    /** 短句合并朗读开关（默认开）：把相邻短句凑一段合成，减少换句次数。关掉即一句一合成 */
    @JavascriptInterface
    public void setJoinShort(boolean on) {
        joinShort = on;
    }

    @JavascriptInterface
    public boolean isJoinShort() {
        return joinShort;
    }

    @JavascriptInterface
    public void setPitch(float p) {
        pitch = p;
        main.post(() -> { try { if (tts != null) tts.setPitch(pitch); } catch (Exception e) { /* ignore */ } });
    }

    @JavascriptInterface
    public void setVoice(String name) {
        voiceName = name;
        main.post(this::applyVoice);
    }

    @JavascriptInterface
    public boolean isSpeaking() {
        try { return tts != null && tts.isSpeaking(); } catch (Exception e) { return false; }
    }

    @JavascriptInterface
    public boolean isReady() {
        return ready;
    }

    /** 当前引擎包名 */
    @JavascriptInterface
    public String getEngine() {
        return engineName;
    }

    /** 是否检测到可用的中文语音 */
    @JavascriptInterface
    public boolean isChineseAvailable() {
        return zhAvailable;
    }

    /** 返回可选音色 JSON：[{name, locale}]，中文排在前面；为空时给一个「系统默认音色」占位 */
    @JavascriptInterface
    public String getVoices() {
        try {
            if (builtinReady && builtin.isReady()) {
                JSONArray arr = new JSONArray();
                JSONObject o = new JSONObject();
                o.put("name", BUILTIN_NAME);
                o.put("locale", "zh-CN");
                arr.put(o);
                return arr.toString();
            }
            JSONArray arr = new JSONArray();
            if (tts != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                Set<Voice> set = tts.getVoices();
                if (set != null && !set.isEmpty()) {
                    List<Voice> list = new ArrayList<>(set);
                    Collections.sort(list, new Comparator<Voice>() {
                        @Override public int compare(Voice a, Voice b) {
                            return score(a) - score(b);
                        }
                        private int score(Voice v) {
                            String l = v.getLocale().getLanguage();
                            if ("zh".equals(l)) return 0;
                            if ("yue".equals(l)) return 1;
                            return 9;
                        }
                    });
                    for (Voice v : list) {
                        JSONObject o = new JSONObject();
                        o.put("name", v.getName());
                        o.put("locale", v.getLocale().toString());
                        arr.put(o);
                    }
                }
            }
            if (arr.length() == 0) {
                JSONObject def = new JSONObject();
                def.put("name", "系统默认音色");
                def.put("locale", "default");
                arr.put(def);
            }
            return arr.toString();
        } catch (Exception e) {
            return "[{\"name\":\"系统默认音色\",\"locale\":\"default\"}]";
        }
    }

    private void applyVoice() {
        try {
            if (tts == null || voiceName == null || voiceName.isEmpty()) return;
            if ("系统默认音色".equals(voiceName) || BUILTIN_NAME.equals(voiceName)) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                Set<Voice> set = tts.getVoices();
                if (set == null) return;
                for (Voice v : set) {
                    if (voiceName.equals(v.getName())) {
                        tts.setVoice(v);
                        return;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "applyVoice: " + e.getMessage());
        }
    }

    /** 听书时保持屏幕常亮 */
    @JavascriptInterface
    public void keepScreenOn(final boolean on) {
        main.post(() -> {
            try {
                if (on) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            } catch (Exception e) { /* ignore */ }
        });
    }

    /** 已安装引擎数量（0 = 一个语音引擎都没有；内置引擎可用时视为 1） */
    @JavascriptInterface
    public int engineCount() {
        if (builtinReady) return 1;
        try {
            List<TextToSpeech.EngineInfo> l = tts != null ? tts.getEngines() : null;
            return l == null ? 0 : l.size();
        } catch (Exception e) {
            return 0;
        }
    }

    /** 跳应用商店搜索语音引擎（手机无任何 TTS 引擎时的引导） */
    @JavascriptInterface
    public void openMarket() {
        main.post(() -> {
            Intent i = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://search?q=" + Uri.encode("讯飞语记")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(i);
                return;
            } catch (Exception ignore) {}
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://app.mi.com/search?keywords=" + Uri.encode("讯飞语记")))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                Log.w(TAG, "openMarket: " + e.getMessage());
            }
        });
    }

    /** 用户在面板明确点击「开启离线语音」才允许尝试原生引擎（部分机型原生崩溃，崩后下次启动自动停用） */
    @JavascriptInterface
    public void enableBuiltin() {
        appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE)
                .edit().putBoolean("builtin_mode", true).commit();
        TtsGuard.enable(appContext);
        builtinErr = "";
        publishState();
        new Thread(() -> {
            boolean ok;
            try {
                ok = builtin.init(appContext);
            } catch (Throwable t) {
                ok = false;
                builtinErr = String.valueOf(t);
            }
            builtinReady = ok;
            if (ok) {
                engineName = "内置离线语音";
                zhAvailable = true;
                ready = true;
            } else if (builtinErr.isEmpty()) {
                builtinErr = builtin.getLastError();
            }
            publishState();
        }, "qingyue-tts-enable").start();
    }

    /** 关闭离线语音，回到系统语音（App 恢复完全稳定状态） */
    @JavascriptInterface
    public void disableBuiltin() {
        appContext.getSharedPreferences("qingyue_tts", Context.MODE_PRIVATE)
                .edit().putBoolean("builtin_mode", false).commit();
        builtinReady = false;
        builtinErr = "";
        new Thread(() -> {
            try { builtin.shutdown(); } catch (Throwable ignore) {}
        }, "qingyue-tts-disable").start();
        publishState();
    }

    /** 装好语音引擎后重新初始化检测（只重检系统引擎，不触碰原生离线引擎） */
    @JavascriptInterface
    public void reinit() {
        main.post(() -> {
            try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignore) {}
            tts = null;
            ready = false;
            zhAvailable = false;
            initEngine(null);
        });
    }

    /** 跳转系统「文字转语音」设置页（安装/切换语音引擎） */
    @JavascriptInterface
    public void openTtsSettings() {        main.post(() -> {
            Intent i;
            try {
                i = new Intent("com.android.settings.TTS_SETTINGS");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            } catch (Exception e) {
                i = null;
            }
            try {
                if (i != null) {
                    activity.startActivity(i);
                } else {
                    activity.startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                }
            } catch (Exception e) {
                try {
                    activity.startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignore) {}
            }
        });
    }

    public void shutdown() {
        try { qPlaying = false; qPaused = false; qToken++; main.removeCallbacks(qTimerTick); } catch (Throwable ignore) {}
        try { PlaybackService.stop(appContext); } catch (Throwable ignore) {}
        try { if (edge != null) edge.shutdown(); } catch (Throwable ignore) {}
        try { if (baidu != null) baidu.shutdown(); } catch (Throwable ignore) {}
        try { builtin.shutdown(); } catch (Exception ignore) {}
        try {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
                tts = null;
            }
        } catch (Exception e) { /* ignore */ }
        ready = false;
    }
}
