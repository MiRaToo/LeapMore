package com.leapmore.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LeapRecorder")
public class LeapRecorderPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Context context = getContext();
            Intent service = new Intent(context, LeapRecordingService.class);
            int delay = call.getInt("delay", 60_000);
            String scope = call.getString("scope", "");
            service.putExtra("delay", delay).putExtra("scope", scope);
            try {
                LeapRecordingService.attach(this);
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
                else context.startService(service);
                call.resolve();
            } catch (RuntimeException ignored) {
                new RecordingDiagnostics(context, scope, delay).stop("failed");
                call.reject("无法开启后台车况轮询");
            }
        });
    }

    @PluginMethod
    public void setDelay(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            LeapRecordingService.setDelay(this, call.getInt("delay", 60_000));
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            stopService("scope-change".equals(call.getString("reason")) ? "scope-change" : "user");
            call.resolve();
        });
    }

    private void stopService(String reason) {
        if (LeapRecordingService.owns(this)) {
            LeapRecordingService.stopping(this, reason);
            getContext().stopService(new Intent(getContext(), LeapRecordingService.class));
        }
    }

    @Override
    protected void handleOnDestroy() { stopService("bridge-destroyed"); }

    void poll(String scope) { notifyListeners("poll", new JSObject().put("scope", scope)); }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String scope = call.getString("scope", "");
            JSObject result = new JSObject();
            result.put("running", LeapRecordingService.runningFor(scope));
            result.put("sessions", RecordingDiagnostics.report(getContext(), scope));
            call.resolve(result);
        });
    }

    void status(boolean running, String reason, String scope) {
        notifyListeners("status", new JSObject().put("running", running).put("reason", reason).put("scope", scope));
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String vehicle = call.getString("vehicle", "");
        Context context = getContext();
        if (!context.getDatabasePath("leapmore-phone.db").exists()) { call.resolve(); return; }
        try (LeapRecordingStore db = new LeapRecordingStore(context)) {
            db.clear(vehicle);
            call.resolve();
        } catch (RuntimeException ignored) { call.reject("无法清理旧版定位采样"); }
    }
}
