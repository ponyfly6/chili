package dev.chili.mobile;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ChiliNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
