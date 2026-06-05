package com.example.fantasybaseball.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Scrapes Fantasy Life overall PPR/standard/half-PPR rankings.
 * URL: https://www.fantasylife.com/fantasy-football-rankings
 *
 * Fantasy Life is a Next.js app — the initial page embed (__NEXT_DATA__) often
 * carries the full player list before JS hydration. Falls back through table,
 * embedded JSON, and data-attribute strategies.
 * Cache: 12 hours. Returns empty list on any failure.
 */
@Service
public class FantasyLifeService {

    private static final Logger log = LoggerFactory.getLogger(FantasyLifeService.class);
    private static final int CACHE_HOURS = 12;
    private static final int TIMEOUT_MS  = 25_000;

    private static final String RANKINGS_URL = "https://www.fantasylife.com/fantasy-football-rankings";

    private static final List<String> USER_AGENTS = List.of(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
    );
    private static final Random RANDOM = new Random();
    private final ObjectMapper mapper = new ObjectMapper();

    private List<FlPlayer> cache;
    private Instant        cacheTime;

    public record FlPlayer(String name, String team, String position, int rank, double adp) {}

    public List<FlPlayer> getRankings(String scoring) {
        if (cache != null && cacheTime != null &&
                Duration.between(cacheTime, Instant.now()).toHours() < CACHE_HOURS) {
            return cache;
        }
        try {
            List<FlPlayer> players = fetchAndParse();
            if (!players.isEmpty()) {
                cache     = players;
                cacheTime = Instant.now();
                log.info("FantasyLife: {} players loaded", players.size());
            }
            return players;
        } catch (Exception e) {
            log.warn("FantasyLife fetch failed: {}", e.getMessage());
            return cache != null ? cache : List.of();
        }
    }

    public void invalidateCache() {
        cache     = null;
        cacheTime = null;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    private List<FlPlayer> fetchAndParse() throws Exception {
        String ua = USER_AGENTS.get(RANDOM.nextInt(USER_AGENTS.size()));
        Document doc = Jsoup.connect(RANKINGS_URL)
                .userAgent(ua)
                .timeout(TIMEOUT_MS)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "en-US,en;q=0.9")
                .ignoreHttpErrors(true)
                .get();

        List<FlPlayer> result = tryNextData(doc);
        if (result.isEmpty()) result = tryTableParse(doc);
        if (result.isEmpty()) result = tryJsonEmbed(doc);
        if (result.isEmpty()) result = tryDataAttributes(doc);
        return result;
    }

    // ── Strategy 1: Next.js __NEXT_DATA__ embedded JSON ───────────────────────

    private List<FlPlayer> tryNextData(Document doc) {
        try {
            Element el = doc.getElementById("__NEXT_DATA__");
            if (el == null) return List.of();

            JsonNode root  = mapper.readTree(el.html());
            JsonNode props = root.path("props").path("pageProps");

            // Try common key paths Fantasy Life might use
            JsonNode players = findDeepArray(props,
                "rankings", "players", "rankedPlayers", "playerList", "data", "results");
            if (players == null || !players.isArray() || players.size() < 5) return List.of();

            List<FlPlayer> result = new ArrayList<>();
            for (JsonNode node : players) {
                String name = nodeStr(node, "name", "playerName", "full_name", "displayName");
                String team = nodeStr(node, "team", "nflTeam", "teamAbbrev", "nfl_team");
                String pos  = nodeStr(node, "pos", "position", "positionAbbrev", "slot");
                int    rank = nodeInt(node, "rank", "overallRank", "ecr", "ecrRank", "adpRank");
                double adp  = nodeDouble(node, "adp", "avgPick", "averageDraftPosition", "overallAdp");

                if (name != null && !name.isBlank() && rank > 0 && rank <= 400) {
                    result.add(new FlPlayer(
                        name.trim(),
                        team != null ? team.trim().toUpperCase() : "",
                        normalizePos(pos),
                        rank,
                        adp > 0 ? adp : rank
                    ));
                }
            }
            return result;
        } catch (Exception e) {
            log.debug("FantasyLife __NEXT_DATA__ parse failed: {}", e.getMessage());
            return List.of();
        }
    }

    // ── Strategy 2: HTML table ────────────────────────────────────────────────

    private List<FlPlayer> tryTableParse(Document doc) {
        List<FlPlayer> result = new ArrayList<>();
        for (Element table : doc.select("table")) {
            var rows = table.select("tr");
            if (rows.size() < 10) continue;

            for (Element row : rows) {
                var cells = row.select("td");
                if (cells.size() < 3) continue;
                try {
                    int rank = Integer.parseInt(cells.get(0).text().trim().replaceAll("[^0-9]", ""));
                    if (rank < 1 || rank > 400) continue;

                    String name = cells.get(1).text().trim();
                    if (name.isBlank()) continue;

                    String c2 = cells.size() > 2 ? cells.get(2).text().trim() : "";
                    String c3 = cells.size() > 3 ? cells.get(3).text().trim() : "";
                    String c4 = cells.size() > 4 ? cells.get(4).text().trim() : "";

                    String pos  = firstMatch(this::isPosition, c2, c3, c4);
                    String team = firstMatch(this::isTeamAbbrev, c2, c3, c4);

                    result.add(new FlPlayer(name, team == null ? "" : team.toUpperCase(),
                                            normalizePos(pos), rank, rank));
                } catch (NumberFormatException ignored) {}
            }
            if (result.size() > 20) return result;
            result.clear();
        }
        return result;
    }

