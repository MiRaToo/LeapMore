package com.leapmore.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.lang.ref.WeakReference;

public class LeapRecordingService extends Service {
    static final String CHANNEL = "leapmore-vehicle-recording";
    private static final String STOP = "com.leapmore.app.STOP_RECORDING";
    private static WeakReference<LeapRecorderPlugin> owner = new WeakReference<>(null);
    private static LeapRecordingService running;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::poll;
    private int delay = 60_000;
    private PowerManager.WakeLock wakeLock;
    private String reason = "service-destroyed";
    private String scope = "";
    private RecordingDiagnostics diagnostics;

    static boolean runningFor(String scope) { return running != null && running.scope.equals(scope); }
    static void stopping(LeapRecorderPlugin plugin, String reason) {
        if (owns(plugin) && running != null) running.reason = reason;
    }

    static void attach(LeapRecorderPlugin plugin) { owner = new WeakReference<>(plugin); }

    static boolean owns(LeapRecorderPlugin plugin) { return owner.get() == plugin; }

    static boolean isRunning() { return running != null; }

    static void setDelay(LeapRecorderPlugin plugin, int delay) {
        if (owns(plugin) && running != null) running.updateDelay(delay);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        LeapRecorderPlugin plugin = owner.get();
        if (intent == null || STOP.equals(intent.getAction()) || plugin == null) {
            reason = plugin == null ? "bridge-missing" : intent != null ? "notification" : "service-destroyed";
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            delay = boundedDelay(intent.getIntExtra("delay", 60_000));
            String next = intent.getStringExtra("scope");
            if (diagnostics == null || !scope.equals(next)) {
                if (diagnostics != null) diagnostics.stop("scope-change");
                scope = RecordingDiagnostics.valid(next) ? next : "";
                diagnostics = new RecordingDiagnostics(this, scope, delay);
            }
            reason = "service-destroyed";
            startForeground(207, notification());
            if (wakeLock == null) {
                PowerManager power = getSystemService(PowerManager.class);
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LeapMore:VehicleRecording");
                wakeLock.acquire();
            }
            running = this;
            plugin.status(true, "", scope);
            schedule(250);
        } catch (RuntimeException ignored) {
            reason = "failed";
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private static int boundedDelay(int value) { return Math.max(6_000, Math.min(value, 120_000)); }

    private void updateDelay(int value) {
        int next = boundedDelay(value);
        if (delay == next) return;
        delay = next;
        schedule(delay);
    }

    private void schedule(int wait) {
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, wait);
    }

    private void poll() {
        LeapRecorderPlugin plugin = owner.get();
        if (plugin == null) { reason = "bridge-missing"; stopSelf(); return; }
        if (diagnostics != null) diagnostics.tick(delay);
        plugin.poll(scope);
        schedule(delay);
    }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 207, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 208,
            new Intent(this, LeapRecordingService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "手机行程记录", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
            builder = new Notification.Builder(this, CHANNEL);
        } else builder = new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle("LeapMore 正在后台查询车况").setContentText("使用零跑云车况记录车辆行程")
            .setContentIntent(open).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "停止后台记录", stop).build()).build();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        reason = "timeout";
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        if (diagnostics != null) diagnostics.stop(reason);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (running == this) running = null;
        LeapRecorderPlugin plugin = owner.get();
        if (plugin != null) plugin.status(false, reason, scope);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
