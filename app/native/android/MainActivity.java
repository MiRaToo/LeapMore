package com.leapmore.app;

import android.os.Bundle;
import android.content.ComponentName;
import android.content.Intent;
import android.service.quicksettings.TileService;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private Intent tileSettings(Intent intent) {
        if (!TileService.ACTION_QS_TILE_PREFERENCES.equals(intent.getAction())) return intent;
        ComponentName service = intent.getParcelableExtra(Intent.EXTRA_COMPONENT_NAME);
        return VehicleTile.settings(this, service == null ? null : VehicleTile.Action.byClass(service.getClassName()));
    }

    @Override
    protected void onNewIntent(Intent intent) { super.onNewIntent(tileSettings(intent)); }

    @Override
    public void onCreate(Bundle state) {
        setIntent(tileSettings(getIntent()));
        registerPlugin(LeapVaultPlugin.class);
        registerPlugin(LeapAuthPlugin.class);
        registerPlugin(LeapWidgetPlugin.class);
        registerPlugin(LeapSettingsPlugin.class);
        registerPlugin(LeapCheckInPlugin.class);
        registerPlugin(LeapRecorderPlugin.class);
        super.onCreate(state);
        getWindow().getDecorView().post(() -> LeapWidget.publishPickerPreviews(this));
    }
}
