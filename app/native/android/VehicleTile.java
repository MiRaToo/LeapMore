package com.leapmore.app;

import android.app.AlertDialog;
import android.app.PendingIntent;
import android.text.InputFilter;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.EditText;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import org.json.JSONException;
import org.json.JSONObject;

public abstract class VehicleTile extends TileService {
    public static final class Prepare extends VehicleTile {}
    public static final class PrepareSecond extends VehicleTile {}
    public static final class ClimateOn extends VehicleTile {}
    public static final class ClimateOff extends VehicleTile {}
    public static final class Lock extends VehicleTile {}
    public static final class Find extends VehicleTile {}

    public static final class Cool extends VehicleTile {}
    public static final class Heat extends VehicleTile {}
    public static final class Vent extends VehicleTile {}
    public static final class Defrost extends VehicleTile {}
    public static final class WindowClose extends VehicleTile {}
    public static final class WindowVent extends VehicleTile {}

    enum Action {
        PREPARE("prepare", "一键备车", Prepare.class, R.drawable.leap_tile_prepare),
        PREPARE_SECOND("prepare-2", "一键备车 2", PrepareSecond.class, R.drawable.leap_tile_prepare),
        CLIMATE_ON("climate-on", "开启空调", ClimateOn.class, R.drawable.leap_widget_icon_fan),
        CLIMATE_OFF("climate-off", "关闭空调", ClimateOff.class, R.drawable.leap_widget_icon_fan),
        LOCK("lock-only", "锁车", Lock.class, R.drawable.leap_widget_icon_lock),
        COOL("climate-cool", "极速降温", Cool.class, R.drawable.leap_widget_icon_fan),
        HEAT("climate-heat", "极速升温", Heat.class, R.drawable.leap_widget_icon_fan),
        VENT("climate-vent", "快速除味", Vent.class, R.drawable.leap_widget_icon_fan),
        DEFROST("climate-def", "风挡除霜", Defrost.class, R.drawable.leap_widget_icon_fan),
        WINDOWCLOSE("window-close", "关闭车窗", WindowClose.class, R.drawable.leap_tile_window),
        WINDOWVENT("window-vent", "车窗通风", WindowVent.class, R.drawable.leap_tile_window),
        FIND("find", "鸣笛寻车", Find.class, R.drawable.leap_widget_icon_find);

        final String key, title;
        final Class<? extends VehicleTile> service;
        final int icon;
        Action(String key, String title, Class<? extends VehicleTile> service, int icon) {
            this.key = key;
            this.title = title;
            this.service = service;
            this.icon = icon;
        }
        static Action byKey(String key) {
            for (Action action : values()) if (action.key.equals(key)) return action;
            return null;
        }
        static Action byClass(String name) {
            for (Action action : values()) if (action.service.getName().equals(name)) return action;
            return null;
        }
    }

    static Intent settings(Context context, Action action) {
        Uri.Builder uri = Uri.parse("com.leapmore.app://widget/configure").buildUpon();
        if (action != null) uri.appendQueryParameter("slot", action.key);
        return launch(context, uri.build());
    }

    private static Intent launch(Context context, Uri uri) {
        return new Intent(Intent.ACTION_VIEW, uri, context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private JSONObject target(Action action) {
        try {
            return new JSONObject(LeapWidgetPlugin.storage(this).getString("tiles", "{}")).optJSONObject(action.key);
        } catch (JSONException ignored) { return null; }
    }

    private String feedback;
    private long feedbackUntil;

    @Override public void onStartListening() {
        super.onStartListening();
        render();
    }

    private void render() {
        Action action = Action.byClass(getClass().getName());
        Tile tile = getQsTile();
        if (action == null || tile == null) return;
        JSONObject target = target(action);
        String detail = target == null ? "点按绑定车辆" : target.optString("title");
        if (target != null && feedbackUntil > android.os.SystemClock.elapsedRealtime()) detail = feedback;
        tile.setLabel(action.title);
        tile.setIcon(Icon.createWithResource(this, action.icon));
        if (Build.VERSION.SDK_INT >= 29) tile.setSubtitle(detail);
        tile.setContentDescription(action.title + " · " + detail);
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override public void onClick() {
        super.onClick();
        Action action = Action.byClass(getClass().getName());
        if (action == null) return;
        Runnable open = () -> {
            JSONObject target = target(action);
            if (target != null) {
                execute(action, target, "", "");
                return;
            }
            Intent intent = settings(this, action);
            if (Build.VERSION.SDK_INT >= 34) {
                startActivityAndCollapse(PendingIntent.getActivity(this, action.ordinal(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            } else startActivityAndCollapse(intent);
        };
        if (isSecure() && isLocked()) unlockAndRun(open); else open.run();
    }

    private void execute(Action action, JSONObject target, String approval, String pin) {
        feedback = "正在处理"; feedbackUntil = android.os.SystemClock.elapsedRealtime() + 30000;
        render();
        DirectQuickControl.run(this, action, target.optString("id"), approval, pin, message -> {
            if (message.matches("(confirm|pin):[0-9a-f]{64}")) {
                feedbackUntil = 0;
                render();
                confirm(action, target, message);
                return;
            }
            feedback = message; feedbackUntil = android.os.SystemClock.elapsedRealtime() + 7500;
            render();
            android.widget.Toast.makeText(this, action.title + " · " + message, android.widget.Toast.LENGTH_SHORT).show();
            new android.os.Handler(getMainLooper()).postDelayed(this::render, 7600);
        });
    }

    private void confirm(Action action, JSONObject target, String challenge) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("确认" + action.title + "？").setMessage(target.optString("title"))
            .setNegativeButton("取消", null).setPositiveButton("发送", null);
        EditText input = challenge.startsWith("pin:") ? new EditText(this) : null;
        if (input != null) {
            input.setSingleLine(true);
            input.setHint("车辆操作密码");
            input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
            input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
            if (Build.VERSION.SDK_INT >= 26) input.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO);
            builder.setView(input);
        }
        AlertDialog dialog = builder.create();
        if (input != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> {
            String entered = input == null ? "" : input.getText().toString();
            if (input != null && !entered.matches("[0-9]{4,6}")) { input.setError("请输入 4 至 6 位操作密码"); return; }
            if (input != null) input.getText().clear();
            dialog.dismiss();
            if (isSecure() && isLocked()) return;
            execute(action, target, challenge, entered);
        }));
        showDialog(dialog);
    }

    static void refresh(Context context) {
        for (Action action : Action.values()) requestListeningState(context, new ComponentName(context, action.service));
    }
}
