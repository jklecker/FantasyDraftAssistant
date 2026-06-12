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
import java.util.*;
import java.util.stream.Collectors;

/**
 * Fetches NFL player pool from Sleeper API.
 * Cached 24 hours — the player list rarely changes mid-season.
 */
@Service
public class NflPlayerService {

    private static final Logger log = LoggerFactory.getLogger(NflPlayerService.class);
    private static final String SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";
    private static final Set<String> SKILL_POSITIONS = Set.of("QB", "RB", "WR", "TE", "K", "DEF");
    private static final long CACHE_TTL_HOURS = 24;
    private static final int  MIN_EXPECTED = 100; // fail-safe: if fewer than this, treat as error

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private List<SleeperPlayer> cache    = null;
    private Instant             cacheTime = Instant.EPOCH;

    public List<SleeperPlayer> getPlayers() {
        if (cache != null && Duration.between(cacheTime, Instant.now()).toHours() < CACHE_TTL_HOURS) {
            return cache;
        }
        try {
            log.info("Fetching NFL player pool from Sleeper...");
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(SLEEPER_URL))
                    .header("User-Agent", "FantasyDraftAssistant/1.0")
                    .timeout(Duration.ofSeconds(20))
                    .GET().build();

            String body = http.send(req, HttpResponse.BodyHandlers.ofString()).body();
            Map<String, Map<String, Object>> raw = mapper.readValue(body, new TypeReference<>() {});

            List<SleeperPlayer> parsed = raw.values().stream()
                    .map(this::parse)
                    .filter(Objects::nonNull)
                    .filter(p -> SKILL_POSITIONS.contains(p.position))
                    .filter(p -> p.team != null && !p.team.isBlank())
                    .filter(p -> p.fullName != null && !p.fullName.isBlank())
                    // Must be active OR at least have NFL experience (yearsExp >= 0 means listed)
                    .filter(p -> p.active || p.yearsExp >= 0)
                    // Exclude obvious IR/PUP non-participants (keep null = unknown)
                    .filter(p -> !"PUP".equals(p.injuryStatus))
                    .sorted(Comparator.comparing(p -> p.fullName))
                    .collect(Collectors.toList());

            if (parsed.size() < MIN_EXPECTED) {
                log.warn("Sleeper returned only {} players — suspiciously low, keeping previous cache", parsed.size());
            } else {
                cache     = parsed;
                cacheTime = Instant.now();
                log.info("Loaded {} active NFL players from Sleeper", cache.size());
            }
        } catch (Exception e) {
            log.error("Sleeper fetch failed: {}", e.getMessage());
            if (cache == null) cache = new ArrayList<>();
        }
        return cache != null ? cache : new ArrayList<>();
    }

    public void invalidateCache() {
        cache     = null;
        cacheTime = Instant.EPOCH;
    }

    @SuppressWarnings("unchecked")
    private SleeperPlayer parse(Map<String, Object> m) {
        try {
            // Determine position — prefer fantasy_positions over position
            String pos = str(m, "position");
            List<String> fps = (List<String>) m.getOrDefault("fantasy_positions", List.of());
            if (fps != null && !fps.isEmpty()) {
                String fp0 = fps.get(0);
                if (SKILL_POSITIONS.contains(fp0)) pos = fp0;
            }
            if (pos == null || !SKILL_POSITIONS.contains(pos)) return null;

            SleeperPlayer p    = new SleeperPlayer();
            p.sleeperId        = str(m, "player_id");
            p.firstName        = str(m, "first_name");
            p.lastName         = str(m, "last_name");
            // DEF entries have empty full_name — synthesize from first + last (e.g. "Houston Texans")
            String fn = str(m, "full_name");
            if (fn == null || fn.isBlank()) {
                fn = ((p.firstName != null ? p.firstName : "") + " " + (p.lastName != null ? p.lastName : "")).trim();
            }
            p.fullName         = fn.isBlank() ? null : fn;
            p.team             = str(m, "team");
            p.position         = pos;
            p.age              = intVal(m, "age");
            p.yearsExp         = intVal(m, "years_exp");  // null → -1
            p.injuryStatus     = str(m, "injury_status");
            p.active           = Boolean.TRUE.equals(m.get("active"));
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    private String str(Map<String, Object> m, String k) {
        Object v = m.get(k);
        return v instanceof String s ? s.trim() : (v != null ? v.toString().trim() : null);
    }

    private int intVal(Map<String, Object> m, String k) {
        Object v = m.get(k);
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) try { return Integer.parseInt(s); } catch (Exception e) { /* fall */ }
        return -1;
    }

    public static class SleeperPlayer {
        public String  sleeperId;
        public String  fullName;
        public String  firstName;
        public String  lastName;
        public String  team;
        public String  position;
        public int     age;
        public int     yearsExp;
        public String  injuryStatus;
        public boolean active;
    }
}
