package com.qingyue.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 轻阅读书器主界面：WebView 加载 assets/www 中的网页（通过虚拟 HTTPS 域，
 * 使 IndexedDB / ES Module / 本地存储 正常工作），并桥接系统 TTS 与文件选择器。
 *
 * 文件导入有两条通道：
 *  1) AndroidFile.pickFiles() —— 原生 SAF 选择器（主通道，稳定可靠）
 *  2) WebChromeClient.onShowFileChooser —— <input type="file"> 兜底
 */
public class MainActivity extends ComponentActivity {

    private static final String APP_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String LOCAL_PATH = "/__local__/";
    private static final String TAG = "MainActivity";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private NativeTTS nativeTTS;
    private long lastBackPress = 0;
    private boolean crashShown = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /* ---------------- 原生文件选择器（主通道） ---------------- */

    private final ActivityResultLauncher<Intent> nativePickLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                List<Uri> picked = new ArrayList<>();
                Intent data = result.getData();
                if (result.getResultCode() == Activity.RESULT_OK && data != null) {
                    ClipData clip = data.getClipData();
                    if (clip != null) {
                        for (int i = 0; i < clip.getItemCount(); i++) {
                            Uri u = clip.getItemAt(i).getUri();
                            if (u != null) picked.add(u);
                        }
                    } else if (data.getData() != null) {
                        picked.add(data.getData());
                    }
                }
                if (picked.isEmpty()) {
                    Log.i(TAG, "pick cancelled");
                    return;
                }
                deliverPickedFiles(picked);
            });

    /** 把选中结果（uri / 显示名 / mime / 本地副本）以 Base64(JSON) 形式回调给 JS */
    private void deliverPickedFiles(final List<Uri> uris) {
        // 复制可能涉及几十 MB，放到后台线程，避免阻塞 UI / ANR
        new Thread(() -> {
            try {
                final int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
                File dir = new File(getCacheDir(), "import");
                try {
                    if (dir.exists()) {
                        File[] olds = dir.listFiles();
                        if (olds != null) for (File o : olds) o.delete();
                    }
                    dir.mkdirs();
                } catch (Exception ignore) { }

                JSONArray arr = new JSONArray();
                int idx = 0;
                for (Uri u : uris) {
                    idx++;
                    try {
                        getContentResolver().takePersistableUriPermission(u, flags);
                    } catch (Exception ignore) { /* 部分 provider 不支持持久化授权 */ }

                    JSONObject o = new JSONObject();
                    o.put("uri", u.toString());
                    String name = queryDisplayName(u);
                    o.put("name", name);
                    o.put("mime", safeType(u));

                    // 立即把内容复制到应用缓存：避免 content:// 授权随 Activity 失效、
                    // 也避免在 WebView 请求线程里依赖 provider（这两点都会引发原生异常/闪退）
                    String ext = extOf(name);
                    String token = "b" + idx + "_" + System.currentTimeMillis() + ext;
                    File dst = new File(dir, token);
                    long copied = copyTo(u, dst);
                    if (copied >= 0) {
                        o.put("f", token);
                        o.put("size", copied);
                    } else {
                        Log.w(TAG, "copy failed: " + u);
                        o.put("size", 0);
                    }
                    arr.put(o);
                }

                final String b64 = Base64.encodeToString(arr.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                mainHandler.post(() -> {
                    try {
                        if (webView != null) {
                            webView.evaluateJavascript(
                                    "window.__onFilesPickedB64&&window.__onFilesPickedB64('" + b64 + "')", null);
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "deliver eval: " + e.getMessage());
                    }
                });
            } catch (Throwable e) {
                Log.w(TAG, "deliver: " + e);
                CrashLogger.log(this, "deliverPickedFiles", e);
                toast("读取所选文件失败：" + e.getClass().getSimpleName());
            }
        }, "qingyue-import").start();
    }

    private String extOf(String name) {
        int i = name == null ? -1 : name.lastIndexOf('.');
        if (i < 0 || name.length() - i > 8) return ".bin";
        String e = name.substring(i).toLowerCase(Locale.US);
        return e.matches("\\.[a-z0-9]{1,7}") ? e : ".bin";
    }

    /** 流式复制到应用缓存，返回字节数；失败返回 -1 */
    private long copyTo(Uri uri, File dst) {
        InputStream in = null;
        java.io.OutputStream out = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) return -1;
            out = new java.io.BufferedOutputStream(new java.io.FileOutputStream(dst), 64 * 1024);
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                total += n;
                if (total > 200L * 1024 * 1024) break;   // 单文件上限 200MB，防异常大文件拖死
            }
            out.flush();
            return total;
        } catch (Throwable e) {
            Log.w(TAG, "copyTo: " + e);
            CrashLogger.log(this, "copyTo " + uri, e);
            try { if (dst.exists()) dst.delete(); } catch (Exception ignore) { }
            return -1;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignore) { }
            try { if (out != null) out.close(); } catch (Exception ignore) { }
        }
    }

    private String queryDisplayName(Uri uri) {
        ContentResolver cr = getContentResolver();
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) {
                    String n = c.getString(i);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignore) { /* fallthrough */ }
        String last = uri.getLastPathSegment();
        return last == null ? "book.txt" : last;
    }

    private String safeType(Uri uri) {
        try {
            String t = getContentResolver().getType(uri);
            return t == null ? "" : t;
        } catch (Exception e) {
            return "";
        }
    }

    /** 按扩展名推断 MIME（缓存副本没有 provider 信息） */
    private String mimeOf(String token) {
        String t = token.toLowerCase(Locale.US);
        if (t.endsWith(".epub")) return "application/epub+zip";
        if (t.endsWith(".txt") || t.endsWith(".text")) return "text/plain";
        if (t.endsWith(".zip")) return "application/zip";
        return "application/octet-stream";
    }

    /** 打开系统文件选择器：优先 ACTION_OPEN_DOCUMENT（可多选 + 持久授权），失败降级 ACTION_GET_CONTENT */
    void startPick() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            nativePickLauncher.launch(Intent.createChooser(intent, "选择小说文件（TXT / EPUB）"));
        } catch (ActivityNotFoundException e) {
            Intent alt = new Intent(Intent.ACTION_GET_CONTENT);
            alt.addCategory(Intent.CATEGORY_OPENABLE);
            alt.setType("*/*");
            alt.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            alt.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                nativePickLauncher.launch(Intent.createChooser(alt, "选择小说文件（TXT / EPUB）"));
            } catch (ActivityNotFoundException e2) {
                toast("未找到可用的文件管理器");
            }
        } catch (Exception e) {
            Log.w(TAG, "startPick: " + e.getMessage());
            toast("无法打开文件选择器：" + e.getMessage());
        }
    }

    private void toast(String msg) {
        mainHandler.post(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    /** 上次运行若发生异常/渲染崩溃，启动后弹窗展示堆栈，便于用户截图反馈 */
    private void showCrashIfAny() {
        if (crashShown) return;
        crashShown = true;
        final String log = CrashLogger.read(this);
        if (log == null || log.trim().isEmpty()) return;
        mainHandler.post(() -> {
            try {
                android.widget.TextView tv = new android.widget.TextView(this);
                int pad = (int) (16 * getResources().getDisplayMetrics().density);
                tv.setPadding(pad, pad, pad, pad);
                tv.setTextSize(11);
                tv.setTextIsSelectable(true);
                tv.setText(log);
                android.widget.ScrollView sv = new android.widget.ScrollView(this);
                sv.addView(tv);
                new android.app.AlertDialog.Builder(this)
                        .setTitle("上次运行出现异常（可截图反馈）")
                        .setView(sv)
                        .setPositiveButton("知道了", (d, w) -> CrashLogger.clear(this))
                        .setNeutralButton("复制", (d, w) -> {
                            try {
                                android.content.ClipboardManager cm =
                                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("crash", log));
                                toast("已复制到剪贴板");
                            } catch (Throwable ignore) { }
                            CrashLogger.clear(this);
                        })
                        .show();
            } catch (Throwable ignore) { }
        });
    }

    /** 暴露给网页的原生文件接口：window.AndroidFile */
    public class FileBridge {
        @JavascriptInterface
        public void pickFiles() {
            mainHandler.post(MainActivity.this::startPick);
        }

        @JavascriptInterface
        public boolean available() {
            return true;
        }

        /** 上一次崩溃记录（供页面展示，便于定位闪退原因） */
        @JavascriptInterface
        public String lastCrash() {
            return CrashLogger.read(MainActivity.this);
        }

        @JavascriptInterface
        public void clearCrash() {
            CrashLogger.clear(MainActivity.this);
        }
    }

    private final FileBridge fileBridge = new FileBridge();

    /* ---------------- <input type="file"> 兜底通道 ---------------- */

    private final ActivityResultLauncher<Intent> filePickerLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (filePathCallback == null) return;
                Uri[] uris = null;
                Intent data = result.getData();
                if (result.getResultCode() == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        uris = new Uri[n];
                        for (int i = 0; i < n; i++) {
                            uris[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        uris = new Uri[]{data.getData()};
                    }
                }
                ValueCallback<Uri[]> cb = filePathCallback;
                filePathCallback = null;
                try {
                    cb.onReceiveValue(uris);
                } catch (Exception e) {
                    Log.w(TAG, "legacy callback: " + e.getMessage());
                }
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 先装崩溃记录器，任何未捕获异常都会写进 filesDir/crash.log
        CrashLogger.install(getApplicationContext());

        // 崩溃熔断：上次进程异常退出（原生崩溃/低内存/朗读中死掉）时，
        // 自动停用内置离线语音，避免「打开就闪退、一直闪退」
        TtsGuard.check(getApplicationContext());

        getWindow().setStatusBarColor(0xFFF7F3E8);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        webView = new WebView(this);
        setContentView(webView);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccess(true);
        ws.setLoadWithOverviewMode(false);
        ws.setUseWideViewPort(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        // 页面资源是随 APK 打包的本地 assets：禁用 HTTP 缓存，避免升级后还在跑旧的 js/css
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        ws.setDefaultTextEncodingName("UTF-8");
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setUserAgentString(ws.getUserAgentString() + " QingYueReader/1.1");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // 通道：虚拟域 /__local__/?f=<缓存副本文件名> —— 导入时已把文件复制到应用缓存
                if (LOCAL_PATH.equals(url.getPath())) {
                    // 1) 首选：缓存副本（不依赖 content:// 授权，兼容性最好）
                    String token = url.getQueryParameter("f");
                    if (token != null && token.matches("[A-Za-z0-9_.\\-]{1,64}")) {
                        try {
                            File f = new File(new File(getCacheDir(), "import"), token);
                            if (f.exists() && f.length() > 0) {
                                String mime = mimeOf(token);
                                return new WebResourceResponse(mime, null, new java.io.FileInputStream(f));
                            }
                        } catch (Throwable e) {
                            Log.w(TAG, "local cache read: " + e);
                        }
                    }
                    // 2) 兜底：直接读 content:// 授权的文件
                    String u = url.getQueryParameter("u");
                    if (u != null) {
                        try {
                            Uri target = Uri.parse(u);
                            InputStream in = getContentResolver().openInputStream(target);
                            if (in != null) {
                                String mime = safeType(target);
                                if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
                                return new WebResourceResponse(mime, null, in);
                            }
                        } catch (Throwable e) {
                            Log.w(TAG, "local read: " + e);
                        }
                    }
                }
                WebResourceResponse r = assetLoader.shouldInterceptRequest(url);
                return r != null ? r : super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                return !url.startsWith("https://appassets.androidplatform.net/");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面 JS 已就绪：重推一次 TTS 引擎状态，避免早前推送丢失
                if (nativeTTS != null) nativeTTS.notifyPageReady();
                showCrashIfAny();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                // WebView 渲染进程终止，两种情况必须区分对待：
                //  didCrash=true  —— 渲染进程自身崩溃，多为一次性解析超大 TXT / 整章 DOM 过大撑爆内存
                //  didCrash=false —— 进程被系统回收（内存压力下 LMK 清理后台），ColorOS 等系统上属常态，
                //                    与 App 代码无关
                // 旧版把两者都写进 crash.log，导致用户下次启动看到「上次运行出现异常」而误以为 App 崩溃，
                // 实际数据无损、页面已自动恢复。现改为：仅真崩溃落盘，被回收只记 Info。
                final boolean crashed = detail != null && detail.didCrash();
                if (crashed) {
                    CrashLogger.logText(MainActivity.this, "renderer crashed", "didCrash=true");
                } else {
                    Log.i(TAG, "renderer reclaimed by system (not a crash), reload page silently");
                }
                try {
                    if (webView != null) {
                        android.view.ViewGroup parent = (android.view.ViewGroup) webView.getParent();
                        if (parent != null) parent.removeView(webView);
                        webView.destroy();
                        webView = null;
                    }
                } catch (Throwable ignore) { }
                recreate();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams fileChooserParams) {
                filePathCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    filePickerLauncher.launch(Intent.createChooser(intent, "选择小说文件（TXT / EPUB）"));
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "showFileChooser: " + e.getMessage());
                    filePathCallback = null;
                    try { callback.onReceiveValue(null); } catch (Exception ignored) {}
                    toast("无法打开文件选择器");
                    return false;
                }
            }
        });

        nativeTTS = new NativeTTS(this, webView);
        webView.addJavascriptInterface(nativeTTS, "AndroidTTS");
        webView.addJavascriptInterface(fileBridge, "AndroidFile");

        // 一律重新加载入口页。
        // 不用 restoreState 的原因：渲染进程被系统回收后，保存的 WebView 状态对应的进程已不存在，
        // restoreState 会返回空、页面停在白屏。书库、阅读进度、朗读位置都持久化在 IndexedDB 里，
        // 重载页面后由 JS 自动恢复到原位，效果等同「恢复现场」且稳定。
        webView.loadUrl(APP_URL);

        // 听书前台服务需要通知权限（Android 13+）：不授权也能播，但锁屏后没有常驻通知可停止
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 9);
                }
            } catch (Throwable ignore) { }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        // 有意不保存 WebView 状态：渲染进程被回收后 restoreState 拿不回页面（白屏），
        // 重建时统一走 loadUrl(APP_URL)，由 IndexedDB 恢复书库与进度。
    }

    @SuppressLint("MissingSuperCall")
    @Override
    public void onBackPressed() {
        webView.evaluateJavascript(
                "(function(){ if (window.__onBack) { return window.__onBack() === true ? '1' : '0'; } return '0'; })()",
                value -> {
                    if (value != null && value.contains("1")) return;
                    long now = System.currentTimeMillis();
                    if (now - lastBackPress < 2000) {
                        finish();
                    } else {
                        lastBackPress = now;
                        Toast.makeText(this, "再按一次退出轻阅", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 注意：不要在这里调用 webView.onPause()。
        // 它会暂停 WebView 的 JS 定时器与渲染，切后台后朗读队列（逐句推进 / 跨章续播）立刻停住。
        // 朗读本身已由原生队列 + 前台服务承担，页面保持运行只是为了让高亮与跨章逻辑继续工作。
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            try { webView.onResume(); } catch (Exception ignore) { }
            try { webView.resumeTimers(); } catch (Exception ignore) { }
        }
        // 回到前台时同步一次朗读进度（后台期间网页可能没收到回调）
        if (nativeTTS != null) nativeTTS.notifyPageReady();
    }

    @Override
    protected void onDestroy() {
        if (nativeTTS != null) nativeTTS.shutdown();
        if (webView != null) {
            webView.getSettings().setJavaScriptEnabled(false);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
