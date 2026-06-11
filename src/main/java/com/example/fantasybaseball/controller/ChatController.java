package com.example.fantasybaseball.controller;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Proxies chat messages to the Google Gemini API.
 * The GEMINI_API_KEY env var is read at runtime — never exposed to the client.
 *
 * POST /api/chat
 * Body: { "contents": [...], "generationConfig": {...} }   (Gemini format)
 * Returns: Gemini's raw JSON response (or an error JSON).
 */
@RestController
@RequestMapping("/api")
public class ChatController {

    // gemini-2.5-flash: available on free tier (5 RPM / 20 RPD / 250K TPM)
    // gemini-2.0-flash-lite has 0/0/0 limits on free tier — effectively blocked
    private static final String GEMINI_MODEL = "gemini-2.5-flash";
    private static final String GEMINI_URL =
            "https://generativelanguage.googleapis.com/v1beta/models/"
            + GEMINI_MODEL + ":generateContent";

    private final HttpClient http = HttpClient.newHttpClient();

    // Simple LRU response cache — avoids burning the 20 RPD free-tier limit on
    // repeated or near-identical questions during a draft. Key = SHA of request body.
    // Max 50 entries; evicts oldest on overflow.
    @SuppressWarnings("serial")
    private final Map<Integer, String> cache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<Integer, String> e) {
            return size() > 50;
        }
    };

    @PostMapping("/chat")
    public ResponseEntity<String> chat(@RequestBody String body) {
        String apiKey = System.getenv("GEMINI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body("{\"error\":\"GEMINI_API_KEY not configured on server.\"}");
        }

        // Cache hit — return saved response, saves an RPD count
        int cacheKey = body.hashCode();
        String cached;
        synchronized (cache) { cached = cache.get(cacheKey); }
        if (cached != null) {
            return ResponseEntity.ok(cached);
        }

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(GEMINI_URL + "?key=" + apiKey))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();

            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            int status = res.statusCode();

            // Log 429 body so it shows in Render logs — tells us which quota was hit
            if (status == 429) {
                System.err.println("[chat] Gemini 429: " + res.body());
            }

            // Cache successful responses
            if (status == 200) {
                synchronized (cache) { cache.put(cacheKey, res.body()); }
                return ResponseEntity.ok(res.body());
            }
            if (status == 429) {
                return ResponseEntity.status(429).body(res.body());
            }
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body("{\"error\":\"AI service unavailable (upstream " + status + ").\"}");

        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body("{\"error\":\"Failed to reach Gemini: " + e.getMessage() + "\"}");
        }
    }
}
