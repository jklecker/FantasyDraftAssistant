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

    // flash-lite: 30 RPM free tier (vs 15 for flash) — plenty for draft usage
    private static final String GEMINI_MODEL = "gemini-2.0-flash-lite";
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

            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            int status = res.statusCode();

            // Log 429 body so it shows in Render logs — tells us which quota was hit
            if (status == 429) {
                System.err.println("[chat] Gemini 429: " + res.body());
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
