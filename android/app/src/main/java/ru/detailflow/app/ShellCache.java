package ru.detailflow.app;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps the files of the DetailFlow interface (index.html and the build assets) in the app's own
 * folder. Every load from the server refreshes them; when the server does not answer they are
 * served from here under the same address, so the web app also keeps its saved data (IndexedDB,
 * localStorage belong to that address) and can work offline.
 */
final class ShellCache {
    private final File root;

    ShellCache(File root) {
        this.root = root;
    }

    /** Returns null to let the WebView load normally (and fail) when nothing is saved. */
    WebResourceResponse fetch(Uri url) {
        String path = url.getPath() == null || url.getPath().isEmpty() ? "/" : url.getPath();
        File file = fileFor(path);
        if (file == null) return null;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url.toString()).openConnection();
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(15000);
            if (connection.getResponseCode() == 200) {
                byte[] body;
                try (InputStream input = connection.getInputStream()) {
                    body = readAll(input);
                }
                save(file, body);
                return response(file.getName(), body);
            }
        } catch (IOException offline) {
            // Fall through to the saved copy.
        }
        if (!file.isFile()) return null;
        try (InputStream input = new FileInputStream(file)) {
            return response(file.getName(), readAll(input));
        } catch (IOException error) {
            return null;
        }
    }

    /** SPA routes (no extension) are the app page itself; anything outside the folder is refused. */
    private File fileFor(String path) {
        String last = path.substring(path.lastIndexOf('/') + 1);
        String relative = last.contains(".") ? path.substring(1) : "index.html";
        if (relative.isEmpty() || relative.contains("..")) return null;
        return new File(root, relative);
    }

    private static void save(File file, byte[] body) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("no folder");
        File temporary = new File(file.getPath() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(body);
            output.getFD().sync();
        }
        if (!temporary.renameTo(file)) throw new IOException("rename failed");
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        for (int read; (read = input.read(buffer)) != -1; ) output.write(buffer, 0, read);
        return output.toByteArray();
    }

    private static WebResourceResponse response(String name, byte[] body) {
        String mime = name.endsWith(".html") ? "text/html"
                : name.endsWith(".js") ? "text/javascript"
                : name.endsWith(".css") ? "text/css"
                : name.endsWith(".svg") ? "image/svg+xml"
                : name.endsWith(".png") ? "image/png"
                : name.endsWith(".json") ? "application/json"
                : name.endsWith(".woff2") ? "font/woff2"
                : "application/octet-stream";
        boolean text = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("xml");
        return new WebResourceResponse(mime, text ? "utf-8" : null, new ByteArrayInputStream(body));
    }
}
