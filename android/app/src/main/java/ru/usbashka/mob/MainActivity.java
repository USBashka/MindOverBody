package ru.usbashka.mob;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;

/** Local packaged application. No private data is passed to an application server. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/assets/www/index.html";
    private static final int CHOOSE_FILE = 101;
    private static final int SAVE_BACKUP = 102;
    private static final int AUTHORIZE_DRIVE = 103;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraOutput;
    private byte[] pendingBackup;
    private String driveCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        getWindow().setStatusBarColor(Color.rgb(16, 17, 16));
        getWindow().setNavigationBarColor(Color.rgb(16, 17, 16));
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(16, 17, 16));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16, 17, 16));
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return insets;
            });
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        settings.setBuiltInZoomControls(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", path -> {
                    WebResourceResponse response = assets.handle(path);
                    if (response != null && path.endsWith(".wasm")) response.setMimeType("application/wasm");
                    if (response != null && path.endsWith(".js")) response.setMimeType("text/javascript");
                    if (response != null && path.endsWith(".html")) {
                        HashMap<String, String> headers = new HashMap<>();
                        headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; frame-src 'none'; object-src 'none'; base-uri 'self'");
                        response.setResponseHeaders(headers);
                    }
                    return response;
                }).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocal(uri)) return false;
                if (request.isForMainFrame()) openExternal(uri);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                // Photography is handled by the system camera file chooser. A
                // loaded document cannot request background camera/microphone access.
                request.deny();
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                cameraOutput = null;
                try {
                    Intent select = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    select.addCategory(Intent.CATEGORY_OPENABLE);
                    String[] types = params.getAcceptTypes();
                    String mime = types.length > 0 && !types[0].isEmpty() ? types[0] : "*/*";
                    // HTML may use .json; Android pickers require MIME types.
                    if (mime.startsWith(".")) mime = mime.equals(".json") ? "application/json" : "*/*";
                    select.setType(mime);
                    select.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    Intent camera = mime.startsWith("image/") ? makeCameraIntent() : null;
                    if (params.isCaptureEnabled() && camera != null) {
                        startActivityForResult(camera, CHOOSE_FILE);
                    } else {
                        Intent chooser = Intent.createChooser(select, "Выбрать файл");
                        if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
                        startActivityForResult(chooser, CHOOSE_FILE);
                    }
                } catch (Exception failure) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    toast("Не удалось открыть выбор файла. Проверьте доступные приложения.");
                }
                return true;
            }
        });
        webView.addJavascriptInterface(new NativeBridge(), "MOBAndroid");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        // No file:// URLs and no externally supplied initial URL are accepted.
        webView.loadUrl(START);
    }

    private boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
                && uri.getPort() == -1 && uri.getPath() != null && uri.getPath().startsWith("/assets/www/");
    }

    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException failure) { toast("Установите браузер, чтобы открыть ссылку."); }
    }

    private Intent makeCameraIntent() throws Exception {
        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (camera.resolveActivity(getPackageManager()) == null) return null;
        File folder = new File(getCacheDir(), "photos");
        if (!folder.exists() && !folder.mkdirs()) return null;
        // Do not leave photographs in the shared gallery or indefinitely retain
        // previous temporary captures. The web application stores the chosen image.
        File[] old = folder.listFiles();
        if (old != null) for (File file : old) if (System.currentTimeMillis() - file.lastModified() > 86400000L) file.delete();
        File photo = File.createTempFile("capture-", ".jpg", folder);
        cameraOutput = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
        camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutput);
        camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        camera.setClipData(android.content.ClipData.newRawUri("MOB photograph", cameraOutput));
        return camera;
    }

    private final class NativeBridge {
        @JavascriptInterface public boolean isNative() { return true; }

        @JavascriptInterface public void requestDriveToken(String webClientId, String callbackName) {
            if (callbackName == null || !callbackName.matches("[A-Za-z_$][A-Za-z0-9_$]{0,80}")) return;
            runOnUiThread(() -> authorizeDrive(callbackName));
        }

        @JavascriptInterface public void exportJSON(String filename, String json) {
            exportFile(filename, "application/json", json);
        }

        @JavascriptInterface public void exportFile(String filename, String mimeType, String json) {
            if (!"application/json".equals(mimeType) && !"text/markdown".equals(mimeType) && !"text/csv".equals(mimeType)) return;
            if (json == null || json.length() > 64 * 1024 * 1024) {
                toast("Резервная копия превышает лимит 64 МБ."); return;
            }
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > 64 * 1024 * 1024) { toast("Резервная копия превышает лимит 64 МБ."); return; }
            String safeName = filename == null ? "MOB-backup.json" : filename.replaceAll("[^A-Za-zА-Яа-яЁё0-9._-]", "_");
            if (safeName.length() > 100) safeName = safeName.substring(0, 100);
            String extension = "text/markdown".equals(mimeType) ? ".md" : "text/csv".equals(mimeType) ? ".csv" : ".json";
            if (!safeName.toLowerCase(Locale.ROOT).endsWith(extension)) safeName += extension;
            final String outputName = safeName;
            runOnUiThread(() -> {
                if (!isLocal(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) return;
                if (pendingBackup != null) { toast("Сначала завершите сохранение предыдущей копии."); return; }
                pendingBackup = bytes;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(mimeType);
                intent.putExtra(Intent.EXTRA_TITLE, outputName);
                try { startActivityForResult(intent, SAVE_BACKUP); }
                catch (ActivityNotFoundException failure) { pendingBackup = null; toast("Не найдено приложение для сохранения файла."); }
            });
        }
    }

    private void authorizeDrive(String callbackName) {
        if (!isLocal(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) return;
        if (driveCallback != null) {
            sendDriveResult(callbackName, null, "Запрос подключения Google Диска уже открыт."); return;
        }
        driveCallback = callbackName;
        AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope("https://www.googleapis.com/auth/drive.appdata")))
                .build();
        Identity.getAuthorizationClient(this).authorize(request)
                .addOnSuccessListener(result -> {
                    if (result.hasResolution()) {
                        try {
                            startIntentSenderForResult(result.getPendingIntent().getIntentSender(), AUTHORIZE_DRIVE, null, 0, 0, 0);
                        } catch (Exception failure) { finishDrive(null, "Не удалось открыть разрешение Google Диска."); }
                    } else finishDrive(result.getAccessToken(), null);
                })
                .addOnFailureListener(failure -> {
                    int status = failure instanceof ApiException ? ((ApiException) failure).getStatusCode() : -1;
                    finishDrive(null, "Google Диск недоступен (код " + status + "). Проверьте Google Play Services и Android OAuth-клиент ru.usbashka.mob с SHA-1 подписи APK. Инструкция: docs/ANDROID.md.");
                });
    }

    private void finishDrive(String token, String error) {
        String callback = driveCallback;
        driveCallback = null;
        if (callback != null) sendDriveResult(callback, token, error);
    }

    private void sendDriveResult(String callback, String token, String error) {
        try {
            JSONObject result = new JSONObject();
            if (token != null && !token.isEmpty()) {
                result.put("access_token", token);
                result.put("expires_in", 3500);
            } else {
                result.put("error", "native_authorization_failed");
                result.put("error_description", error == null ? "Google не выдал доступ к Диску." : error);
            }
            webView.evaluateJavascript("window[" + JSONObject.quote(callback) + "]?.(" + result + ");", null);
        } catch (Exception ignored) { toast("Не удалось завершить подключение Google Диска."); }
    }

    @Override protected void onActivityResult(int request, int result, Intent intent) {
        super.onActivityResult(request, result, intent);
        if (request == CHOOSE_FILE && fileCallback != null) {
            ArrayList<Uri> files = new ArrayList<>();
            if (result == RESULT_OK) {
                if (intent != null && intent.getClipData() != null) {
                    for (int i = 0; i < intent.getClipData().getItemCount(); i++) files.add(intent.getClipData().getItemAt(i).getUri());
                } else if (intent != null && intent.getData() != null) files.add(intent.getData());
                else if (cameraOutput != null) files.add(cameraOutput);
            }
            fileCallback.onReceiveValue(files.isEmpty() ? null : files.toArray(new Uri[0]));
            fileCallback = null;
            cameraOutput = null;
        } else if (request == SAVE_BACKUP) {
            byte[] bytes = pendingBackup;
            pendingBackup = null;
            if (result == RESULT_OK && bytes != null && intent != null && intent.getData() != null) {
                Uri destination = intent.getData();
                new Thread(() -> {
                    try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                        if (output == null) throw new IllegalStateException("No output stream");
                        output.write(bytes);
                        toast("Резервная копия сохранена.");
                    } catch (Exception failure) { toast("Не удалось сохранить файл. Проверьте свободное место и повторите."); }
                }, "MOB-backup").start();
            }
        } else if (request == AUTHORIZE_DRIVE) {
            if (result != RESULT_OK || intent == null) { finishDrive(null, "Подключение Google Диска отменено."); return; }
            try {
                AuthorizationResult auth = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(intent);
                finishDrive(auth.getAccessToken(), null);
            } catch (ApiException failure) { finishDrive(null, "Google не разрешил доступ к Диску (код " + failure.getStatusCode() + ")."); }
        }
    }

    private void toast(String message) { runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show()); }

    @Override public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        webView.evaluateJavascript("(function(){const d=[...document.querySelectorAll('dialog[open]')].pop();if(d){if(d.dispatchEvent(new Event('cancel',{cancelable:true})))d.close();return true;}return false;})()", handled -> {
            if (!"true".equals(handled)) {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) { webView.removeJavascriptInterface("MOBAndroid"); webView.destroy(); }
        super.onDestroy();
    }
}
