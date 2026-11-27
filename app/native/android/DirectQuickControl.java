package com.leapmore.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;
import javax.net.ssl.HttpsURLConnection;

/** A local JS runtime for the same signed vehicle client as the app, without an Activity. */
final class DirectQuickControl {
    private static final Set<String> vehiclesInFlight = new HashSet<>();
    private final Context context;
    private final VehicleTile.Action action;
    private final String targetId, vehicleKey, approval;
    private String enteredPin;
    private final Consumer<String> notify;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final long deadline = SystemClock.elapsedRealtime() + 30000;
    private final Runnable timeout = () -> complete("操作超时，请查看车况", "");
    private WebView runtime;
    private volatile boolean finished;

    private DirectQuickControl(Context context, VehicleTile.Action action, String targetId, String vehicleKey, String approval, String pin, Consumer<String> notify) {
        this.context = context.getApplicationContext();
        this.action = action;
        this.targetId = targetId;
        this.vehicleKey = vehicleKey;
        this.approval = approval;
        this.enteredPin = pin;
        this.notify = notify;
    }

    static void run(Context context, VehicleTile.Action action, String id, String approval, String pin, Consumer<String> notify) {
        try {
            JSONArray key = new JSONArray(id);
            String vehicle = new JSONArray().put(key.getString(0)).put(key.getString(2)).toString();
            if (!vehiclesInFlight.add(vehicle)) { notify.accept("该车正在执行操作"); return; }
            new DirectQuickControl(context, action, id, vehicle, approval, pin, notify).start();
        } catch (Exception ignored) { notify.accept("绑定的车辆无效"); }
    }

    private static String read(InputStream source) throws Exception {
        if (source == null) return "";
        try (InputStream stream = source; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = stream.read(buffer)) != -1;) {
                if (out.size() + count > 2_000_000) throw new java.io.IOException();
                out.write(buffer, 0, count);
            }
            return out.toString("UTF-8");
        }
    }

    private void start() {
        try {
            String script = read(context.getAssets().open("public/native/quick.js"));
            runtime = new WebView(context);
            runtime.getSettings().setJavaScriptEnabled(true);
            runtime.getSettings().setAllowFileAccess(false);
            runtime.getSettings().setAllowContentAccess(false);
            runtime.getSettings().setBlockNetworkLoads(true);
            runtime.addJavascriptInterface(new Host(), "QuickHost");
            runtime.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
                @Override public void onPageFinished(WebView view, String url) {
                    if (!finished) view.evaluateJavascript(script + "\n;LeapDirect.run(" + JSONObject.quote(action.key) + "," + JSONObject.quote(targetId) + "," + JSONObject.quote(approval) + ");", null);
                }
            });
            main.postDelayed(timeout, 30000);
            runtime.loadDataWithBaseURL("https://quick.invalid/", "<html></html>", "text/html", "UTF-8", null);
        } catch (Exception ignored) { complete("无法启动快捷控制", ""); }
    }

    private JSONObject current() {
        if (finished || SystemClock.elapsedRealtime() >= deadline) return null;
        try {
            JSONObject entry = new JSONObject(LeapWidgetPlugin.storage(context).getString("tiles", "{}")).optJSONObject(action.key);
            return entry != null && targetId.equals(entry.optString("id")) ? entry : null;
        } catch (Exception ignored) { return null; }
    }

    public final class Host {
        @JavascriptInterface public String enteredPin() { return current() == null ? "" : enteredPin; }
        @JavascriptInterface public String input() { JSONObject entry = current(); return entry == null ? "" : entry.toString(); }
        @JavascriptInterface public String vault(String key) {
            if (current() == null || !("leapmotor-session".equals(key) || key.matches("remote-control:(mode|pin):[0-9a-f]{64}"))) return null;
            try { return LeapVaultPlugin.stored(context, key); } catch (Exception ignored) { return null; }
        }
        @JavascriptInterface public boolean session(String previous, String next) {
            return current() != null && LeapVaultPlugin.replaceSession(context, previous, next);
        }
        @JavascriptInterface public String http(String raw) {
            HttpsURLConnection connection = null;
            try {
                if (current() == null) return "";
                JSONObject request = new JSONObject(raw);
                URL url = new URL(request.getString("url"));
                String host = url.getHost().toLowerCase(Locale.ROOT);
                if (!url.getProtocol().equals("https") || url.getUserInfo() != null || url.getPort() != -1 ||
                    !(host.endsWith(".leapmotor.com") || host.endsWith(".leapmotor.cn"))) return "";
                connection = (HttpsURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                int remaining = (int) Math.min(6000, deadline - SystemClock.elapsedRealtime());
                if (remaining <= 0) return "";
                connection.setConnectTimeout(remaining); connection.setReadTimeout(remaining);
                connection.setRequestMethod(request.getString("method"));
                JSONObject headers = request.getJSONObject("headers");
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext();) {
                    String key = it.next(); connection.setRequestProperty(key, headers.getString(key));
                }
                if (request.has("body")) {
                    connection.setDoOutput(true);
                    try (java.io.OutputStream stream = connection.getOutputStream()) {
                        stream.write(request.getString("body").getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = connection.getResponseCode();
                return new JSONObject().put("status", status)
                    .put("body", read(status >= 400 ? connection.getErrorStream() : connection.getInputStream())).toString();
            } catch (Exception ignored) { return ""; }
            finally { if (connection != null) connection.disconnect(); }
        }
        @JavascriptInterface public void finish(String message, String effect) { main.post(() -> complete(message, effect)); }
    }

    private void complete(String message, String effect) {
        if (finished) return;
        if (!effect.isEmpty() && current() != null) {
            try {
                SharedPreferences store = LeapWidgetPlugin.storage(context);
                JSONArray effects = new JSONArray(store.getString("quick-demo", "[]"));
                if (effects.length() >= 100) effects.remove(0);
                effects.put(new JSONObject(effect));
                store.edit().putString("quick-demo", effects.toString()).apply();
            } catch (Exception ignored) { message = "无法保存模拟车况"; }
        }
        finished = true;
        enteredPin = "";
        main.removeCallbacks(timeout);
        vehiclesInFlight.remove(vehicleKey);
        if (runtime != null) { runtime.removeJavascriptInterface("QuickHost"); runtime.destroy(); }
        notify.accept(message);
    }
}