    // ── Strategy 3: embedded JSON in script tags ──────────────────────────────

    private List<FlPlayer> tryJsonEmbed(Document doc) {
        List<FlPlayer> result = new ArrayList<>();
        Pattern rankPat = Pattern.compile("\"(?:rank|ecr|ecrRank)\"\\s*:\\s*(\\d+)");
        Pattern namePat = Pattern.compile("\"(?:name|playerName|full_name|displayName)\"\\s*:\\s*\"([^\"]+)\"");
        Pattern posPat  = Pattern.compile("\"(?:pos|position|positionAbbrev)\"\\s*:\\s*\"([^\"]+)\"");
        Pattern teamPat = Pattern.compile("\"(?:team|nflTeam|teamAbbrev)\"\\s*:\\s*\"([^\"]+)\"");

        for (Element script : doc.select("script")) {
            String src = script.html();
            if (!src.contains("rank") || src.length() < 2000) continue;
            for (String seg : src.split("\\{")) {
                seg = "{" + seg;
                try {
                    Matcher rm = rankPat.matcher(seg); if (!rm.find()) continue;
                    int rank = Integer.parseInt(rm.group(1)); if (rank < 1 || rank > 400) continue;

                    Matcher nm = namePat.matcher(seg); if (!nm.find()) continue;
                    String name = nm.group(1).trim();

                    Matcher pm = posPat.matcher(seg);
                    String pos = pm.find() ? pm.group(1) : "";

                    Matcher tm = teamPat.matcher(seg);
                    String team = tm.find() ? tm.group(1) : "";

                    if (!name.isEmpty()) {
                        result.add(new FlPlayer(name, team.toUpperCase(), normalizePos(pos), rank, rank));
                    }
                } catch (NumberFormatException ignored) {}
            }
            if (result.size() > 50) return result;
        }
        return result;
    }

    // ── Strategy 4: data-attribute elements ──────────────────────────────────

    private List<FlPlayer> tryDataAttributes(Document doc) {
        List<FlPlayer> result = new ArrayList<>();
        for (Element el : doc.select("[data-rank],[data-ecr],[data-player-rank]")) {
            try {
                String rankStr = el.hasAttr("data-rank") ? el.attr("data-rank")
                               : el.hasAttr("data-ecr")  ? el.attr("data-ecr")
                               : el.attr("data-player-rank");
                int rank = Integer.parseInt(rankStr.trim());
                if (rank < 1 || rank > 400) continue;

                Element nameEl = el.selectFirst(".name,.player-name,[data-name]");
                if (nameEl == null) continue;
                String name = nameEl.text().trim();

                Element posEl  = el.selectFirst(".pos,.position");
                Element teamEl = el.selectFirst(".team,.nfl-team");
                String pos  = posEl  != null ? posEl.text().trim()  : "";
                String team = teamEl != null ? teamEl.text().trim() : "";

                if (!name.isEmpty()) {
                    result.add(new FlPlayer(name, team.toUpperCase(), normalizePos(pos), rank, rank));
                }
            } catch (NumberFormatException ignored) {}
        }
        return result;
    }

    // ── JSON helpers ──────────────────────────────────────────────────────────

    private JsonNode findDeepArray(JsonNode node, String... keys) {
        for (String key : keys) {
            JsonNode found = node.path(key);
            if (found.isArray() && found.size() > 5) return found;
        }
        // One level deeper
        for (JsonNode child : node) {
            if (!child.isObject()) continue;
            for (String key : keys) {
                JsonNode found = child.path(key);
                if (found.isArray() && found.size() > 5) return found;
            }
        }
        return null;
    }

    private String nodeStr(JsonNode node, String... keys) {
        for (String k : keys) {
            JsonNode v = node.path(k);
            if (!v.isMissingNode() && !v.isNull()) return v.asText();
        }
        return null;
    }

    private int nodeInt(JsonNode node, String... keys) {
        for (String k : keys) {
            JsonNode v = node.path(k);
            if (!v.isMissingNode() && !v.isNull() && v.isNumber()) return v.asInt();
        }
        return 0;
    }

    private double nodeDouble(JsonNode node, String... keys) {
        for (String k : keys) {
            JsonNode v = node.path(k);
            if (!v.isMissingNode() && !v.isNull() && v.isNumber()) return v.asDouble();
        }
        return 0;
    }

    // ── Text-parse helpers ────────────────────────────────────────────────────

    @SafeVarargs
    private <T> T firstMatch(java.util.function.Predicate<T> pred, T... values) {
        for (T v : values) if (v != null && pred.test(v)) return v;
        return null;
    }

    private boolean isPosition(String s) {
        return s != null && s.matches("(?i)QB|RB|WR|TE|K|DST|D/ST|DEF|FLEX");
    }

    private boolean isTeamAbbrev(String s) {
        return s != null && s.length() >= 2 && s.length() <= 4 && s.matches("[A-Z]{2,4}");
    }

    private String normalizePos(String pos) {
        if (pos == null || pos.isBlank()) return "WR";
        return switch (pos.toUpperCase().trim()) {
            case "DEF", "D/ST", "DST", "DEF/ST" -> "DST";
            default -> pos.toUpperCase().trim();
        };
    }
}
