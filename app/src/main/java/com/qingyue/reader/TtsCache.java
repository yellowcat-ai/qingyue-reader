package com.qingyue.reader;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * TTS 音频磁盘缓存的统一裁剪器（v1.35）。
 *
 * 缓存文件名是内容寻址的（edge_tts_c&lt;hash&gt;.mp3 / baidu_tts_c&lt;hash&gt;.mp3），
 * 播完不再删，好处是重听同一段零合成；代价是连续朗读时会不断累积。
 * 一段约 30~45KB，听一整本 500 章的书能产生上千个文件，所以必须两头都裁：
 * 启动时清一次旧的，运行期每写 32 个文件再清一次。
 */
final class TtsCache {
    /** 最多保留的文件数（约 15~25MB） */
    static final int MAX_FILES = 400;
    /** 超过这个天数的直接删 */
    static final long MAX_AGE_MS = 14L * 24 * 3600 * 1000;

    private TtsCache() { }

    static void prune(Context ctx) {
        try {
            File dir = ctx.getCacheDir();
            File[] fs = dir == null ? null : dir.listFiles();
            if (fs == null) return;
            long now = System.currentTimeMillis();
            List<File> keep = new ArrayList<>();
            for (File f : fs) {
                String n = f.getName();
                if (!n.startsWith("edge_tts_") && !n.startsWith("baidu_tts_")) continue;
                boolean cached = n.startsWith("edge_tts_c") || n.startsWith("baidu_tts_c");
                if (!cached) { f.delete(); continue; }              // 旧版按代际命名的临时文件
                if (now - f.lastModified() > MAX_AGE_MS) { f.delete(); continue; }
                keep.add(f);
            }
            if (keep.size() <= MAX_FILES) return;
            keep.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            int drop = keep.size() - MAX_FILES;
            for (int i = 0; i < drop; i++) keep.get(i).delete();
        } catch (Throwable ignore) { }
    }
}
