package dev.chili.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.net.URI;
import java.net.CookieHandler;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Local-bundle bridge. Platform TLS uses the declared system/user CA sources;
 * no custom trust manager or hostname verifier bypasses certificate validation. */
@CapacitorPlugin(name = "ChiliNative")
public class ChiliNativePlugin extends Plugin {
    private static final String KEY_ALIAS = "dev.chili.mobile.authorization.v1";
    private static final int MAX_BYTES = 1_048_576;
    private static final Set<String> HEADERS = new HashSet<>(Arrays.asList("content-type", "authorization", "x-chili-control-client"));
    private static final Set<String> NETWORK_ERRORS = new HashSet<>(Arrays.asList("ABORTED", "REDIRECT_NOT_ALLOWED", "RESPONSE_TOO_LARGE"));
    private static final CookieHandler NO_COOKIES = new CookieHandler() {
        @Override
        public Map<String, List<String>> get(URI uri, Map<String, List<String>> headers) { return Collections.emptyMap(); }
        @Override
        public void put(URI uri, Map<String, List<String>> headers) { /* Deliberately discard response cookies. */ }
    };
    private final ExecutorService network = Executors.newFixedThreadPool(8);
    private final ConcurrentHashMap<String, RequestState> requests = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // Core CapacitorCookies registers before app plugins and installs a
        // process CookieHandler even when its JS patch is disabled. This app
        // never loads remote pages and needs no cookies, so disable the handler
        // once at startup, not around individual concurrent requests.
        CookieHandler.setDefault(NO_COOKIES);
        android.webkit.CookieManager.getInstance().setAcceptCookie(false);
    }

    private synchronized SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private AtomicFile storageFile(String key) throws Exception {
        if (key == null || !key.matches("[A-Za-z0-9._-]{1,80}")) throw new Exception("INVALID_STORAGE_KEY");
        File directory = new File(getContext().getNoBackupFilesDir(), "chili-secure");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("SECURE_STORAGE_UNAVAILABLE");
        return new AtomicFile(new File(directory, key + ".bin"));
    }

    @PluginMethod
    public synchronized void get(PluginCall call) {
        try {
            String key = call.getString("key");
            AtomicFile file = storageFile(key);
            final byte[] bytes;
            // openRead repairs AtomicFile's backup after an interrupted write.
            // A base-file existence check would miss recoverable .bak content.
            try (InputStream input = file.openRead()) {
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (data.size() + count > 262_200) throw new Exception("INVALID_STORAGE_VALUE");
                    data.write(chunk, 0, count);
                }
                bytes = data.toByteArray();
            } catch (FileNotFoundException missing) {
                call.resolve(new JSObject().put("value", JSONObject.NULL)); return;
            }
            if (bytes.length < 29 || bytes[0] != 1) throw new Exception("INVALID_STORAGE_VALUE");
            byte[] iv = new byte[12];
            System.arraycopy(bytes, 1, iv, 0, 12);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = cipher.doFinal(bytes, 13, bytes.length - 13);
            call.resolve(new JSObject().put("value", decodeUtf8(plaintext)));
        } catch (Exception error) { call.reject("Could not read device storage", "SECURE_STORAGE_UNAVAILABLE"); }
    }

    @PluginMethod
    public synchronized void set(PluginCall call) {
        AtomicFile file = null;
        FileOutputStream output = null;
        try {
            String key = call.getString("key");
            file = storageFile(key);
            String value = call.getString("value");
            if (value == null) throw new Exception("INVALID_STORAGE_VALUE");
            byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
            if (plaintext.length > 262_144) throw new Exception("INVALID_STORAGE_VALUE");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new Exception("INVALID_STORAGE_VALUE");
            byte[] ciphertext = cipher.doFinal(plaintext);
            output = file.startWrite();
            output.write(1);
            output.write(iv);
            output.write(ciphertext);
            file.finishWrite(output);
            output = null;
            call.resolve();
        } catch (Exception error) {
            if (file != null && output != null) file.failWrite(output);
            call.reject("Could not save device storage", "SECURE_STORAGE_UNAVAILABLE");
        }
    }

    @PluginMethod
    public synchronized void remove(PluginCall call) {
        try {
            AtomicFile file = storageFile(call.getString("key"));
            file.delete();
            if (file.getBaseFile().exists()) throw new Exception("SECURE_STORAGE_UNAVAILABLE");
            call.resolve();
        } catch (Exception error) { call.reject("Could not remove device storage", "SECURE_STORAGE_UNAVAILABLE"); }
    }

    @PluginMethod
    public void postJson(PluginCall call) {
        String id = call.getString("id");
        String body = call.getString("body");
        Integer maxBytes = call.getInt("maxResponseBytes");
        JSObject headers = call.getObject("headers");
        final URI uri;
        try {
            if (id == null || !id.matches("[A-Fa-f0-9-]{36}") || body == null || headers == null ||
                maxBytes == null || maxBytes < 1 || maxBytes > MAX_BYTES || body.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES)
                throw new Exception();
            uri = new URI(call.getString("url", ""));
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                uri.getFragment() != null || !uri.getPath().startsWith("/api/")) throw new Exception();
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                Object raw = headers.get(name);
                if (!HEADERS.contains(name.toLowerCase(Locale.ROOT)) || !(raw instanceof String) ||
                    ((String) raw).contains("\r") || ((String) raw).contains("\n")) throw new Exception();
            }
        } catch (Exception error) { call.reject("Invalid HTTPS request", "INVALID_NATIVE_REQUEST"); return; }
        RequestState state = new RequestState();
        synchronized (requests) {
            if (requests.size() >= 16 || requests.putIfAbsent(id, state) != null) {
                call.reject("Too many HTTPS requests", "REQUEST_LIMIT_EXCEEDED"); return;
            }
        }
        network.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                if (state.cancelled.get()) throw new Exception("ABORTED");
                if (CookieHandler.getDefault() != NO_COOKIES) throw new Exception("COOKIE_POLICY_CHANGED");
                connection = (HttpsURLConnection) uri.toURL().openConnection();
                state.connection = connection;
                if (state.cancelled.get()) throw new Exception("ABORTED");
                connection.setRequestMethod("POST");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(30_000);
                connection.setReadTimeout(30_000);
                connection.setUseCaches(false);
                connection.setDoOutput(true);
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    connection.setRequestProperty(name, headers.getString(name));
                }
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(payload.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(payload); }
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) throw new Exception("REDIRECT_NOT_ALLOWED");
                if (connection.getContentLengthLong() > maxBytes) throw new Exception("RESPONSE_TOO_LARGE");
                InputStream response = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                ByteArrayOutputStream collected = new ByteArrayOutputStream();
                if (response != null) try (InputStream input = response) {
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = input.read(chunk)) != -1) {
                        if (state.cancelled.get()) throw new Exception("ABORTED");
                        if (collected.size() + count > maxBytes) throw new Exception("RESPONSE_TOO_LARGE");
                        collected.write(chunk, 0, count);
                    }
                }
                if (state.cancelled.get()) throw new Exception("ABORTED");
                call.resolve(new JSObject().put("status", status).put("body", decodeUtf8(collected.toByteArray())));
            } catch (Exception error) {
                String code = state.cancelled.get() ? "ABORTED" : error.getMessage();
                if (!NETWORK_ERRORS.contains(code == null ? "" : code))
                    code = "HTTP_REQUEST_FAILED";
                call.reject("HTTPS request failed", code);
            } finally {
                if (connection != null) connection.disconnect();
                requests.remove(id, state);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        RequestState state = id == null ? null : requests.get(id);
        if (state != null) {
            state.cancelled.set(true);
            if (state.connection != null) state.connection.disconnect();
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (RequestState state : requests.values()) {
            state.cancelled.set(true);
            if (state.connection != null) state.connection.disconnect();
        }
        network.shutdownNow();
        requests.clear();
    }

    private static String decodeUtf8(byte[] bytes) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }

    private static final class RequestState {
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile HttpsURLConnection connection;
    }
}
