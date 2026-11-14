package dev.gc.agentphone.helper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Xml;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.xmlpull.v1.XmlSerializer;

/** One-shot, read-only root snapshot. No input, network, idle wait or daemon. */
public class UiSnapshotInstrumentation extends Instrumentation {
    private Bundle arguments;
    private long deadline;
    private int nodes;
    private StringWriter text;
    private String expectedPackage;
    private int expectedWindow;

    @Override public void onCreate(Bundle args) {
        arguments = args;
        super.onCreate(args);
        start();
    }

    private void bounded() {
        if (SystemClock.uptimeMillis() >= deadline)
            throw new IllegalStateException("UI snapshot traversal deadline exceeded; no partial tree returned");
        if (text != null && text.getBuffer().length() > 524288)
            throw new IllegalStateException("UI snapshot size limit; no partial tree returned");
    }

    private void attribute(XmlSerializer xml, String name, Object value) throws Exception {
        String text = value == null ? "" : value.toString();
        if (text.length() > 8192) throw new IllegalStateException("UI field too large; no partial tree returned");
        xml.attribute("", name, text);
    }

    private void visit(AccessibilityNodeInfo node, XmlSerializer xml, int depth) throws Exception {
        bounded();
        if (++nodes > 2048 || depth > 48) throw new IllegalStateException("UI tree limit exceeded; no partial tree returned");
        if (node.getWindowId() != expectedWindow || !expectedPackage.equals(String.valueOf(node.getPackageName())))
            throw new IllegalStateException("UI node outside expected active window");
        boolean password = node.isPassword();
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.startTag("", "node");
        attribute(xml, "class", node.getClassName());
        attribute(xml, "package", node.getPackageName());
        attribute(xml, "resource-id", node.getViewIdResourceName());
        attribute(xml, "password", password);
        attribute(xml, "text", password ? "[password input redacted]" : node.getText());
        attribute(xml, "content-desc", password ? "[password input redacted]" : node.getContentDescription());
        attribute(xml, "hint", password ? "[password input redacted]" : node.getHintText());
        attribute(xml, "editable", node.isEditable());
        attribute(xml, "focused", node.isFocused());
        attribute(xml, "clickable", node.isClickable());
        attribute(xml, "checkable", node.isCheckable());
        attribute(xml, "bounds", "[" + Math.max(0,bounds.left) + "," + Math.max(0,bounds.top) + "]["
            + Math.max(0,bounds.right) + "," + Math.max(0,bounds.bottom) + "]");
        int children = node.getChildCount();
        for (int i = 0; i < children; i++) {
            bounded();
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("UI child unavailable during traversal; no partial tree returned");
            try { if (child.isVisibleToUser()) visit(child, xml, depth + 1); }
            finally { child.recycle(); }
        }
        xml.endTag("", "node");
    }

    @Override public void onStart() {
        JSONObject result = new JSONObject();
        AccessibilityNodeInfo root = null;
        try {
            JSONObject request = new JSONObject(new String(Base64.decode(arguments.getString("payload", ""), Base64.DEFAULT), StandardCharsets.UTF_8));
            String expected = request.getString("expectedPackage");
            if (expected.length() > 200 || !expected.matches("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+")) throw new IllegalArgumentException("Invalid expected package");
            UiAutomation automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo service = automation.getServiceInfo();
            service.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            automation.setServiceInfo(service);
            long started = SystemClock.uptimeMillis();
            deadline = started + 3000;
            int rootAttempts = 0;
            do {
                bounded();
                rootAttempts++;
                root = automation.getRootInActiveWindow();
                if (root != null) break;
                SystemClock.sleep(50);
            } while (SystemClock.uptimeMillis() < started + 1200);
            if (root == null) throw new IllegalStateException("Active root unavailable; privacy state unknown");
            long rootReadyMs = SystemClock.uptimeMillis() - started;
            if (!expected.equals(String.valueOf(root.getPackageName()))) throw new IllegalStateException("Active root belongs to another package");
            int window = root.getWindowId();
            expectedWindow = window;
            expectedPackage = expected;
            text = new StringWriter();
            XmlSerializer xml = Xml.newSerializer();
            xml.setOutput(text);
            xml.startDocument("UTF-8", true);
            xml.startTag("", "hierarchy");
            visit(root, xml, 0);
            xml.endTag("", "hierarchy");
            xml.endDocument();
            bounded();
            AccessibilityNodeInfo after = automation.getRootInActiveWindow();
            try {
                if (after == null || after.getWindowId() != window || !expected.equals(String.valueOf(after.getPackageName())))
                    throw new IllegalStateException("Active window changed during snapshot");
            } finally { if (after != null) after.recycle(); }
            bounded();
            if (text.toString().getBytes(StandardCharsets.UTF_8).length > 1048576) throw new IllegalStateException("UI snapshot too large; no partial tree returned");
            result.put("ok", true);
            result.put("packageName", expected);
            result.put("windowId", window);
            result.put("nodes", nodes);
            result.put("rootAttempts", rootAttempts);
            result.put("rootReadyMs", rootReadyMs);
            result.put("elapsedMs", SystemClock.uptimeMillis() - started);
            result.put("xml", text.toString());
        } catch (Exception error) {
            result = new JSONObject();
            try { result.put("ok", false); result.put("error", "UI snapshot unavailable"); } catch (Exception ignored) {}
        } finally { if (root != null) root.recycle(); }
        Bundle output = new Bundle();
        output.putString("phone_result_b64", Base64.encodeToString(result.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        finish(0, output);
    }
}
