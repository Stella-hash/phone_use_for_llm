package dev.gc.agentphone.helper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Shell-launched, one-shot input helper. No network, listener, or persistent service. */
public class UnicodeInstrumentation extends Instrumentation {
    private Bundle arguments;

    private AccessibilityNodeInfo focusedInput(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isFocused() && node.isEditable()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = focusedInput(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    @Override public void onCreate(Bundle args) {
        arguments = args;
        super.onCreate(args);
        start();
    }

    @Override public void onStart() {
        JSONObject result = new JSONObject();
        try {
            String encoded = arguments.getString("payload", "");
            JSONObject request = new JSONObject(new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8));
            String text = request.getString("text");
            if (text.length() > 4096) throw new IllegalArgumentException("Text is limited to 4096 UTF-16 code units per call");
            UiAutomation automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo serviceInfo = automation.getServiceInfo();
            serviceInfo.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            automation.setServiceInfo(serviceInfo);
            AccessibilityNodeInfo node = null;
            long deadline = SystemClock.uptimeMillis() + 2500;
            do {
                // Fetching the root activates the accessibility tree in Chromium/WebView.
                AccessibilityNodeInfo root = automation.getRootInActiveWindow();
                node = focusedInput(root);
                if (node == null) node = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (node != null) break;
                SystemClock.sleep(100);
            } while (SystemClock.uptimeMillis() < deadline);
            if (node == null) throw new IllegalStateException("No input is focused. Inspect the screen and tap the intended input first.");
            if (!node.isEditable() || !node.isEnabled()) throw new IllegalStateException("The focused node is not an enabled editable input");
            if (node.isPassword()) throw new IllegalStateException("Password inputs are left to the owner");
            String pkg = String.valueOf(node.getPackageName());
            if (request.has("expectedPackage") && !request.getString("expectedPackage").equals(pkg))
                throw new IllegalStateException("Focused input belongs to another package: " + pkg);
            if (request.has("resourceId") && !request.getString("resourceId").equals(node.getViewIdResourceName()))
                throw new IllegalStateException("Focused input resource id changed; inspect again");
            if (request.optString("mode", "replace").equals("append")) text = String.valueOf(node.getText() == null ? "" : node.getText()) + text;
            Bundle actionArgs = new Bundle();
            actionArgs.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            boolean accepted = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, actionArgs);
            String observed = null;
            long verifyDeadline = SystemClock.uptimeMillis() + 2500;
            do {
                boolean refreshed = node.refresh();
                observed = refreshed && node.getText() != null ? node.getText().toString() : null;
                if (!accepted || text.equals(observed)) break;
                SystemClock.sleep(50);
            } while (SystemClock.uptimeMillis() < verifyDeadline);
            boolean verified = accepted && text.equals(observed);
            result.put("ok", verified);
            result.put("actionAccepted", accepted);
            result.put("verified", verified);
            result.put("packageName", pkg);
            result.put("resourceId", node.getViewIdResourceName());
            result.put("observedText", observed == null ? JSONObject.NULL : observed);
            if (!verified) result.put("error", "Input did not verify after ACTION_SET_TEXT. Re-inspect before retrying.");
            node.recycle();
        } catch (Exception error) {
            try { result.put("ok", false); result.put("error", error.getMessage()); } catch (Exception ignored) {}
        }
        Bundle output = new Bundle();
        output.putString("phone_result_b64", Base64.encodeToString(result.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        finish(0, output);
    }
}
