package com.example.fantasybaseball.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;

/**
 * Pulls public ESPN Fantasy Football player rankings + ADP.
 * No auth required for read-only league-defaults endpoint.
 *
 * Endpoint: https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leaguedefaults/3
 * Filter:   x-fantasy-filter header selects top N by AVERAGE_DRAFT_POSITION
 *
 * Best-effort: returns empty list on failure (composite ranking handles missing source).
 */
@Service
public class EspnAdpService {

    private static final Logger log = LoggerFactory.getLogger(EspnAdpService.class);
    private static final int CACHE_HOURS = 12;
    private static final int LIMIT = 300;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper om = new ObjectMapper();

    private final Map<String, List<EspnPlayer>> cache = new HashMap<>();
    private final Map<String, Instant>          cacheTime = new HashMap<>();

    public List<EspnPlayer> getRankings(String scoring) {
        String key = scoring.toLowerCase();
        Instant t = cacheTime.get(key);
        if (t != null && Duration.between(t, Instant.now()).toHours() < CACHE_HOURS) {
            return cache.get(key);
        }

        int season = LocalDate.now().getYear();
        String url = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
                + season + "/segments/0/leaguedefaults/3?view=kona_player_info";

        // ESPN filter: top N by AVG_DRAFT_POSITION ascending.
        String filter = "{\"players\":{\"limit\":" + LIMIT
                + ",\"sortAdp\":{\"sortAsc\":true,\"sortPriority\":1},"
                + "\"filterRanksForScoringPeriodIds\":{\"value\":[0]}}}";

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Accept", "application/json")
                    .header("User-Agent", "Mozilla/5.0 FantasyDraftAssistant")
                    .header("x-fantasy-filter", filter)
                    .header("x-fantasy-platform", "kona-PROD")
                    .header("x-fantasy-source", "kona")
                    .timeout(Duration.ofSeconds(20))
                    .GET().build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                log.warn("ESPN ADP fetch returned status {} — skipping", resp.statusCode());
                return cache.getOrDefault(key, List.of());
            }

            List<EspnPlayer> parsed = parse(resp.body());
            if (!parsed.isEmpty()) {
                cache.put(key, parsed);
                cacheTime.put(key, Instant.now());
                log.info("Loaded {} ESPN ADP rankings ({})", parsed.size(), scoring);
            }
            return parsed;
        } catch (Exception e) {
            log.warn("ESPN ADP fetch failed: {}", e.getMessage());
            return cache.getOrDefault(key, List.of());
        }
    }

    public void invalidateCache() {
        cache.clear();
        cacheTime.clear();
    }

    @SuppressWarnings("unchecked")
    private List<EspnPlayer> parse(String body) {
        List<EspnPlayer> result = new ArrayList<>();
        try {
            Map<String, Object> root = om.readValue(body, new TypeReference<>() {});
            List<Map<String, Object>> players = (List<Map<String, Object>>) root.get("players");
            if (players == null) return result;

            int rank = 0;
            for (Map<String, Object> entry : players) {
                Map<String, Object> p = (Map<String, Object>) entry.get("player");
                if (p == null) continue;

                String name = (String) p.get("fullName");
                if (name == null || name.isBlank()) continue;

                Object adpObj = entry.get("averageDraftPosition");
                double adp = (adpObj instanceof Number n) ? n.doubleValue() : (++rank);
                if (adp <= 0) adp = ++rank;

                EspnPlayer ep = new EspnPlayer();
                ep.name = name;
                ep.adp = adp;
                ep.rank = ++rank;
                result.add(ep);
            }
        } catch (Exception e) {
            log.warn("ESPN parse failed: {}", e.getMessage());
        }
        return result;
    }

    public static class EspnPlayer {
        public String name;
        public double adp;
        public int    rank;
    }
}
