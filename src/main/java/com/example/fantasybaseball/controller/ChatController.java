package com.example.fantasybaseball.controller;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;

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

    private static final String GEMINI_MODEL = "gemini-2.0-flash";
    private static final String GEMINI_URL =
            "https://generativelanguage.googleapis.com/v1beta/models/"
            + GEMINI_MODEL + ":generateContent";

    private final HttpClient http = HttpClient.newHttpClient();

    @PostMapping("/chat")
    public ResponseEntity<String> chat(@RequestBody String body) {
        String apiKey = System.getenv("GEMINI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body("{\"error\":\"GEMINI_API_KEY not configured on server.\"}");
        }

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(GEMINI_URL + "?key=" + apiKey))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();

            // Retry transient rate-limits (429) a couple times with backoff so a
            // brief burst doesn't bubble up to the user. 350ms → 900ms.
            HttpResponse<String> res = null;
            int status = 0;
            long[] backoffMs = { 350L, 900L };
            for (int attempt = 0; attempt <= backoffMs.length; attempt++) {
                res = http.send(req, HttpResponse.BodyHandlers.ofString());
                status = res.statusCode();
                if (status != 429 || attempt == backoffMs.length) break;
                Thread.sleep(backoffMs[attempt]);
            }

            // Pass 200 and 429 (rate-limit) through as-is. Everything else
            // (403 Zscaler block, 401 bad key, 5xx, etc.) becomes 503 so
            // the frontend knows to fall back to rule-based analysis.
            if (status == 200 || status == 429) {
                return ResponseEntity.status(status).body(res.body());
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
