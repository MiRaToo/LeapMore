package com.leapmore.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.stream.Collectors;
import org.json.JSONObject;

@CapacitorPlugin(name = "LeapCheckIn")
public final class LeapCheckInPlugin extends Plugin {
    private static final String PAGE = "https://apptec.leapmotor.com/lpv/user-level/my-level.html";
    private WebView page;
    private String run, script;

    private void close() {
        if (page != null) {
            page.stopLoading();
            if (page.getParent() instanceof ViewGroup) ((ViewGroup) page.getParent()).removeView(page);
            page.destroy();
        }
        page = null;
        run = null;
        script = null;
    }

    @PluginMethod
    public void checkInOpen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            close();
            try {
                JSONObject account = new JSONObject(LeapVaultPlugin.stored(getContext(), "leapmotor-session")).getJSONObject("account");
                if (!account.getString("userId").equals(call.getString("account"))) throw new IllegalStateException();
                JSONObject identity = new JSONObject().put("LMAccID", account.getString("userId"))
                    .put("APPToken", account.getString("token")).put("APPPlatform", "android");
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    getContext().getAssets().open("public/checkin-page.js"), StandardCharsets.UTF_8))) {
                    script = reader.lines().collect(Collectors.joining("\n")) + "(" + identity + ",";
                }
                run = call.getString("run");
                WebView web = new WebView(getActivity());
                page = web;
                web.getSettings().setJavaScriptEnabled(true);
                web.getSettings().setDomStorageEnabled(true);
                web.getSettings().setAllowFileAccess(false);
                web.getSettings().setAllowContentAccess(false);
                web.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return request.isForMainFrame() && !PAGE.equals(request.getUrl().buildUpon().clearQuery().fragment(null).build().toString());
                    }
                });
                web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
                web.setFocusable(false);
                ViewGroup container = getActivity().findViewById(android.R.id.content);
                container.addView(web, 0, new ViewGroup.LayoutParams(-1, -1));
                web.loadUrl(PAGE + "?APPFullScreen=true");
                new Handler(Looper.getMainLooper()).postDelayed(() -> { if (page == web) close(); }, 60000);
                call.resolve();
            } catch (Exception failure) { close(); call.reject("无法打开官方签到页"); }
        });
    }

    @PluginMethod
    public void checkInStep(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (page == null || !run.equals(call.getString("run"))) { call.reject("签到已停止"); return; }
            String url = page.getUrl();
            if (url == null || !PAGE.equals(Uri.parse(url).buildUpon().clearQuery().fragment(null).build().toString())) {
                call.resolve(new JSObject().put("state", "waiting")); return;
            }
            page.evaluateJavascript(script + call.getBoolean("submit", false) + ")", value -> {
                String state = value == null ? "" : value.replace("\"", "");
                call.resolve(new JSObject().put("state", state.matches("ready|signed|submitted|manual") ? state : "waiting"));
            });
        });
    }

    @PluginMethod
    public void checkInClose(PluginCall call) {
        getActivity().runOnUiThread(() -> { if (run != null && run.equals(call.getString("run"))) close(); call.resolve(); });
    }

    @Override protected void handleOnDestroy() { close(); }
}
