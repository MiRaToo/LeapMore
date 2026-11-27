package com.leapmore.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Build;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.RelativeSizeSpan;
import android.util.TypedValue;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;

public abstract class LeapWidget extends AppWidgetProvider {
    public static class Small extends LeapWidget { @Override protected int size() { return 2; } }
    public static class Medium extends LeapWidget { @Override protected int size() { return 4; } }
    public static class Large extends LeapWidget { @Override protected int size() { return 6; } }

    protected abstract int size();

    private static LeapWidget[] providers() { return new LeapWidget[] { new Small(), new Medium(), new Large() }; }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (LeapWidget provider : providers()) {
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, provider.getClass()));
            if (ids.length > 0) provider.onUpdate(context, manager, ids);
        }
    }

    static void publishPickerPreviews(Context context) {
        if (Build.VERSION.SDK_INT < 35) return;
        SharedPreferences storage = LeapWidgetPlugin.storage(context);
        int previewVersion = 4;
        if (storage.getInt("previewVersion", 0) == previewVersion) return;
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int category = AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN;
        try {
            JSONObject example = new JSONObject("""
                {"range":"195 km","soc":"42%","state":"已驻车","charging":"未插枪",
                "chargeStatus":"unplugged","locked":"已锁","inside":"24.0℃","odometer":"4200 km",
                "simulated":true,"canLock":true,"canControl":true}
                """);
            Card card = new Card(context, example, true);
            boolean published = true;
            for (LeapWidget provider : providers()) {
                ComponentName component = new ComponentName(context, provider.getClass());
                if (!manager.setWidgetPreview(component, category, card.render(provider.size(), false))) published = false;
            }
            if (published) storage.edit().putInt("previewVersion", previewVersion).apply();
        } catch (Exception ignored) {
            Log.w("LeapWidget", "Unable to publish widget picker previews");
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        SharedPreferences storage = LeapWidgetPlugin.storage(context);
        JSONObject snapshot;
        try { snapshot = new JSONObject(storage.getString("snapshot", "{}")); }
        catch (Exception ignored) { snapshot = new JSONObject(); }
        boolean stale = System.currentTimeMillis() - storage.getLong("at", 0) > 15 * 60_000;
        manager.updateAppWidget(ids, new Card(context, snapshot, false).render(size(), stale));
    }

    private static final class Card {
        private final Context context;
        private final JSONObject snapshot;
        private final boolean preview;
        private final boolean dark;
        private final int ink;
        private final int muted;
        private final int accent;
        private final int tile;

        Card(Context context, JSONObject snapshot, boolean preview) {
            this.context = context;
            this.snapshot = snapshot;
            this.preview = preview;
            boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            dark = "dark".equals(snapshot.optString("colorScheme", systemDark ? "dark" : "light"));
            ink = context.getColor(dark ? R.color.widget_ink_dark : R.color.widget_ink_light);
            muted = context.getColor(dark ? R.color.widget_muted_dark : R.color.widget_muted_light);
            accent = context.getColor(dark ? R.color.widget_accent_dark : R.color.widget_accent_light);
            tile = context.getColor(dark ? R.color.widget_tile_dark : R.color.widget_tile_light);
        }

        RemoteViews render(int size, boolean stale) {
            boolean small = size == 2;
            boolean large = size == 6;
            boolean canControl = !stale && snapshot.optBoolean("canControl");
            boolean unlocked = "上锁".equals(snapshot.optString("lockAction"));
            boolean trunkOpen = snapshot.optBoolean("trunkOpen");
            String fuel = snapshot.optString("fuel");
            String soc = snapshot.optString("soc", "—");
            boolean hasVehicle = snapshot.length() > 0;
            int rangeSize = small ? 24 : large ? 34 : 28;

            RemoteViews view = layout(R.layout.leap_widget);
            background(view, R.id.widget_root, dark ? R.drawable.leap_widget_bg_dark : R.drawable.leap_widget_bg);
            text(view, R.id.widget_status, !hasVehicle ? "待同步" : stale ? "缓存车况" : snapshot.optString("state"), muted);
            visible(view, R.id.widget_status, !small || stale);
            text(view, R.id.widget_range, withSmallUnit(snapshot.optString("range", "— km"), " km"), ink);
            view.setTextViewTextSize(R.id.widget_range, TypedValue.COMPLEX_UNIT_SP, rangeSize);
            text(view, R.id.widget_range_label, snapshot.optString("rangeLabel", "续航"), muted);
            text(view, R.id.widget_soc, withSmallUnit(soc, "%"), ink);
            view.setTextViewTextSize(R.id.widget_soc, TypedValue.COMPLEX_UNIT_SP, rangeSize);
            text(view, R.id.widget_soc_label, "电量", muted);
            visible(view, R.id.widget_soc_group, !large);
            visible(view, R.id.widget_brand_status, size == 4);
            visible(view, R.id.widget_brand_large, large);

            view.removeAllViews(R.id.widget_charge_side);
            view.removeAllViews(R.id.widget_charge_main);
            view.addView(size == 4 ? R.id.widget_charge_side : R.id.widget_charge_main, chargeRow(small));
            visible(view, R.id.widget_levels, large);
            visible(view, R.id.widget_metrics, large);
            view.removeAllViews(R.id.widget_levels);
            view.removeAllViews(R.id.widget_metrics);
            if (large) {
                view.addView(R.id.widget_levels, level("电量", soc, R.drawable.leap_widget_icon_battery, accent));
                if (!fuel.isEmpty()) {
                    view.addView(R.id.widget_levels, level("油量", fuel, R.drawable.leap_widget_icon_fuel, context.getColor(dark ? R.color.widget_fuel_dark : R.color.widget_fuel_light)));
                }
                String locked = snapshot.optString("locked");
                view.addView(R.id.widget_metrics, metric("车门", locked.equals("已锁") || locked.equals("未锁") ? locked : "—"));
                view.addView(R.id.widget_metrics, metric("车内温度", snapshot.optString("inside", "—℃")));
                String distance = snapshot.optString("odometer");
                if (!distance.isEmpty()) view.addView(R.id.widget_metrics, metric("总里程", distance));
            }

            if (!preview) view.setOnClickPendingIntent(R.id.widget_root, openApp(context));
            view.removeAllViews(R.id.widget_actions);
            view.addView(R.id.widget_actions, action(unlocked ? "上锁" : "解锁", "lock",
                unlocked ? R.drawable.leap_widget_icon_lock : R.drawable.leap_widget_icon_unlock, !stale && snapshot.optBoolean("canLock"), unlocked));
            view.addView(R.id.widget_actions, action("空调", "climate", R.drawable.leap_widget_icon_fan, canControl, snapshot.optBoolean("climateOn")));
            if (!small) {
                view.addView(R.id.widget_actions, action("后备箱", "trunk",
                    trunkOpen ? R.drawable.leap_widget_icon_tailgate_open : R.drawable.leap_widget_icon_tailgate,
                    !stale && snapshot.optBoolean("canTrunk", canControl), trunkOpen));
                view.addView(R.id.widget_actions, action("寻车", "find", R.drawable.leap_widget_icon_find,
                    !stale && snapshot.optBoolean("canFind", canControl), false));
            }
            return view;
        }

        private RemoteViews chargeRow(boolean small) {
            RemoteViews view = layout(R.layout.leap_widget_charge);
            String status = snapshot.optString("chargeStatus");
            boolean charging = "charging".equals(status);
            boolean highlighted = charging || "done".equals(status);
            int foreground = highlighted ? accent : "plugged".equals(status) ? ink : muted;
            int chip = highlighted ? (dark ? R.drawable.leap_widget_chip_active_dark : R.drawable.leap_widget_chip_active)
                : (dark ? R.drawable.leap_widget_chip_dark : R.drawable.leap_widget_chip);
            background(view, R.id.widget_chip, chip);
            icon(view, R.id.widget_icon, charging ? R.drawable.leap_widget_icon_bolt : R.drawable.leap_widget_icon_plug, foreground);
            text(view, R.id.widget_label, snapshot.optString("charging", "状态未知"), foreground);
            String power = snapshot.optString("power");
            visible(view, R.id.widget_detail, !small && !power.isEmpty());
            text(view, R.id.widget_detail, power, ink);
            return view;
        }

        private RemoteViews level(String label, String value, int image, int color) {
            RemoteViews view = layout(R.layout.leap_widget_level);
            icon(view, R.id.widget_icon, image, muted);
            text(view, R.id.widget_label, label, muted);
            text(view, R.id.widget_detail, value, ink);
            float fraction = 0;
            if (value.endsWith("%")) {
                try { fraction = Math.max(0, Math.min(1, Integer.parseInt(value.substring(0, value.length() - 1)) / 100f)); }
                catch (NumberFormatException ignored) { }
            }
            Bitmap bar = Bitmap.createBitmap(400, 12, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bar);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(tile);
            canvas.drawRoundRect(0, 0, 400, 12, 6, 6, paint);
            paint.setColor(color);
            canvas.drawRoundRect(0, 0, 400 * fraction, 12, 6, 6, paint);
            view.setImageViewBitmap(R.id.widget_level_bar, bar);
            return view;
        }

        private RemoteViews metric(String label, String value) {
            RemoteViews view = layout(R.layout.leap_widget_metric);
            background(view, R.id.widget_metric, dark ? R.drawable.leap_widget_action_dark : R.drawable.leap_widget_action);
            text(view, R.id.widget_label, label, muted);
            text(view, R.id.widget_detail, value, ink);
            return view;
        }

        private RemoteViews action(String label, String key, int image, boolean enabled, boolean selected) {
            RemoteViews view = layout(R.layout.leap_widget_action);
            int background = selected ? (dark ? R.drawable.leap_widget_active_dark : R.drawable.leap_widget_active)
                : (dark ? R.drawable.leap_widget_action_dark : R.drawable.leap_widget_action);
            background(view, R.id.widget_action, background);
            int color = selected ? accent : ink;
            text(view, R.id.widget_label, label, color);
            icon(view, R.id.widget_icon, image, color);
            view.setFloat(R.id.widget_action, "setAlpha", enabled ? 1f : .52f);
            String vehicle = snapshot.optString("vehicle");
            if (enabled && !preview && !vehicle.isEmpty()) view.setOnClickPendingIntent(R.id.widget_action, control(context, key, vehicle));
            return view;
        }

        private RemoteViews layout(int id) { return new RemoteViews(context.getPackageName(), id); }
    }

    private static void text(RemoteViews view, int id, CharSequence label, int color) {
        view.setTextViewText(id, label);
        view.setTextColor(id, color);
    }

    private static void icon(RemoteViews view, int id, int resource, int color) {
        view.setImageViewResource(id, resource);
        view.setInt(id, "setColorFilter", color);
    }

    private static void visible(RemoteViews view, int id, boolean show) {
        view.setViewVisibility(id, show ? View.VISIBLE : View.GONE);
    }

    private static void background(RemoteViews view, int id, int resource) {
        view.setInt(id, "setBackgroundResource", resource);
    }

    private static CharSequence withSmallUnit(String value, String unit) {
        if (!value.endsWith(unit)) return value;
        SpannableString label = new SpannableString(value);
        label.setSpan(new RelativeSizeSpan(.5f), value.length() - unit.length(), value.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return label;
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(Intent.ACTION_MAIN, null, context, MainActivity.class);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent control(Context context, String action, String vehicle) {
        Intent intent = new Intent(context, WidgetControlActivity.class);
        intent.setData(Uri.parse("leap-widget://control/" + action + "/" + Uri.encode(vehicle)));
        intent.putExtra(WidgetControlActivity.ACTION, action);
        intent.putExtra(WidgetControlActivity.VEHICLE, vehicle);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE,
            android.app.ActivityOptions.makeCustomAnimation(context, 0, 0).toBundle());
    }
}
