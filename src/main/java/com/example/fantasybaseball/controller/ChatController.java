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

            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            return ResponseEntity.status(res.statusCode()).body(res.body());

        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body("{\"error\":\"Failed to reach Gemini: " + e.getMessage() + "\"}");
        }
    }
}
