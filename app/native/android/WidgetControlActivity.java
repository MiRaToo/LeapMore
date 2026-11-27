package com.leapmore.app;

import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import java.util.Arrays;
import java.util.List;

public class WidgetControlActivity extends BridgeActivity {
    static final String ACTION = "widgetAction";
    static final String VEHICLE = "widgetVehicle";
    private static final List<String> COMMANDS = Arrays.asList("lock", "climate", "trunk", "find");

    @Override
    public void finishAndRemoveTask() {
        super.finishAndRemoveTask();
        if (android.os.Build.VERSION.SDK_INT < 34) overridePendingTransition(0, 0);
    }

    @Override
    public void setTheme(int theme) {
        // BridgeActivity applies its own theme while creating the WebView.
        super.setTheme(R.style.Leap_WidgetControl);
    }

    @Override
    public void onCreate(Bundle state) {
        String action = getIntent().getStringExtra(ACTION);
        String vehicle = getIntent().getStringExtra(VEHICLE);
        boolean valid = action != null && COMMANDS.contains(action) && vehicle != null && !vehicle.isEmpty();
        if (valid) {
            CapConfig main = CapConfig.loadDefault(this);
            config = new CapConfig.Builder(this)
                .setHostname(main.getHostname())
                .setAndroidScheme(main.getAndroidScheme())
                .setStartPath("/?widget-control=" + action + "&vehicle=" + Uri.encode(vehicle))
                .setBackgroundColor("#00000000")
                .setWebContentsDebuggingEnabled(main.isWebContentsDebuggingEnabled())
                .setResolveServiceWorkerRequests(false)
                .setLoggingEnabled(false)
                .setPluginsConfiguration(new JSObject().put("App", new JSObject().put("disableBackButtonHandler", true)))
                .create();
            registerPlugin(LeapVaultPlugin.class);
            registerPlugin(LeapWidgetPlugin.class);
        }
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0);
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0);
        } else overridePendingTransition(0, 0);
        if (!valid) { finish(); return; }
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        getWindow().getDecorView().setBackgroundColor(Color.TRANSPARENT);
        getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
    }
}
