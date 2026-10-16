package ru.detailflow.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * DetailFlow for Android: the web app served by the center's DetailFlow server, shown in a WebView.
 * The server address is asked on first launch. Links to other sites (the Telegram/MAX bot) open in
 * their own apps; share, print, clipboard and photo capture go through Android.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "detailflow";
    private static final String KEY_SERVER = "server";
    private static final int FILE_REQUEST = 1;

    // Runs after every page load: browser features that WebView lacks over plain http.
    private static final String BRIDGE_SCRIPT = "(function(){"
            + "if (window.__detailflowAndroid) return; window.__detailflowAndroid = true;"
            + "var A = window.DetailFlowAndroid;"
            + "Object.defineProperty(navigator, 'share', { configurable: true, value: function (d) {"
            + "  d = d || {}; A.share(d.title || '', d.text || '', d.url || ''); return Promise.resolve(); } });"
            + "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {"
            + "  writeText: function (t) { A.copy(String(t)); return Promise.resolve(); } } });"
            + "window.print = function () { A.print(document.title || 'DetailFlow'); };"
            + "})();";

    private WebView webView;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private AlertDialog serverDialog;
    private long lastBackPress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Debug builds can be inspected and driven from desktop Chrome / Playwright over adb.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.background));
        root.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        drawEdgeToEdge(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DetailFlowAndroid/" + BuildConfig.VERSION_NAME);
        webView.addJavascriptInterface(new Bridge(), "DetailFlowAndroid");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());

        String server = savedServer();
        if (server == null) askServer(null);
        else webView.loadUrl(server);
    }

    /** Content goes under transparent system bars; the root is padded so nothing hides behind them or the keyboard. */
    @SuppressWarnings("deprecation")
    private void drawEdgeToEdge(View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
    }

    private String savedServer() {
        return prefs.getString(KEY_SERVER, null);
    }

    private static String normalizeServer(String value) {
        String server = value.trim();
        if (server.isEmpty()) return null;
        if (!server.startsWith("http://") && !server.startsWith("https://")) server = "http://" + server;
        while (server.endsWith("/")) server = server.substring(0, server.length() - 1);
        Uri uri = Uri.parse(server);
        return uri.getHost() == null || uri.getHost().isEmpty() ? null : server;
    }

    private boolean isServerUrl(Uri url) {
        String server = savedServer();
        if (server == null) return false;
        Uri base = Uri.parse(server);
        return url.getHost() != null && url.getHost().equalsIgnoreCase(base.getHost()) && url.getPort() == base.getPort()
                && String.valueOf(url.getScheme()).equalsIgnoreCase(base.getScheme());
    }

    private void askServer(String problem) {
        if (serverDialog != null && serverDialog.isShowing()) return;
        String current = savedServer();
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("http://192.168.1.10:4173");
        input.setText(current != null ? current : BuildConfig.DEFAULT_SERVER);
        input.setSelection(input.getText().length());
        FrameLayout box = new FrameLayout(this);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        box.setPadding(padding, padding / 2, padding, 0);
        box.addView(input);

        String message = (problem != null ? problem + "\n\n" : "")
                + "Адрес компьютера, где запущен DetailFlow. Телефон должен быть в той же сети Wi-Fi.";
        serverDialog = new AlertDialog.Builder(this)
                .setTitle("Сервер DetailFlow")
                .setMessage(message)
                .setView(box)
                .setCancelable(current != null && problem == null)
                .setPositiveButton("Подключиться", (dialog, which) -> {
                    String server = normalizeServer(input.getText().toString());
                    if (server == null) {
                        askServer("Введите адрес, например http://192.168.1.10:4173");
                        return;
                    }
                    prefs.edit().putString(KEY_SERVER, server).apply();
                    webView.clearHistory();
                    webView.loadUrl(server);
                })
                .setNegativeButton(current != null && problem != null ? "Повторить" : "Отмена", (dialog, which) -> {
                    if (current == null) finish();
                    else if (problem != null) webView.loadUrl(current);
                })
                .create();
        serverDialog.show();
    }

    private void openExternal(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Нет приложения, чтобы открыть ссылку", Toast.LENGTH_SHORT).show();
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isServerUrl(request.getUrl())) return false;
            openExternal(request.getUrl());
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (isServerUrl(Uri.parse(url))) view.evaluateJavascript(BRIDGE_SCRIPT, null);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            view.loadData("<html><body style='background:#0b1016'></body></html>", "text/html", "utf-8");
            askServer("Не удалось подключиться к " + savedServer() + " (" + error.getDescription() + ").");
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            cameraUri = null;

            Intent camera = null;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, "detailflow-" + System.currentTimeMillis() + ".jpg");
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DetailFlow");
                cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (cameraUri != null) {
                    camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                            .putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                }
            }

            // capture="environment" opens the camera straight away, as in the phone browser.
            Intent pick;
            if (camera != null && params.isCaptureEnabled()) {
                pick = camera;
            } else {
                pick = Intent.createChooser(params.createIntent(), "Фото");
                if (camera != null) pick.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
            }
            try {
                startActivityForResult(pick, FILE_REQUEST);
                return true;
            } catch (ActivityNotFoundException error) {
                discardCameraUri();
                fileCallback = null;
                return false;
            }
        }
    }

    private void discardCameraUri() {
        if (cameraUri != null) getContentResolver().delete(cameraUri, null, null);
        cameraUri = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
            else if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0)
                result = new Uri[]{data.getClipData().getItemAt(0).getUri()};
            else if (cameraUri != null) result = new Uri[]{cameraUri};
        }
        if (result == null || !result[0].equals(cameraUri)) discardCameraUri();
        cameraUri = null;
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /** Called from page JavaScript (on a background thread). */
    private class Bridge {
        @JavascriptInterface
        public String serverUrl() {
            String server = savedServer();
            return server != null ? server : "";
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> askServer(null));
        }

        @JavascriptInterface
        public void share(String title, String text, String url) {
            String body = url.isEmpty() ? text : (text.isEmpty() ? url : text + "\n" + url);
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, body);
            if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, "Поделиться")));
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                clipboard.setPrimaryClip(ClipData.newPlainText("DetailFlow", text));
                if (Build.VERSION.SDK_INT < 33) Toast.makeText(MainActivity.this, "Скопировано", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public void print(String jobName) {
            runOnUiThread(() -> {
                PrintManager printer = getSystemService(PrintManager.class);
                printer.print(jobName, webView.createPrintDocumentAdapter(jobName), new PrintAttributes.Builder().build());
            });
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPress < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackPress = now;
        Toast.makeText(this, "Нажмите «Назад» ещё раз, чтобы выйти", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        if (serverDialog != null) serverDialog.dismiss();
        webView.destroy();
        super.onDestroy();
    }
}
