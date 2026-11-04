package dev.gc.agentphone.helper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Point;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** One bounded single-pointer contact. No listener, root access or network. */
public class GestureInstrumentation extends Instrumentation {
    private Bundle arguments;
    private UiAutomation automation;
    private long downTime;
    private float lastX, lastY;
    private int acceptedMoves;
    private boolean contactMayBeDown;

    @Override public void onCreate(Bundle args) {
        arguments = args;
        super.onCreate(args);
        start();
    }

    private boolean inject(int action, float x, float y) {
        lastX = x;
        lastY = y;
        // A touchscreen source alone leaves the legacy overload's tool type UNKNOWN.
        // Consumers such as Chrome then report an empty pointerType instead of touch.
        MotionEvent.PointerProperties pointer = new MotionEvent.PointerProperties();
        pointer.id = 0;
        pointer.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coordinates = new MotionEvent.PointerCoords();
        coordinates.x = x;
        coordinates.y = y;
        coordinates.pressure = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL ? 0f : 1f;
        coordinates.size = 1f;
        MotionEvent event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 1,
            new MotionEvent.PointerProperties[]{pointer}, new MotionEvent.PointerCoords[]{coordinates},
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        try { return automation.injectInputEvent(event, true); }
        finally { event.recycle(); }
    }

    private void waitUntil(long time) {
        long remaining = time - SystemClock.uptimeMillis();
        if (remaining > 0) SystemClock.sleep(remaining);
        if (SystemClock.uptimeMillis() > time + 2000)
            throw new IllegalStateException("Gesture scheduling stalled; cancelling contact");
    }

    @Override public void onStart() {
        JSONObject result = new JSONObject();
        try {
            JSONObject request = new JSONObject(new String(Base64.decode(arguments.getString("payload", ""), Base64.DEFAULT), StandardCharsets.UTF_8));
            JSONArray points = request.getJSONArray("points");
            int count = points.length();
            int duration = request.optInt("durationMs", 1000);
            int hold = request.optInt("holdMs", 0);
            if (count < 2 || count > 64 || duration < 100 || duration > 5000 || hold < 0 || hold > 2000)
                throw new IllegalArgumentException("Expected 2-64 points, durationMs 100-5000, holdMs 0-2000");

            Point displaySize = new Point();
            WindowManager windows = (WindowManager)getContext().getSystemService(Context.WINDOW_SERVICE);
            windows.getDefaultDisplay().getRealSize(displaySize);
            float[] xs = new float[count], ys = new float[count];
            for (int i = 0; i < count; i++) {
                double x = points.getJSONObject(i).getDouble("x");
                double y = points.getJSONObject(i).getDouble("y");
                if (Double.isNaN(x) || Double.isInfinite(x) || Double.isNaN(y) || Double.isInfinite(y)
                    || x < 0 || y < 0 || x >= displaySize.x || y >= displaySize.y)
                    throw new IllegalArgumentException("Point " + i + " is outside the current display; inspect orientation and bounds");
                xs[i] = (float)x;
                ys[i] = (float)y;
            }
            automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            if (request.has("expectedPackage")) {
                AccessibilityNodeInfo root = null;
                long inspectDeadline = SystemClock.uptimeMillis() + 2500;
                do {
                    root = automation.getRootInActiveWindow();
                    if (root != null) break;
                    SystemClock.sleep(50);
                } while (SystemClock.uptimeMillis() < inspectDeadline);
                try {
                    String observedPackage = root == null ? null : String.valueOf(root.getPackageName());
                    result.put("observedPackage", observedPackage == null ? JSONObject.NULL : observedPackage);
                    if (root == null) throw new IllegalStateException("Foreground accessibility root unavailable; no touch attempted");
                    if (!request.getString("expectedPackage").equals(observedPackage))
                        throw new IllegalStateException("Foreground package did not match; no touch attempted");
                } finally { if (root != null) root.recycle(); }
            }
            result.put("displayWidth", displaySize.x);
            result.put("displayHeight", displaySize.y);
            downTime = SystemClock.uptimeMillis();
            contactMayBeDown = true;
            if (!inject(MotionEvent.ACTION_DOWN, xs[0], ys[0])) throw new IllegalStateException("DOWN injection was not accepted");
            waitUntil(downTime + hold);
            for (int segment = 0; segment < count - 1; segment++) {
                long segmentStart = Math.round((double)duration * segment / (count - 1));
                long segmentEnd = Math.round((double)duration * (segment + 1) / (count - 1));
                int steps = Math.max(1, (int)Math.ceil((segmentEnd - segmentStart) / 16.0));
                for (int step = 1; step <= steps; step++) {
                    float fraction = (float)step / steps;
                    long offset = segmentStart + Math.round((segmentEnd - segmentStart) * fraction);
                    waitUntil(downTime + hold + offset);
                    float x = xs[segment] + (xs[segment + 1] - xs[segment]) * fraction;
                    float y = ys[segment] + (ys[segment + 1] - ys[segment]) * fraction;
                    if (!inject(MotionEvent.ACTION_MOVE, x, y)) throw new IllegalStateException("MOVE injection was not accepted");
                    acceptedMoves++;
                }
            }
            if (!inject(MotionEvent.ACTION_UP, xs[count - 1], ys[count - 1])) throw new IllegalStateException("UP injection was not accepted");
            contactMayBeDown = false;
            result.put("ok", true);
            result.put("pointerReleased", true);
            result.put("terminalAction", "up");
            result.put("elapsedMs", SystemClock.uptimeMillis() - downTime);
            result.put("requestedDurationMs", duration);
            result.put("requestedHoldMs", hold);
        } catch (Exception error) {
            try { result.put("ok", false); result.put("error", error.getMessage()); } catch (Exception ignored) {}
        } finally {
            try {
                if (contactMayBeDown && automation != null) {
                    result.put("pointerReleased", false);
                    result.put("terminalAction", "cancel_attempted");
                    try {
                        boolean cancelled = inject(MotionEvent.ACTION_CANCEL, lastX, lastY);
                        result.put("cancelAccepted", cancelled);
                        result.put("terminalAction", "cancel");
                        result.put("pointerReleased", cancelled);
                    } catch (Exception error) { result.put("cancelError", error.getMessage()); }
                }
                result.put("touchAttempted", downTime != 0);
                result.put("acceptedMoves", acceptedMoves);
                result.put("evidence", "Android input injection acknowledgement only; app behavior requires observation");
            } catch (Exception ignored) {}
        }
        Bundle output = new Bundle();
        output.putString("phone_result_b64", Base64.encodeToString(result.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        finish(0, output);
    }
}
